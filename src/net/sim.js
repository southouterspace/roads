import * as G from './geometry.js';
import { laneGraph, nodeLayout } from './derive.js';

const A_LAT = 2.2;
const ACCEL = 2.2;
const BRAKE = 3.2;
const HARD_BRAKE = 9;
const CAR_LEN = 4.6;
const MIN_GAP = 2.2;
const LOOKAHEAD = 160;
const GHOST_AFTER = 60;
const GHOST_FOR = 6;
const PHASE_GREEN = 12, PHASE_AMBER = 3, PHASE_CLEAR = 1.5;
export const MAX_CARS = 320;
export const TRAFFIC = { calm: 10, steady: 5, rush: 2.2 };

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const graphMemo = new WeakMap();

function prepare(net) {
  const graph = laneGraph(net);
  let g = graphMemo.get(graph);
  if (g) return g;
  const paths = new Map([...graph.lanes, ...graph.conns]);
  const lim = new Map();
  for (const p of paths.values()) lim.set(p.id, speedLimits(p));
  const byConflict = new Map(), byNode = new Map();
  for (const c of graph.conns.values()) {
    if (!byConflict.has(c.conflict)) byConflict.set(c.conflict, []);
    byConflict.get(c.conflict).push(c);
    if (!byNode.has(c.node)) byNode.set(c.node, []);
    byNode.get(c.node).push(c);
  }
  const into = new Map();
  for (const c of graph.conns.values()) {
    if (!into.has(c.toLane)) into.set(c.toLane, []);
    into.get(c.toLane).push(c.id);
  }
  const controls = new Map();
  for (const node of net.nodes.values()) controls.set(node.id, nodeControl(net, node));
  g = { net, graph, paths, lim, byConflict, byNode, into, controls };
  graphMemo.set(graph, g);
  return g;
}

function speedLimits(p) {
  const pts = p.pts, n = pts.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = p.speed;
    if (i > 0 && i < n - 1) {
      const r = circumradius(pts[i - 1], pts[i], pts[i + 1]);
      v = Math.min(v, Math.sqrt(A_LAT * r));
    }
    out[i] = v;
  }
  if (p.kind === 'conn' && n > 2) {
    let minR = Infinity;
    for (let i = 1; i < n - 1; i++) minR = Math.min(minR, circumradius(pts[i - 1], pts[i], pts[i + 1]));
    const v = Math.min(p.speed, Math.max(4, Math.sqrt(A_LAT * minR)));
    for (let i = 0; i < n; i++) out[i] = Math.min(out[i], v);
  }
  for (let i = n - 2; i >= 0; i--) out[i] = Math.min(out[i], Math.sqrt(out[i + 1] ** 2 + 2 * BRAKE * (p.cum[i + 1] - p.cum[i])));
  return out;
}

function circumradius(a, b, c) {
  const ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z), ca = Math.hypot(a.x - c.x, a.z - c.z);
  const area2 = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
  return area2 < 1e-9 ? Infinity : (ab * bc * ca) / (2 * area2);
}

// The control a node actually runs. 'auto' resolves from the junction kind; 'none' means free flow with
// minor connectors yielding at merges.
function nodeControl(net, node) {
  const { cls } = nodeLayout(net, node.id);
  if (cls.kind !== 'intersection') return { kind: 'none' };
  const ins = cls.arms.filter(a => a.inCount > 0);
  let kind = node.control;
  if (kind === 'auto') kind = cls.arms.length >= 4 || ins.some(a => a.inCount >= 2) ? 'signal' : 'yield';
  switch (kind) {
    case 'signal': {
      const phases = [];
      for (const a of ins) {
        const ph = phases.find(p => p.some(b => Math.abs(Math.sin(a.angle - b.angle)) < Math.sin(Math.PI / 5)));
        if (ph) ph.push(a); else phases.push([a]);
      }
      const phaseOf = new Map();
      phases.forEach((p, i) => p.forEach(a => phaseOf.set(a.seg, i)));
      return { kind, phaseOf, count: phases.length, offset: (node.id * 7.31) % 20 };
    }
    case 'yield': {
      let best = null, bestScore = -Infinity;
      for (const a of cls.arms) for (const b of cls.arms) {
        if (a === b) continue;
        const score = -G.dot(a.away, b.away) * 2 + (a.inCount + a.outCount + b.inCount + b.outCount) * 0.3 + a.profile.speed / 30 + b.profile.speed / 30;
        if (score > bestScore) { bestScore = score; best = [a.seg, b.seg]; }
      }
      return { kind, major: new Set(best || []) };
    }
    case 'stop':
      return { kind };
    case 'roundabout':
      return { kind, centre: { x: node.x, z: node.z } };
  }
  return { kind: 'none' };
}

const resolveTown = (net, town) => {
  let best = null, bestD = town.r ?? 60;
  for (const n of net.nodes.values()) {
    const d = Math.hypot(n.x - town.x, n.z - town.z);
    if (d < bestD) { best = n.id; bestD = d; }
  }
  return best;
};

export function createSim(net, towns, opts = {}) {
  const state = {
    g: prepare(net), towns: towns.map((t, i) => ({ ...t, index: i, node: null, timer: i * 0.7 })),
    cars: [], onPath: new Map(), junctions: new Map(), time: 0, nextId: 1,
    delivered: new Map(towns.map(t => [t.name, 0])), trips: 0, flow: null, maxWait: 0, ghosts: 0,
    traffic: opts.traffic || 'steady',
  };
  for (const t of state.towns) t.node = resolveTown(net, t);
  return state;
}

export function setNetwork(state, net) {
  state.g = prepare(net);
  for (const t of state.towns) t.node = resolveTown(net, t);
  const { paths } = state.g;
  state.cars = state.cars.filter(car => {
    for (let i = car.ri; i < car.route.length; i++) if (!paths.has(car.route[i])) return false;
    const p = paths.get(car.route[car.ri]);
    car.s = Math.min(car.s, p.len);
    car.k = 0;
    return true;
  });
  state.junctions.clear();
  for (const car of state.cars) for (const id of car.grants) {
    const c = state.g.graph.conns.get(id);
    if (c) junction(state, c.node).occ.set(car.id, id);
  }
}

const junction = (state, nodeId) => {
  let j = state.junctions.get(nodeId);
  if (!j) { j = { occ: new Map(), queue: [] }; state.junctions.set(nodeId, j); }
  return j;
};

function route(state, from, to) {
  const { graph, paths } = state.g;
  const dist = new Map(), prev = new Map(), heap = [];
  const push = (d, id) => {
    heap.push([d, id]);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const cost = p => {
    let c = p.len / p.speed + (state.onPath.get(p.id)?.length || 0) * 2.5;
    if (p.kind === 'conn') {
      const ctl = state.g.controls.get(p.node).kind;
      c += ctl === 'stop' ? 6 : ctl === 'signal' ? 8 : ctl === 'none' ? 0 : 3;
    }
    return c;
  };
  for (const l of graph.lanes.values()) if (l.from === from) { dist.set(l.id, cost(l)); push(cost(l), l.id); }
  let goal = null;
  while (heap.length) {
    const [d, id] = pop();
    if (d > dist.get(id)) continue;
    const p = paths.get(id);
    if (p.kind === 'lane' && p.to === to) { goal = id; break; }
    if (p.kind === 'lane' && p.to !== to && state.towns.some(t => t.node === p.to)) continue;
    for (const n of graph.next.get(id) || []) {
      const nd = d + cost(paths.get(n));
      if (nd < (dist.get(n) ?? Infinity)) { dist.set(n, nd); prev.set(n, id); push(nd, n); }
    }
  }
  if (!goal) return null;
  const out = [];
  for (let id = goal; id !== undefined; id = prev.get(id)) out.push(id);
  return out.reverse();
}

function spawn(state, rng) {
  const live = state.towns.filter(t => t.node !== null);
  for (const t of live) {
    if (t.timer > 0) continue;
    t.timer = TRAFFIC[state.traffic] * (0.6 + rng() * 0.8);
    if (state.cars.length >= MAX_CARS) continue;
    const dests = live.filter(d => d !== t && d.node !== t.node);
    if (!dests.length) continue;
    const dst = dests[Math.floor(rng() * dests.length)];
    const r = route(state, t.node, dst.node);
    if (!r) continue;
    const first = r[0];
    if ((state.onPath.get(first) || []).some(c => c.s < CAR_LEN + MIN_GAP * 2)) continue;
    const free = r.reduce((s, id) => s + state.g.paths.get(id).len / state.g.paths.get(id).speed, 0);
    const car = {
      id: state.nextId++, route: r, ri: 0, s: 0, k: 0, v: 4, src: t.index, dst: dst.index, age: 0, wait: 0, ghost: 0,
      free, grants: new Set(), x: 0, y: 0, z: 0, heading: 0, pitch: 0, brake: false, color: dst.index,
    };
    state.cars.push(car);
    addOnPath(state, first, car);
    place(state, car);
  }
}

function addOnPath(state, id, car) {
  if (!state.onPath.has(id)) state.onPath.set(id, []);
  state.onPath.get(id).push(car);
}

function rebuildOnPath(state) {
  state.onPath = new Map();
  for (const car of state.cars) addOnPath(state, car.route[car.ri], car);
}

function limAt(state, path, car) {
  const lim = state.g.lim.get(path.id), cum = path.cum;
  while (car.k < cum.length - 2 && cum[car.k + 1] <= car.s) car.k++;
  return Math.min(lim[car.k], lim[Math.min(car.k + 1, lim.length - 1)] + 1);
}

function ahead(state, car) {
  const out = [];
  const cur = state.g.paths.get(car.route[car.ri]);
  let d = cur.len - car.s;
  for (let i = car.ri + 1; i < car.route.length && d < LOOKAHEAD; i++) {
    const p = state.g.paths.get(car.route[i]);
    out.push({ p, d });
    d += p.len;
  }
  return out;
}

function leaderGap(state, car, cur, upcoming) {
  let gap = Infinity, lv = 0;
  for (const o of state.onPath.get(cur.id) || []) {
    if (o === car || o.s <= car.s) continue;
    const g = o.s - car.s - CAR_LEN;
    if (g < gap) { gap = g; lv = o.v; }
  }
  if (gap < Infinity) return { gap, lv };
  const myRemain = cur.len - car.s;
  for (const { p, d } of upcoming) {
    if (d > 90) break;
    for (const o of state.onPath.get(p.id) || []) {
      const g = d + o.s - CAR_LEN;
      if (g < gap) { gap = g; lv = o.v; }
    }
    if (p.kind === 'lane') {
      for (const cid of state.g.into.get(p.id) || []) {
        if (cid === cur.id || upcoming.some(u => u.p.id === cid)) continue;
        const conn = state.g.paths.get(cid);
        for (const o of state.onPath.get(cid) || []) {
          const theirs = conn.len - o.s;
          const mine = d;
          if (theirs < mine || (theirs === mine && o.id < car.id)) {
            const g = mine - theirs - CAR_LEN;
            if (g < gap) { gap = g; lv = o.v; }
          }
        }
      }
    }
    if (gap < Infinity) break;
  }
  return { gap, lv, myRemain };
}

function signalPhase(state, ctl, arm) {
  const cycle = PHASE_GREEN + PHASE_AMBER + PHASE_CLEAR;
  const t = (state.time + ctl.offset) % (cycle * ctl.count);
  const phase = Math.floor(t / cycle), within = t - phase * cycle;
  if (ctl.phaseOf.get(arm) !== phase) return 'red';
  return within < PHASE_GREEN ? 'green' : within < PHASE_GREEN + PHASE_AMBER ? 'amber' : 'red';
}

export const controlKind = (state, nodeId) => state.g.controls.get(nodeId)?.kind ?? 'none';

export function signalColour(state, nodeId, segId) {
  const ctl = state.g.controls.get(nodeId);
  return ctl && ctl.kind === 'signal' ? signalPhase(state, ctl, segId) : null;
}

function approaching(state, conn, window) {
  const lane = state.g.paths.get(conn.fromLane);
  for (const o of state.onPath.get(lane.id) || []) {
    const remain = lane.len - o.s;
    if (remain < Math.max(window, o.v * 3)) return true;
  }
  return false;
}

// Whether a car may enter a connector now. One switch over the node's control.
function mayEnter(state, car, conn, dist) {
  const ctl = state.g.controls.get(conn.node);
  const j = junction(state, conn.node);
  const others = [...j.occ.entries()].filter(([id]) => id !== car.id).map(([, cid]) => state.g.graph.conns.get(cid)).filter(Boolean);
  switch (ctl.kind) {
    case 'none': {
      if (conn.prio === 'major') return true;
      const rivals = (state.g.byConflict.get(conn.conflict) || []).filter(c => c.prio === 'major');
      if (rivals.some(c => (state.onPath.get(c.id) || []).length)) return false;
      if (car.wait > 15) return true;
      return !rivals.some(c => approaching(state, c, 25));
    }
    case 'signal': {
      if (signalPhase(state, ctl, conn.arm) !== 'green') return false;
      return others.every(c => ctl.phaseOf.get(c.arm) === ctl.phaseOf.get(conn.arm));
    }
    case 'stop': {
      if (dist > 3 || car.v > 0.6) return false;
      if (!j.queue.includes(car.id)) j.queue.push(car.id);
      if (others.length) return false;
      const live = new Set(state.cars.map(c => c.id));
      j.queue = j.queue.filter(id => live.has(id));
      return j.queue[0] === car.id;
    }
    case 'yield': {
      const major = ctl.major.has(conn.arm);
      if (major) return others.every(c => ctl.major.has(c.arm) || c.arm === conn.arm);
      if (others.some(c => c.arm !== conn.arm)) return false;
      if (car.wait > 20) return true;
      const rivals = (state.g.byNode.get(conn.node) || []).filter(c => ctl.major.has(c.arm) && c.arm !== conn.arm);
      return !rivals.some(c => approaching(state, c, 30));
    }
    case 'roundabout': {
      if (others.length >= 8) return false;
      const centre = ctl.centre, entry = Math.atan2(conn.pts[0].z - centre.z, conn.pts[0].x - centre.x);
      for (const [id] of j.occ) {
        if (id === car.id) continue;
        const o = state.cars.find(c => c.id === id);
        if (!o) continue;
        const d = Math.atan2(Math.sin(Math.atan2(o.z - centre.z, o.x - centre.x) - entry), Math.cos(Math.atan2(o.z - centre.z, o.x - centre.x) - entry));
        if (d > -0.3 && d < 1.3) return false;
      }
      return true;
    }
  }
  return true;
}

function release(state, car, connId) {
  const conn = state.g.graph.conns.get(connId);
  car.grants.delete(connId);
  if (!conn) return;
  const j = state.junctions.get(conn.node);
  if (!j) return;
  j.occ.delete(car.id);
  j.queue = j.queue.filter(id => id !== car.id);
}

function place(state, car) {
  const p = state.g.paths.get(car.route[car.ri]);
  const cum = p.cum, pts = p.pts;
  let k = car.k;
  while (k < cum.length - 2 && cum[k + 1] <= car.s) k++;
  car.k = k;
  const a = pts[k], b = pts[Math.min(k + 1, pts.length - 1)];
  const f = G.clamp((car.s - cum[k]) / ((cum[k + 1] - cum[k]) || 1), 0, 1);
  car.x = a.x + (b.x - a.x) * f;
  car.y = a.y + (b.y - a.y) * f;
  car.z = a.z + (b.z - a.z) * f;
  const h = Math.hypot(b.x - a.x, b.z - a.z);
  if (h > 1e-6) car.heading = Math.atan2(b.x - a.x, b.z - a.z);
  car.pitch = Math.atan2(b.y - a.y, h || 1);
}

export function tick(state, dt, rng) {
  state.time += dt;
  for (const t of state.towns) t.timer -= dt;
  spawn(state, rng);
  const { paths } = state.g;
  for (const car of state.cars) {
    car.age += dt;
    const cur = paths.get(car.route[car.ri]);
    let target = limAt(state, cur, car);
    const upcoming = ahead(state, car);
    for (const { p, d } of upcoming.slice(0, 4)) target = Math.min(target, Math.sqrt(state.g.lim.get(p.id)[0] ** 2 + 2 * BRAKE * d));
    const ghost = car.ghost > 0;
    if (!ghost) {
      const { gap, lv } = leaderGap(state, car, cur, upcoming);
      if (gap < Infinity) target = Math.min(target, Math.max(0, Math.min(Math.sqrt(lv * lv + 2 * BRAKE * Math.max(0, gap - MIN_GAP)), (gap - MIN_GAP) / 1.1 + lv)));
      const stopFor = [];
      if (cur.kind === 'lane') stopFor.push(...upcoming.filter(u => u.p.kind === 'conn').slice(0, 1));
      for (const { p, d } of stopFor) {
        if (car.grants.has(p.id)) continue;
        if (d > Math.max(30, (car.v * car.v) / (2 * BRAKE) + 8)) continue;
        if (mayEnter(state, car, p, d)) {
          car.grants.add(p.id);
          const ctl = state.g.controls.get(p.node).kind;
          if (ctl !== 'none' || p.prio === 'minor') junction(state, p.node).occ.set(car.id, p.id);
        } else {
          target = Math.min(target, Math.sqrt(2 * BRAKE * Math.max(0, d - 1)));
        }
      }
    }
    car.brake = target < car.v - 0.3;
    car.v = target > car.v ? Math.min(target, car.v + ACCEL * dt) : Math.max(target, car.v - HARD_BRAKE * dt);
    car.wait = car.v < 0.3 ? car.wait + dt : 0;
    state.maxWait = Math.max(state.maxWait, car.wait);
    if (car.ghost > 0) car.ghost -= dt;
    else if (car.wait > GHOST_AFTER) { car.ghost = GHOST_FOR; state.ghosts++; }
    car.s += car.v * dt;
    let p = cur;
    while (car.s >= p.len) {
      if (car.ri === car.route.length - 1) { car.done = true; break; }
      car.s -= p.len;
      if (p.kind === 'conn') release(state, car, p.id);
      car.ri++;
      car.k = 0;
      p = paths.get(car.route[car.ri]);
      if (p.kind === 'conn' && !car.grants.has(p.id)) {
        car.grants.add(p.id);
        if (state.g.controls.get(p.node).kind !== 'none') junction(state, p.node).occ.set(car.id, p.id);
      }
    }
    if (!car.done) place(state, car);
  }
  for (const car of state.cars) {
    if (!car.done) continue;
    for (const id of [...car.grants]) release(state, car, id);
    const dst = state.towns[car.dst];
    state.delivered.set(dst.name, state.delivered.get(dst.name) + 1);
    state.trips++;
    const ratio = Math.min(1, car.free / Math.max(car.age, 0.01));
    state.flow = state.flow === null ? ratio : state.flow * 0.95 + ratio * 0.05;
  }
  state.cars = state.cars.filter(c => !c.done);
  rebuildOnPath(state);
}
