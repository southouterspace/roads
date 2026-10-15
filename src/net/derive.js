import { profile, deckWidth, laneOffsets, lanesIn } from './profiles.js';
import * as G from './geometry.js';
import { surfaceAt, isWater } from './terrain.js';

export const CLEARANCE = 5;
export const PILLAR_LIFT = 4;
export const SAMPLE = 2;
const GORE_BLEND = 90;
const TAPER_NODE_BLEND = 18;

export const nodeY = node => surfaceAt(node.x, node.z) + node.lift;

export function segCurve(net, seg) {
  const a = net.nodes.get(seg.a), b = net.nodes.get(seg.b);
  return G.curve([a.x, a.z], seg.ctrl, [b.x, b.z]);
}

export function incident(net, nodeId) {
  const out = [];
  for (const seg of net.segments.values()) if (seg.a === nodeId || seg.b === nodeId) out.push(seg);
  return out;
}

// Height along a segment: terrain when both ends sit on the ground, otherwise a smoothstep between the two
// node heights that never dips below the ground.
export function heightAt(ends, s, L, x, z) {
  const ground = surfaceAt(x, z);
  if (ends.liftA === 0 && ends.liftB === 0) return ground;
  const y = ends.yA + (ends.yB - ends.yA) * G.smoothstep(L > 0 ? s / L : 0);
  return Math.max(y, ground);
}

// Untrimmed centreline samples for a curve with given end heights.
export function rawCentreline(cv, ends) {
  const samples = G.arcSamples(cv, SAMPLE);
  const L = samples[samples.length - 1].s;
  const pts = samples.map(({ t, s, p }) => {
    const y = heightAt(ends, s, L, p[0], p[1]);
    return { t, s, x: p[0], z: p[1], y, lift: y - surfaceAt(p[0], p[1]), water: isWater(p[0], p[1]) };
  });
  return { cv, pts, L };
}

const centreMemo = new WeakMap();
export function centreline(net, seg) {
  const a = net.nodes.get(seg.a), b = net.nodes.get(seg.b);
  const hit = centreMemo.get(seg);
  if (hit && hit.a === a && hit.b === b) return hit.value;
  const value = rawCentreline(segCurve(net, seg), { liftA: a.lift, liftB: b.lift, yA: nodeY(a), yB: nodeY(b) });
  value.bbox = bbox(value.pts);
  centreMemo.set(seg, { a, b, value });
  return value;
}

function bbox(pts) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
  }
  return { x0, z0, x1, z1 };
}

export function structureAt(pt) {
  if (pt.lift < 0.3) return 'grade';
  if (pt.water) return 'bridge';
  return pt.lift < PILLAR_LIFT ? 'wall' : 'viaduct';
}

const memo = new WeakMap();
function cache(net) {
  let c = memo.get(net);
  if (!c) {
    c = { arms: new Map(), cls: new Map(), layout: new Map(), paths: new Map(), lanes: null };
    memo.set(net, c);
  }
  return c;
}

// An arm is one segment end at a node, seen from the node.
function armsOf(net, nodeId) {
  const c = cache(net);
  if (c.arms.has(nodeId)) return c.arms.get(nodeId);
  const arms = incident(net, nodeId).map(seg => {
    const end = seg.a === nodeId ? 'a' : 'b';
    const cv = segCurve(net, seg), L = G.bezierLength(cv);
    const away = end === 'a' ? G.bezierTangent(cv, 0) : G.scale(G.bezierTangent(cv, 1), -1);
    const node = net.nodes.get(nodeId);
    const farT = Math.min(0.5, 40 / Math.max(L, 1));
    const far = G.bezier(cv, end === 'a' ? farT : 1 - farT);
    const p = profile(end === 'a' ? seg.profileA : seg.profileB);
    const outDir = end === 'a' ? 1 : -1;
    return {
      seg: seg.id, end, away, far: G.norm(G.sub(far, [node.x, node.z])), profile: p,
      outDir, outCount: lanesIn(p, outDir), inCount: lanesIn(p, -outDir), oneWay: p.oneWay,
      angle: Math.atan2(away[1], away[0]),
    };
  });
  arms.sort((x, y) => x.angle - y.angle);
  c.arms.set(nodeId, arms);
  return arms;
}

export const armsAt = (net, nodeId) => armsOf(net, nodeId);

export function classifyNode(net, node) {
  const c = cache(net);
  if (c.cls.has(node.id)) return c.cls.get(node.id);
  const result = classify(armsOf(net, node.id));
  c.cls.set(node.id, result);
  return result;
}

function classify(arms) {
  const n = arms.length;
  if (n <= 1) return { kind: 'end', arms };
  const allOneWay = arms.every(a => a.oneWay);
  const ins = arms.filter(a => a.inCount > 0 && a.outCount === 0);
  const outs = arms.filter(a => a.outCount > 0 && a.inCount === 0);
  if (n === 2) {
    const [x, y] = arms;
    const flowsMatch = allOneWay ? ins.length === 1 && outs.length === 1 : !x.oneWay && !y.oneWay;
    if (!flowsMatch) return { kind: 'intersection', arms };
    return { kind: x.profile.id === y.profile.id ? 'continue' : 'taper', arms };
  }
  if (n === 3 && allOneWay && ins.length === 1 && outs.length === 2) {
    const inArm = ins[0], travel = G.scale(inArm.far, -1);
    const [main, branch] = outs.slice().sort((p, q) => straightness(q, travel) - straightness(p, travel));
    return { kind: 'diverge', arms, inArm, main, branch, side: G.cross(main.far, branch.far) > 0 ? 'right' : 'left' };
  }
  if (n === 3 && allOneWay && ins.length === 2 && outs.length === 1) {
    const outArm = outs[0];
    const [main, branch] = ins.slice().sort((p, q) => straightness(q, G.scale(outArm.far, -1)) - straightness(p, G.scale(outArm.far, -1)));
    return { kind: 'merge', arms, outArm, main, branch, side: G.cross(main.far, branch.far) < 0 ? 'right' : 'left' };
  }
  return { kind: 'intersection', arms };
}

// Higher is straighter; ties go to the wider road so a ramp never becomes the mainline by accident.
const straightness = (arm, travel) => G.dot(arm.far, travel) + 0.001 * (arm.outCount + arm.inCount) + (arm.profile.kind === 'ramp' ? 0 : 0.0005);

const driverOffsets = (p, dir) => laneOffsets(p, dir).map(o => o * dir);
const armKey = (seg, end) => seg + end;

// Lane mapping across a node: which incoming lane index feeds which outgoing lane index. One switch over the
// junction kind; offsets, connectors and right of way all read from it.
function nodeLaneMap(cls, control) {
  const pairs = [];
  const link = (from, i, to, j, extra) => pairs.push({ from, i, to, j, prio: 'major', turn: 'straight', ...extra });
  switch (cls.kind) {
    case 'end': {
      const arm = cls.arms[0];
      if (arm && !arm.oneWay) link(arm, 0, arm, 0, { turn: 'uturn' });
      break;
    }
    case 'continue':
    case 'taper': {
      for (const from of cls.arms) for (const to of cls.arms) {
        if (from === to || from.inCount === 0 || to.outCount === 0) continue;
        const nIn = from.inCount, nOut = to.outCount;
        for (let i = 0; i < nIn; i++) {
          const j = Math.min(i, nOut - 1), prio = i >= nOut ? 'minor' : 'major';
          for (const k of [j - 1, j, j + 1]) if (k >= 0 && k < nOut) link(from, i, to, k, { prio: k === j ? prio : 'major' });
        }
      }
      break;
    }
    case 'diverge': {
      const { inArm, main, branch, side } = cls, n = inArm.inCount, m = main.outCount, k = branch.outCount;
      const used = new Set();
      for (let q = 0; q < k; q++) {
        const i = side === 'right' ? G.clamp(n - k + q, 0, n - 1) : G.clamp(q, 0, n - 1);
        link(inArm, i, branch, q);
        used.add(i);
      }
      for (let j = 0; j < m; j++) {
        const i = side === 'right' ? Math.min(j, n - 1) : G.clamp(n - m + j, 0, n - 1);
        link(inArm, i, main, j);
        used.add(i);
      }
      for (let i = 0; i < n; i++) if (!used.has(i)) link(inArm, i, main, side === 'right' ? m - 1 : 0, { prio: 'minor' });
      break;
    }
    case 'merge': {
      const { outArm, main, branch, side } = cls, p = main.inCount, r = branch.inCount, m = outArm.outCount;
      const room = m >= p + r;
      for (let i = 0; i < p; i++) {
        const j = side === 'right' ? Math.min(i, m - 1) : G.clamp(m - p + i, 0, m - 1);
        link(main, i, outArm, j);
      }
      for (let q = 0; q < r; q++) {
        const j = side === 'right' ? (room ? p + q : G.clamp(m - r + q, 0, m - 1)) : (room ? q : G.clamp(q, 0, m - 1));
        link(branch, q, outArm, j, { prio: room ? 'major' : 'minor' });
      }
      break;
    }
    case 'intersection': {
      const ring = control === 'roundabout';
      for (const from of cls.arms) {
        if (from.inCount === 0) continue;
        const travel = G.scale(from.away, -1);
        const exits = cls.arms.filter(to => to.outCount > 0 && (ring || to !== from));
        for (const to of exits.length ? exits : cls.arms.filter(t => t.outCount > 0)) {
          const nIn = from.inCount, nOut = to.outCount;
          if (ring) {
            for (let i = 0; i < nIn; i++) link(from, i, to, Math.min(i, nOut - 1), { turn: 'ring' });
            continue;
          }
          const a = G.signedTurn(travel, to.away);
          const turn = to === from ? 'uturn' : Math.abs(a) < Math.PI / 6 ? 'straight' : a > 0 ? 'right' : 'left';
          if (turn === 'straight') {
            for (let i = 0; i < nIn; i++) link(from, i, to, Math.min(i, nOut - 1), { turn });
            for (let j = nIn; j < nOut; j++) link(from, nIn - 1, to, j, { turn });
          } else if (turn === 'right') link(from, nIn - 1, to, nOut - 1, { turn });
          else link(from, 0, to, 0, { turn });
        }
      }
      break;
    }
  }
  return pairs;
}

const mean = xs => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);

// Per node: junction radius, the lateral shift of each branch end at a gore, and the blended width at tapers.
export function nodeLayout(net, nodeId) {
  const c = cache(net);
  if (c.layout.has(nodeId)) return c.layout.get(nodeId);
  const node = net.nodes.get(nodeId);
  const cls = classifyNode(net, node);
  const pairs = nodeLaneMap(cls, node.control);
  const offsets = new Map();
  const halfWidth = arm => deckWidth(arm.profile) / 2;
  let radius = 0, ring = null, joinWidth = null;
  switch (cls.kind) {
    case 'end':
      break;
    case 'continue':
    case 'taper': {
      const bend = Math.PI - G.angleBetween(cls.arms[0].away, cls.arms[1].away);
      if (bend > 0.1) radius = Math.min(20, Math.max(...cls.arms.map(halfWidth)) * Math.tan(bend / 2) + 1);
      if (cls.kind === 'taper') joinWidth = mean(cls.arms.map(a => deckWidth(a.profile)));
      break;
    }
    case 'diverge':
    case 'merge': {
      const ref = cls.kind === 'diverge' ? cls.inArm : cls.outArm;
      const travel = cls.kind === 'diverge' ? G.scale(ref.away, -1) : ref.away;
      const refOffsets = driverOffsets(ref.profile, cls.kind === 'diverge' ? -ref.outDir : ref.outDir);
      for (const arm of [cls.main, cls.branch]) {
        const fed = pairs.filter(p => (cls.kind === 'diverge' ? p.to === arm : p.from === arm) && p.prio === 'major');
        const off = mean(fed.map(p => refOffsets[cls.kind === 'diverge' ? p.i : p.j]));
        offsets.set(armKey(arm.seg, arm.end), G.scale(G.right(travel), off));
      }
      break;
    }
    case 'intersection': {
      const hw = cls.arms.map(halfWidth);
      radius = Math.max(...hw) + 2;
      for (let k = 0; k < cls.arms.length; k++) {
        const a = cls.arms[k], b = cls.arms[(k + 1) % cls.arms.length];
        let gap = b.angle - a.angle;
        if (k === cls.arms.length - 1) gap += Math.PI * 2;
        const need = (hw[k] + hw[(k + 1) % hw.length]) / 2 / Math.tan(Math.min(gap, Math.PI * 0.95) / 2) + 1.5;
        radius = Math.max(radius, need);
      }
      if (node.control === 'roundabout') {
        radius = Math.max(radius + 6, 18);
        ring = { r: radius - 5, island: radius - 8.5 };
      }
      radius = Math.min(radius, 45);
      break;
    }
  }
  const layout = { cls, pairs, radius, offsets, ring, joinWidth };
  c.layout.set(nodeId, layout);
  return layout;
}

// Trimmed, shifted and widened centreline that the renderer and the lane graph use.
export function segmentPath(net, seg) {
  const c = cache(net);
  if (c.paths.has(seg.id)) return c.paths.get(seg.id);
  const raw = centreline(net, seg);
  const L = raw.L;
  const la = nodeLayout(net, seg.a), lb = nodeLayout(net, seg.b);
  let trimA = la.radius, trimB = lb.radius;
  if (trimA + trimB > L - 1) {
    const k = Math.max(0, L - 1) / (trimA + trimB);
    trimA *= k; trimB *= k;
  }
  const offA = la.offsets.get(armKey(seg.id, 'a')), offB = lb.offsets.get(armKey(seg.id, 'b'));
  const pA = profile(seg.profileA), pB = profile(seg.profileB);
  const wA = deckWidth(pA), wB = deckWidth(pB);
  const blend = Math.min(L * 0.6, GORE_BLEND);

  const kept = [];
  const at = s => {
    const pts = raw.pts;
    let i = 0;
    while (i < pts.length - 2 && pts[i + 1].s < s) i++;
    const p = pts[i], q = pts[i + 1], f = (s - p.s) / ((q.s - p.s) || 1);
    return { t: p.t + (q.t - p.t) * f, s, x: p.x + (q.x - p.x) * f, z: p.z + (q.z - p.z) * f, y: p.y + (q.y - p.y) * f };
  };
  kept.push(at(trimA));
  for (const p of raw.pts) if (p.s > trimA + 0.5 && p.s < L - trimB - 0.5) kept.push({ t: p.t, s: p.s, x: p.x, z: p.z, y: p.y });
  kept.push(at(L - trimB));

  const pts = kept.map(p => {
    let x = p.x, z = p.z;
    if (offA) { const k = 1 - G.smoothstep(p.s / blend); x += offA[0] * k; z += offA[1] * k; }
    if (offB) { const k = 1 - G.smoothstep((L - p.s) / blend); x += offB[0] * k; z += offB[1] * k; }
    const u = L > 0 ? p.s / L : 0;
    let w = wA + (wB - wA) * G.smoothstep(u);
    if (la.joinWidth !== null) w += (la.joinWidth - w) * (1 - G.smoothstep(p.s / TAPER_NODE_BLEND));
    if (lb.joinWidth !== null) w += (lb.joinWidth - w) * (1 - G.smoothstep((L - p.s) / TAPER_NODE_BLEND));
    const ground = surfaceAt(x, z);
    return { x, y: p.y, z, s: p.s, u, w, lift: p.y - ground, water: isWater(x, z) };
  });
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const t = G.norm([b.x - a.x, b.z - a.z]);
    pts[i].tx = t[0];
    pts[i].tz = t[1];
  }
  const cum = G.cumulative(pts);
  const path = { seg: seg.id, pts, cum, len: cum[cum.length - 1], L, trimA, trimB };
  c.paths.set(seg.id, path);
  return path;
}

const laneId = (seg, dir, i) => `${seg}:${dir > 0 ? 'f' : 'b'}${i}`;

function segmentLanes(net, seg) {
  const path = segmentPath(net, seg);
  const pA = profile(seg.profileA), pB = profile(seg.profileB);
  const lanes = [];
  for (const dir of [1, -1]) {
    const pS = dir > 0 ? pA : pB, pE = dir > 0 ? pB : pA;
    const nS = lanesIn(pS, dir), nE = lanesIn(pE, dir), n = Math.max(nS, nE);
    if (n === 0) continue;
    const offS = driverOffsets(pS, dir), offE = driverOffsets(pE, dir);
    const order = dir > 0 ? path.pts : path.pts.slice().reverse();
    for (let i = 0; i < n; i++) {
      const startIndex = Math.min(i, nS - 1), endIndex = Math.min(i, nE - 1);
      const o0 = offS[startIndex], o1 = offE[endIndex];
      const offs = order.map(p => o0 + (o1 - o0) * G.smoothstep(dir > 0 ? p.u : 1 - p.u));
      const pts = G.offsetPolyline(order, k => offs[k]).map(p => ({ x: p.x, y: p.y, z: p.z }));
      const cum = G.cumulative(pts);
      lanes.push({
        id: laneId(seg.id, dir, i), kind: 'lane', seg: seg.id, dir, index: i, startIndex, endIndex,
        from: dir > 0 ? seg.a : seg.b, to: dir > 0 ? seg.b : seg.a,
        joins: i >= nE ? laneId(seg.id, dir, nE - 1) : null,
        splits: i >= nS ? laneId(seg.id, dir, nS - 1) : null,
        pts, offs, cum, len: cum[cum.length - 1], speed: Math.min(pA.speed, pB.speed),
      });
    }
  }
  return lanes;
}

function connectorPoints(a, ta, b, tb, ring, centre) {
  const pts = [];
  if (ring) {
    const a0 = Math.atan2(a.z - centre.z, a.x - centre.x), a1 = Math.atan2(b.z - centre.z, b.x - centre.x);
    let sweep = a0 - a1;
    while (sweep <= 0.3) sweep += Math.PI * 2;
    const r0 = Math.hypot(a.x - centre.x, a.z - centre.z), r1 = Math.hypot(b.x - centre.x, b.z - centre.z);
    const n = Math.max(8, Math.ceil(sweep * ring.r / SAMPLE));
    for (let k = 0; k <= n; k++) {
      const f = k / n, ang = a0 - sweep * f;
      const r = f < 0.2 ? r0 + (ring.r - r0) * G.smoothstep(f / 0.2) : f > 0.8 ? ring.r + (r1 - ring.r) * G.smoothstep((f - 0.8) / 0.2) : ring.r;
      pts.push({ x: centre.x + Math.cos(ang) * r, y: a.y + (b.y - a.y) * f, z: centre.z + Math.sin(ang) * r });
    }
    return pts;
  }
  const p0 = [a.x, a.z], p2 = [b.x, b.z];
  const d = G.dist(p0, p2);
  if (d < 0.05) return [{ x: a.x, y: a.y, z: a.z }, { x: b.x + ta[0] * 0.01, y: b.y, z: b.z + ta[1] * 0.01 }];
  let c = G.rayMeet(p0, ta, p2, G.scale(tb, -1));
  if (!c || G.dist(c, p0) > d * 2) c = null;
  if (!c && G.dot(ta, tb) < -0.5) c = G.add(G.lerp(p0, p2, 0.5), G.scale(ta, d * 0.9));
  const cv = G.curve(p0, c, p2);
  const n = Math.max(2, Math.ceil(G.bezierLength(cv, 16) / SAMPLE));
  for (let k = 0; k <= n; k++) {
    const f = k / n, p = G.bezier(cv, f);
    pts.push({ x: p[0], y: a.y + (b.y - a.y) * G.smoothstep(f), z: p[1] });
  }
  return pts;
}

const tangentAt = (pts, end) => {
  const [p, q] = end === 'start' ? [pts[0], pts[1]] : [pts[pts.length - 2], pts[pts.length - 1]];
  return G.norm([q.x - p.x, q.z - p.z]);
};

export function laneGraph(net) {
  const c = cache(net);
  if (c.lanes) return c.lanes;
  const lanes = new Map();
  for (const seg of net.segments.values()) for (const lane of segmentLanes(net, seg)) lanes.set(lane.id, lane);
  const conns = new Map();
  for (const node of net.nodes.values()) {
    const layout = nodeLayout(net, node.id);
    const centre = { x: node.x, z: node.z };
    for (const pair of layout.pairs) {
      const inDir = pair.from.end === 'b' ? 1 : -1, outDir = pair.to.outDir;
      const froms = [], tos = [];
      for (let i = 0; i < 4; i++) {
        const l = lanes.get(laneId(pair.from.seg, inDir, i));
        if (l && l.endIndex === pair.i) froms.push(l);
        const o = lanes.get(laneId(pair.to.seg, outDir, i));
        if (o && o.startIndex === pair.j) tos.push(o);
      }
      for (const from of froms) for (const to of tos) {
        const a = from.pts[from.pts.length - 1], b = to.pts[0];
        const pts = connectorPoints(a, tangentAt(from.pts, 'end'), b, tangentAt(to.pts, 'start'), pair.turn === 'ring' ? layout.ring : null, centre);
        const cum = G.cumulative(pts);
        const id = `${node.id}:${from.id}>${to.id}`;
        conns.set(id, {
          id, kind: 'conn', node: node.id, fromLane: from.id, toLane: to.id, arm: pair.from.seg, turn: pair.turn,
          prio: from.joins ? 'minor' : pair.prio, conflict: `${node.id}>${to.id}`,
          pts, cum, len: Math.max(cum[cum.length - 1], 0.01), speed: Math.min(from.speed, to.speed),
        });
      }
    }
  }
  const next = new Map();
  for (const l of lanes.values()) next.set(l.id, []);
  for (const cn of conns.values()) {
    next.get(cn.fromLane).push(cn.id);
    next.set(cn.id, [cn.toLane]);
  }
  const graph = { lanes, conns, next };
  c.lanes = graph;
  return graph;
}

// Lane counts at the start and end of a segment, per direction, as the lane graph builds them.
export function laneCounts(net, seg) {
  const { lanes } = laneGraph(net);
  const out = { fwd: { start: 0, end: 0 }, back: { start: 0, end: 0 } };
  for (const dir of [1, -1]) {
    const mine = [];
    for (let i = 0; i < 4; i++) { const l = lanes.get(laneId(seg.id, dir, i)); if (l) mine.push(l); }
    const key = dir > 0 ? 'fwd' : 'back';
    out[key].start = new Set(mine.map(l => l.startIndex)).size;
    out[key].end = new Set(mine.map(l => l.endIndex)).size;
  }
  return out;
}

export { laneId };
