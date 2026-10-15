import { profile, pairOf, dividedOffset } from './profiles.js';
import * as G from './geometry.js';
import { centreline, segCurve, incident, nodeY, armsAt } from './derive.js';
import { surfaceAt } from './terrain.js';
import { inspect } from './validate.js';

export const LIFT_STEP = 2.5;
export const MAX_LIFT = 30;
export const CONTROLS = ['auto', 'yield', 'stop', 'signal', 'roundabout'];

export const emptyNetwork = () => ({ nodes: new Map(), segments: new Map(), nextId: 1 });

const clone = net => ({ nodes: new Map(net.nodes), segments: new Map(net.segments), nextId: net.nextId });

function addNode(w, x, z, lift) {
  const id = w.nextId++;
  w.nodes.set(id, { id, x, z, lift, control: 'auto' });
  return id;
}

function addSegment(w, a, b, ctrl, profileA, profileB) {
  const id = w.nextId++;
  w.segments.set(id, { id, a, b, ctrl, profileA, profileB });
  return id;
}

const yAtT = (pts, t) => {
  let i = 0;
  while (i < pts.length - 2 && pts[i + 1].t < t) i++;
  const p = pts[i], q = pts[i + 1], f = (t - p.t) / ((q.t - p.t) || 1);
  return p.y + (q.y - p.y) * G.clamp(f, 0, 1);
};

function splitSegment(w, sid, t, lineage, lift) {
  const seg = w.segments.get(sid);
  const cv = segCurve(w, seg);
  const [c1, c2] = G.splitCurve(cv, t);
  const p = c1.p2;
  const y = yAtT(centreline(w, seg).pts, t);
  const nodeId = addNode(w, p[0], p[1], lift ?? Math.max(0, y - surfaceAt(p[0], p[1])));
  const taperFirst = t >= 0.5;
  const s1 = addSegment(w, seg.a, nodeId, seg.ctrl ? c1.c : null, seg.profileA, taperFirst ? seg.profileB : seg.profileA);
  const s2 = addSegment(w, nodeId, seg.b, seg.ctrl ? c2.c : null, taperFirst ? seg.profileB : seg.profileA, seg.profileB);
  w.segments.delete(sid);
  lineage.set(sid, [s1, s2]);
  return nodeId;
}

function resolveSeg(w, lineage, sid, point) {
  while (!w.segments.has(sid)) {
    const kids = lineage.get(sid);
    if (!kids) return null;
    sid = kids.map(k => [k, resolveSeg(w, lineage, k, point)]).filter(([, r]) => r !== null)
      .map(([, r]) => [r, G.nearestT(segCurve(w, w.segments.get(r)), point).d])
      .sort((x, y) => x[1] - y[1])[0][0];
  }
  return sid;
}

// Anchors: { kind: 'free', x, z } | { kind: 'node', id } | { kind: 'segment', id, t }
function resolveAnchor(net, anchor, lift, role, toward) {
  switch (anchor.kind) {
    case 'free':
      return { pos: [anchor.x, anchor.z], lift, y: surfaceAt(anchor.x, anchor.z) + lift, node: null, split: null, tangent: null };
    case 'node': {
      const n = net.nodes.get(anchor.id);
      if (!n) return null;
      const arms = armsAt(net, n.id);
      const tangent = role === 'start' && arms.length === 1 ? G.scale(arms[0].away, -1) : null;
      return { pos: [n.x, n.z], lift: n.lift, y: nodeY(n), node: n.id, split: null, tangent };
    }
    case 'segment': {
      const seg = net.segments.get(anchor.id);
      if (!seg) return null;
      const c = centreline(net, seg);
      const t = G.clamp(anchor.t, 0.001, 0.999);
      const p = G.bezier(c.cv, t), y = yAtT(c.pts, t);
      let tangent = G.bezierTangent(c.cv, t);
      if (!profile(seg.profileA).oneWay && toward && G.dot(tangent, G.sub(toward, p)) < 0) tangent = G.scale(tangent, -1);
      return { pos: p, lift: Math.max(0, y - surfaceAt(p[0], p[1])), y, node: null, split: { seg: seg.id, t }, tangent: role === 'start' ? tangent : null };
    }
  }
  return null;
}

// The control point that leaves p0 along `tangent` and reaches p2 on a near-circular arc.
export function continuationCtrl(p0, tangent, p2) {
  const d = G.sub(p2, p0), l = G.len(d), proj = G.dot(tangent, d);
  if (l < 1e-6) return null;
  const k = proj <= 0.05 * l ? l * 0.5 : Math.min((l * l) / (2 * proj), 3 * l);
  return G.add(p0, G.scale(tangent, k));
}

function anchorPoint(net, anchor) {
  if (anchor.kind === 'free') return [anchor.x, anchor.z];
  if (anchor.kind === 'node') { const n = net.nodes.get(anchor.id); return n ? [n.x, n.z] : null; }
  const seg = net.segments.get(anchor.id);
  return seg ? G.bezier(segCurve(net, seg), anchor.t) : null;
}

export function planBuild(net, action) {
  const endPoint = anchorPoint(net, action.to), startPoint = anchorPoint(net, action.from);
  if (!endPoint || !startPoint) return { plan: null, error: { reason: 'missing', at: [0, 0] } };
  const start = resolveAnchor(net, action.from, action.liftFrom ?? 0, 'start', endPoint);
  const end = resolveAnchor(net, action.to, action.liftTo ?? 0, 'end', startPoint);
  let ctrl = action.ctrl;
  if (ctrl === undefined) ctrl = start.tangent ? continuationCtrl(start.pos, start.tangent, end.pos) : null;
  const cv = G.curve(start.pos, ctrl, end.pos);
  const profileA = action.profile, profileB = action.profileB ?? action.profile;
  const joints = [];
  if (start.node !== null || start.split) joints.push({ end: 'start', node: start.node, split: start.split, pos: start.pos });
  if (end.node !== null || end.split) joints.push({ end: 'end', node: end.node, split: end.split, pos: end.pos });
  const cand = {
    cv, ctrl: ctrl || null, profileA, profileB, joints, ignore: new Set(), autoJoin: true,
    ends: { liftA: start.lift, liftB: end.lift, yA: start.y, yB: end.y },
  };
  const r = inspect(net, cand);
  return { plan: { ...cand, raw: r.raw, joins: r.joins, start, end }, error: r.error };
}

function applyBuild(net, action) {
  const { plan, error } = planBuild(net, action);
  if (error) return { net, error };
  const w = clone(net);
  const lineage = new Map();
  const nodeFor = a => {
    if (a.node !== null) return a.node;
    if (!a.split) return addNode(w, a.pos[0], a.pos[1], a.lift);
    const sid = resolveSeg(w, lineage, a.split.seg, a.pos);
    return splitSegment(w, sid, G.nearestT(segCurve(w, w.segments.get(sid)), a.pos).t, lineage, a.lift);
  };
  const startId = nodeFor(plan.start), endId = nodeFor(plan.end);
  const chain = [startId];
  const tAt = s => {
    const pts = plan.raw.pts;
    let i = 0;
    while (i < pts.length - 2 && pts[i + 1].s < s) i++;
    const p = pts[i], q = pts[i + 1];
    return p.t + (q.t - p.t) * G.clamp((s - p.s) / ((q.s - p.s) || 1), 0, 1);
  };
  const ts = [];
  for (const j of plan.joins) {
    const lift = Math.max(0, j.y - surfaceAt(j.x, j.z));
    let id = j.node;
    if (id === null) {
      const sid = resolveSeg(w, lineage, j.seg, [j.x, j.z]);
      id = splitSegment(w, sid, G.nearestT(segCurve(w, w.segments.get(sid)), [j.x, j.z]).t, lineage, lift);
    }
    chain.push(id);
    ts.push(tAt(j.s));
  }
  chain.push(endId);
  let rest = plan.cv, done = 0;
  const pieces = [];
  for (const t of ts) {
    const [head, tail] = G.splitCurve(rest, (t - done) / (1 - done));
    pieces.push(head);
    rest = tail;
    done = t;
  }
  pieces.push(rest);
  const segments = pieces.map((pc, i) => {
    const last = i === pieces.length - 1;
    return addSegment(w, chain[i], chain[i + 1], plan.ctrl ? pc.c : null, plan.profileA, last ? plan.profileB : plan.profileA);
  });
  return { net: w, built: { nodes: chain, segments } };
}

// Two one-way carriageways offset either side of the drawn line; the left one runs the other way.
export function dividedActions(net, action) {
  const cw = pairOf.get(action.pair).carriageway, off = dividedOffset(cw);
  const p0 = [action.from.x, action.from.z], p2 = [action.to.x, action.to.z];
  const cv = G.curve(p0, action.ctrl || null, p2);
  const t0 = G.bezierTangent(cv, 0), t2 = G.bezierTangent(cv, 1);
  const side = k => {
    const a = G.add(p0, G.scale(G.right(t0), off * k)), b = G.add(p2, G.scale(G.right(t2), off * k));
    const c = action.ctrl ? G.rayMeet(a, t0, b, G.scale(t2, -1)) || G.add(action.ctrl, G.scale(G.right(G.norm(G.sub(p2, p0))), off * k)) : null;
    return { a, b, c };
  };
  const snap = p => {
    for (const n of net.nodes.values()) if (G.dist([n.x, n.z], p) < 2) return { kind: 'node', id: n.id };
    return { kind: 'free', x: p[0], z: p[1] };
  };
  const r = side(1), l = side(-1);
  return [
    { type: 'build', from: snap(r.a), to: snap(r.b), ctrl: r.c, profile: cw, liftFrom: action.liftFrom ?? 0, liftTo: action.liftTo ?? 0 },
    { type: 'build', from: snap(l.b), to: snap(l.a), ctrl: l.c, profile: cw, liftFrom: action.liftTo ?? 0, liftTo: action.liftFrom ?? 0 },
  ];
}

// One build per piece along a route between two existing nodes. Inner nodes take a height interpolated by distance.
// pieces: [{ from, to, ctrl, profile, profileB }]
export function chainActions(net, action) {
  const a = net.nodes.get(action.fromNode), b = net.nodes.get(action.toNode);
  const lengths = action.pieces.map(p => G.bezierLength(G.curve(p.from, p.ctrl, p.to)));
  const total = lengths.reduce((x, y) => x + y, 0);
  const lifts = [a.lift];
  let s = 0;
  for (const l of lengths.slice(0, -1)) {
    s += l;
    lifts.push(a.lift + (b.lift - a.lift) * (s / total));
  }
  lifts.push(b.lift);
  const last = action.pieces.length - 1;
  return action.pieces.map((p, i) => ({
    type: 'build',
    from: i === 0 ? { kind: 'node', id: a.id } : { kind: 'free', x: p.from[0], z: p.from[1] },
    to: i === last ? { kind: 'node', id: b.id } : { kind: 'free', x: p.to[0], z: p.to[1] },
    ctrl: p.ctrl, profile: p.profile, profileB: p.profileB ?? p.profile, liftFrom: lifts[i], liftTo: lifts[i + 1],
  }));
}

function revalidate(w, segIds) {
  for (const id of segIds) {
    const seg = w.segments.get(id);
    const a = w.nodes.get(seg.a), b = w.nodes.get(seg.b);
    const cand = {
      cv: segCurve(w, seg), profileA: seg.profileA, profileB: seg.profileB, ignore: new Set([seg.id]), autoJoin: false,
      ends: { liftA: a.lift, liftB: b.lift, yA: nodeY(a), yB: nodeY(b) },
      joints: [{ end: 'start', node: a.id, split: null, pos: [a.x, a.z] }, { end: 'end', node: b.id, split: null, pos: [b.x, b.z] }],
    };
    const r = inspect(w, cand);
    if (r.error && r.error.reason !== 'angle') return r.error;
  }
  return null;
}

// Every edit goes through here. Returns a new network, or the same one with an error.
export function apply(net, action) {
  switch (action.type) {
    case 'build':
      return applyBuild(net, action);
    case 'divided': {
      const [first, second] = dividedActions(net, action);
      const r1 = apply(net, first);
      if (r1.error) return { net, error: r1.error };
      const r2 = apply(r1.net, second);
      if (r2.error) return { net, error: r2.error };
      return { net: r2.net, built: { nodes: [...r1.built.nodes, ...r2.built.nodes], segments: [...r1.built.segments, ...r2.built.segments] } };
    }
    case 'chain': {
      if (!net.nodes.has(action.fromNode) || !net.nodes.has(action.toNode)) return { net, error: { reason: 'missing' } };
      let w = net, from = null;
      const built = { nodes: [], segments: [] };
      for (const step of chainActions(net, action)) {
        const r = apply(w, from === null ? step : { ...step, from: { kind: 'node', id: from } });
        if (r.error) return { net, error: r.error };
        w = r.net;
        from = r.built.nodes.at(-1);
        built.nodes.push(...r.built.nodes);
        built.segments.push(...r.built.segments);
      }
      return { net: w, built };
    }
    case 'bulldoze': {
      const seg = net.segments.get(action.seg);
      if (!seg) return { net, error: { reason: 'missing' } };
      const w = clone(net);
      w.segments.delete(seg.id);
      for (const n of [seg.a, seg.b]) if (incident(w, n).length === 0) w.nodes.delete(n);
      return { net: w };
    }
    case 'upgrade': {
      const seg = net.segments.get(action.seg);
      if (!seg || !profile(action.profile)) return { net, error: { reason: 'missing' } };
      const w = clone(net);
      w.segments.set(seg.id, { ...seg, profileA: action.profile, profileB: action.profile });
      const error = revalidate(w, [seg.id]);
      return error ? { net, error } : { net: w };
    }
    case 'reverse': {
      const seg = net.segments.get(action.seg);
      if (!seg) return { net, error: { reason: 'missing' } };
      if (!profile(seg.profileA).oneWay || !profile(seg.profileB).oneWay) return { net, error: { reason: 'twoWay' } };
      const w = clone(net);
      w.segments.set(seg.id, { ...seg, a: seg.b, b: seg.a, profileA: seg.profileB, profileB: seg.profileA });
      return { net: w };
    }
    case 'setControl': {
      const node = net.nodes.get(action.node);
      if (!node || !CONTROLS.includes(action.control)) return { net, error: { reason: 'missing' } };
      const w = clone(net);
      w.nodes.set(node.id, { ...node, control: action.control });
      return { net: w };
    }
    case 'setLift': {
      const node = net.nodes.get(action.node);
      if (!node) return { net, error: { reason: 'missing' } };
      const w = clone(net);
      w.nodes.set(node.id, { ...node, lift: G.clamp(action.lift, 0, MAX_LIFT) });
      const error = revalidate(w, incident(w, node.id).map(s => s.id));
      return error ? { net, error } : { net: w };
    }
  }
  return { net, error: { reason: 'unknown' } };
}

export function nearestNode(net, x, z, r) {
  let best = null, bestD = r;
  for (const n of net.nodes.values()) {
    const d = Math.hypot(n.x - x, n.z - z);
    if (d < bestD) { best = n; bestD = d; }
  }
  return best;
}

export function nearestSegment(net, x, z, r) {
  let best = null;
  for (const seg of net.segments.values()) {
    const c = centreline(net, seg), bb = c.bbox;
    if (x < bb.x0 - r - 20 || x > bb.x1 + r + 20 || z < bb.z0 - r - 20 || z > bb.z1 + r + 20) continue;
    const { t, d } = G.nearestT(c.cv, [x, z]);
    if (d < r && (!best || d < best.d)) best = { seg, t, d };
  }
  return best;
}
