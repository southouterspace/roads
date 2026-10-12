export const STEP = 1 / 60;

// Every per-kind behaviour lives here: speed is tiles per second, lanes is cars per direction per tile.
export const TILES = {
  grass: { color: '#7cb342' },
  street: { road: true, speed: 3, lanes: 1, color: '#55555c' },
  avenue: { road: true, speed: 6, lanes: 2, color: '#34343c' },
  house: { origin: true, color: '#e57373' },
  shop: { dest: true, color: '#5c6bc0' },
};
export const TILE_NAMES = Object.keys(TILES);
const SPEC = TILE_NAMES.map((name) => TILES[name]);
const KIND = Object.fromEntries(TILE_NAMES.map((name, id) => [name, id]));

export const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // N E S W; opposite(d) = d ^ 2
export const ONEWAY_DIR = 3;
export const ONEWAY = 4;
export const SIGNAL = 8;

export const SIGNAL_HALF = 6; // seconds per green phase
export const REROUTE_EVERY = 2; // seconds between routing-tree refreshes
export const JAM_WEIGHT = 6; // route cost multiplier at jam = 1
export const JAM_TAU = 4; // seconds, EMA time constant for jam
export const MAX_PENDING = 99;
export const ABANDON_AFTER = 120; // seconds a car may stay blocked before it gives up
export const MAX_DEMAND = 6000;
const WINDOW = 60; // seconds, metrics averaging window
const DECAY = Math.exp(-STEP / WINDOW);
const EPS = 1e-9;

export function createState(width = 96, height = 64) {
  const n = width * height;
  return {
    width,
    height,
    kind: new Uint8Array(n),
    flags: new Uint8Array(n),
    jam: new Float32Array(n),
    pending: new Uint16Array(n),
    next: new Int32Array(n).fill(-1),
    dist: new Float64Array(n).fill(Infinity),
    free: new Float64Array(n).fill(Infinity),
    houses: new Int32Array(0),
    routedAt: -Infinity,
    cars: [],
    nextCarId: 1,
    time: 0,
    tripsPerMinute: 120,
    spawnBudget: 0,
    stats: { num: 0, den: 0, arrivedEma: 0, arrivals: 0, abandoned: 0, waiting: 0 },
  };
}

export function index(s, x, y) {
  return x >= 0 && y >= 0 && x < s.width && y < s.height ? y * s.width + x : null;
}

export function neighbor(s, i, d) {
  const x = (i % s.width) + DIRS[d][0];
  const y = ((i / s.width) | 0) + DIRS[d][1];
  return x >= 0 && y >= 0 && x < s.width && y < s.height ? y * s.width + x : -1;
}

export const spec = (s, i) => SPEC[s.kind[i]];
const isRoad = (s, i) => i >= 0 && SPEC[s.kind[i]].road === true;
const isOneway = (s, i) => (s.flags[i] & ONEWAY) !== 0;
const pool = (s, i, d) => (isOneway(s, i) ? s.flags[i] & ONEWAY_DIR : d);
const capacity = (s, i) => SPEC[s.kind[i]].lanes * (isOneway(s, i) ? 2 : 1);
const againstArrow = (s, i, d) => isOneway(s, i) && d === ((s.flags[i] & ONEWAY_DIR) ^ 2);
const tileCost = (s, i, jamWeight) => (1 + jamWeight * s.jam[i]) / SPEC[s.kind[i]].speed;

function dirBetween(s, a, b) {
  const delta = b - a;
  return delta === -s.width ? 0 : delta === 1 ? 1 : delta === s.width ? 2 : 3;
}

/** May a car move from road tile a to adjacent tile b heading d? */
export function legal(s, a, b, d) {
  return isRoad(s, a) && isRoad(s, b) && !againstArrow(s, a, d) && !againstArrow(s, b, d);
}

export function isIntersection(s, i) {
  if (!isRoad(s, i)) return false;
  let roads = 0;
  for (let d = 0; d < 4; d++) if (isRoad(s, neighbor(s, i, d))) roads++;
  return roads >= 3;
}

/** 0 = N/S green, 1 = E/W green. */
export function greenAxis(time) {
  return Math.floor(time / SIGNAL_HALF) % 2;
}

// The whole capacity and intersection model: a free slot in the pool, then the box rule.
function canEnter(s, occ, b, d) {
  if (againstArrow(s, b, d) || occ[4 * b + pool(s, b, d)] >= capacity(s, b)) return false;
  if (!isIntersection(s, b)) return true;
  if (s.flags[b] & SIGNAL) return (d & 1) === greenAxis(s.time);
  return occ[4 * b] + occ[4 * b + 1] + occ[4 * b + 2] + occ[4 * b + 3] === 0;
}

class Heap {
  constructor() {
    this.cost = [];
    this.item = [];
  }
  push(c, v) {
    let i = this.cost.length;
    this.cost.push(c);
    this.item.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cost[p] <= c) break;
      this.cost[i] = this.cost[p];
      this.item[i] = this.item[p];
      i = p;
    }
    this.cost[i] = c;
    this.item[i] = v;
  }
  pop() {
    const top = this.item[0];
    const c = this.cost.pop();
    const v = this.item.pop();
    const n = this.cost.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let m = 2 * i + 1;
        if (m >= n) break;
        if (m + 1 < n && this.cost[m + 1] < this.cost[m]) m++;
        if (this.cost[m] >= c) break;
        this.cost[i] = this.cost[m];
        this.item[i] = this.item[m];
        i = m;
      }
      this.cost[i] = c;
      this.item[i] = v;
    }
    return top;
  }
  get size() {
    return this.cost.length;
  }
}

/**
 * Multi-source Dijkstra from every road tile beside a shop, over reversed legal moves.
 * dist[i] is the travel time from the centre of i to the centre of the nearest kerb.
 */
export function routeTree(s, jamWeight = JAM_WEIGHT) {
  const n = s.width * s.height;
  const dist = new Float64Array(n).fill(Infinity);
  const next = new Int32Array(n).fill(-1);
  const heap = new Heap();
  for (let t = 0; t < n; t++) {
    if (!SPEC[s.kind[t]].dest) continue;
    for (let d = 0; d < 4; d++) {
      const r = neighbor(s, t, d);
      if (!isRoad(s, r) || dist[r] === 0) continue;
      dist[r] = 0;
      next[r] = r;
      heap.push(0, r);
    }
  }
  while (heap.size > 0) {
    const c0 = heap.cost[0];
    const u = heap.pop();
    if (c0 > dist[u]) continue;
    const c = dist[u] + tileCost(s, u, jamWeight);
    for (let d = 0; d < 4; d++) {
      const v = neighbor(s, u, d);
      if (!legal(s, v, u, d ^ 2) || c >= dist[v]) continue;
      dist[v] = c;
      next[v] = u;
      heap.push(c, v);
    }
  }
  return { next, dist };
}

// Map-derived data, recomputed lazily on the first tick after an edit so painting stays cheap.
function derive(s) {
  const houses = [];
  for (let i = 0; i < s.kind.length; i++) if (SPEC[s.kind[i]].origin) houses.push(i);
  return { ...s, houses: Int32Array.from(houses), free: routeTree(s, 0).dist, ...routeTree(s), routedAt: s.time };
}

/**
 * Pure reducer. Returns the same object when the action changes nothing.
 * @param {{type:'build',kind:string,x:number,y:number}|{type:'bulldoze',x:number,y:number}
 *   |{type:'oneway',x:number,y:number,dir:number|null}|{type:'signal',x:number,y:number}
 *   |{type:'demand',tripsPerMinute:number}} action
 */
export function apply(s, action) {
  if (action.type === 'demand') {
    const v = Math.max(0, Math.min(MAX_DEMAND, Math.round(action.tripsPerMinute)));
    return v === s.tripsPerMinute ? s : { ...s, tripsPerMinute: v };
  }
  const i = index(s, action.x, action.y);
  if (i === null) return s;
  const kind = s.kind[i];
  const flags = s.flags[i];
  let nk = kind;
  let nf = flags;
  if (action.type === 'build') {
    const id = KIND[action.kind];
    const upgrade = SPEC[kind].road && SPEC[id]?.road;
    if (id === undefined || id === KIND.grass || (kind !== KIND.grass && !upgrade)) return s;
    nk = id;
    nf = upgrade ? flags : 0;
  } else if (action.type === 'bulldoze') {
    nk = KIND.grass;
    nf = 0;
  } else if (action.type === 'oneway') {
    if (!isRoad(s, i)) return s;
    nf = action.dir == null ? flags & SIGNAL : (flags & SIGNAL) | ONEWAY | action.dir;
  } else if (action.type === 'signal') {
    if (!isIntersection(s, i)) return s;
    nf = flags ^ SIGNAL;
  }
  if (nk === kind && nf === flags) return s;

  const next = { ...s, kind: s.kind.slice(), flags: s.flags.slice(), routedAt: -Infinity };
  next.kind[i] = nk;
  next.flags[i] = nf;
  if (!SPEC[nk].origin && s.pending[i]) {
    next.pending = s.pending.slice();
    next.pending[i] = 0;
  }
  next.cars = s.cars.filter((car) => isRoad(next, car.tile) && !againstArrow(next, car.tile, car.dir));
  return next;
}

/** Advance by exactly STEP seconds. Never mutates s. */
export function tick(s0, rng = Math.random) {
  const s = s0.routedAt === -Infinity ? derive(s0) : s0;
  const n = s.width * s.height;
  const time = s.time + STEP;
  const occ = new Uint8Array(4 * n);
  for (const car of s.cars) occ[4 * car.tile + pool(s, car.tile, car.dir)]++;
  const hits = new Uint16Array(n);
  const cars = [];
  let arrivals = 0;
  let abandoned = 0;
  let num = 0;
  let den = 0;

  // Array order is spawn order, so older cars get first claim on a slot or a box.
  for (const car of s.cars) {
    const a = car.tile;
    const p = car.p + SPEC[s.kind[a]].speed * STEP;
    if (p < 1 - EPS) {
      cars.push({ ...car, p });
      continue;
    }
    if (s.dist[a] === 0) {
      occ[4 * a + pool(s, a, car.dir)]--;
      arrivals++;
      num += time - car.born;
      den += car.freeFlow;
      continue;
    }
    const b = s.next[a];
    const d = b < 0 ? -1 : dirBetween(s, a, b);
    if (b >= 0 && canEnter(s, occ, b, d)) {
      occ[4 * a + pool(s, a, car.dir)]--;
      occ[4 * b + pool(s, b, d)]++;
      cars.push({ ...car, tile: b, dir: d, p: Math.max(0, p - 1), blocked: 0 });
      continue;
    }
    const blocked = car.blocked + STEP;
    if (blocked >= ABANDON_AFTER) {
      occ[4 * a + pool(s, a, car.dir)]--;
      abandoned++;
      num += time - car.born;
      den += car.freeFlow;
      continue;
    }
    hits[a]++;
    cars.push({ ...car, p: 1, blocked });
  }

  const jam = s.jam.slice();
  const k = STEP / JAM_TAU;
  for (let i = 0; i < n; i++) {
    if (!SPEC[s.kind[i]].road) continue;
    const here = occ[4 * i] + occ[4 * i + 1] + occ[4 * i + 2] + occ[4 * i + 3];
    jam[i] += ((here ? hits[i] / here : 0) - jam[i]) * k;
  }

  const pending = s.pending.slice();
  let budget = s.houses.length ? s.spawnBudget + (s.tripsPerMinute / 60) * STEP : 0;
  while (budget >= 1) {
    budget--;
    const h = s.houses[Math.floor(rng() * s.houses.length)];
    if (pending[h] < MAX_PENDING) pending[h]++;
    else abandoned++;
  }
  let nextCarId = s.nextCarId;
  let waiting = 0;
  for (const h of s.houses) {
    if (!pending[h]) continue;
    for (let d = 0; d < 4; d++) {
      const r = neighbor(s, h, d);
      if (!isRoad(s, r) || s.dist[r] === Infinity || !canEnter(s, occ, r, d)) continue;
      occ[4 * r + pool(s, r, d)]++;
      const freeFlow = tileCost(s, r, 0) + s.free[r];
      cars.push({ id: nextCarId++, tile: r, dir: d, p: 0, born: time, freeFlow, blocked: 0 });
      pending[h]--;
      break;
    }
    waiting += pending[h];
  }

  const st = s.stats;
  const stats = {
    num: st.num * DECAY + num + waiting * STEP,
    den: st.den * DECAY + den,
    arrivedEma: st.arrivedEma * DECAY + arrivals,
    arrivals: st.arrivals + arrivals,
    abandoned: st.abandoned + abandoned,
    waiting,
  };
  const out = { ...s, time, jam, pending, cars, nextCarId, spawnBudget: budget, stats };
  return time - s.routedAt >= REROUTE_EVERY - EPS ? { ...out, ...routeTree(out), routedAt: time } : out;
}

const GRADES = [
  [1.3, 'A'],
  [1.7, 'B'],
  [2.3, 'C'],
  [3.5, 'D'],
];

export function metrics(s) {
  const { num, den, arrivedEma, abandoned, waiting } = s.stats;
  // No grade until a trip has finished or trips have waited a combined minute at home.
  const idle = den === 0 && num < WINDOW;
  const delayRatio = den > 0 ? num / den : waiting > 0 ? Infinity : 1;
  return {
    active: s.cars.length,
    waiting,
    perMinute: ((arrivedEma * (1 - DECAY)) / STEP) * 60,
    delayRatio,
    abandoned,
    grade: idle ? '-' : (GRADES.find(([limit]) => delayRatio < limit)?.[1] ?? 'F'),
  };
}

/** Car centre in tile units: it slides from the previous tile's centre to this tile's centre. */
export function carPose(s, car) {
  const [dx, dy] = DIRS[car.dir];
  const back = 1 - car.p;
  return {
    x: (car.tile % s.width) + 0.5 - dx * back,
    y: ((car.tile / s.width) | 0) + 0.5 - dy * back,
    dir: car.dir,
  };
}
