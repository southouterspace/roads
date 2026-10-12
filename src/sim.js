export const TILES = {
  grass: { cost: 0, color: '#7cb342', connects: false },
  road: { cost: 10, color: '#4a4a4a', connects: true },
  house: { cost: 50, color: '#e57373', connects: true },
  shop: { cost: 100, color: '#5c6bc0', connects: true },
};

export const START_MONEY = 500;
export const CAR_SPEED = 3;
export const SPAWN_INTERVAL = 1.5;
export const MAX_CARS = 30;
export const DELIVERY_REWARD = 15;

const DIRS = [
  { dx: 0, dy: -1, bit: 1 },
  { dx: 1, dy: 0, bit: 2 },
  { dx: 0, dy: 1, bit: 4 },
  { dx: -1, dy: 0, bit: 8 },
];

export function createState(width = 20, height = 14) {
  return {
    width,
    height,
    tiles: Array(width * height).fill('grass'),
    money: START_MONEY,
    cars: [],
    delivered: 0,
    spawnTimer: 0,
    nextCarId: 1,
  };
}

export function inBounds(state, x, y) {
  return x >= 0 && y >= 0 && x < state.width && y < state.height;
}

export function tileAt(state, x, y) {
  return inBounds(state, x, y) ? state.tiles[y * state.width + x] : null;
}

function withTile(state, x, y, kind) {
  const tiles = state.tiles.slice();
  tiles[y * state.width + x] = kind;
  return tiles;
}

export function apply(state, action) {
  const { x, y } = action;
  const current = tileAt(state, x, y);
  if (current === null) return state;

  if (action.type === 'build') {
    const tile = TILES[action.kind];
    if (!tile || action.kind === 'grass' || current !== 'grass') return state;
    if (state.money < tile.cost) return state;
    return { ...state, tiles: withTile(state, x, y, action.kind), money: state.money - tile.cost };
  }

  if (action.type === 'bulldoze') {
    if (current === 'grass') return state;
    return {
      ...state,
      tiles: withTile(state, x, y, 'grass'),
      money: state.money + Math.floor(TILES[current].cost / 2),
      cars: state.cars.filter((car) => !car.path.some((p) => p.x === x && p.y === y)),
    };
  }

  return state;
}

export function roadMask(state, x, y) {
  let mask = 0;
  for (const { dx, dy, bit } of DIRS) {
    const kind = tileAt(state, x + dx, y + dy);
    if (kind && TILES[kind].connects) mask |= bit;
  }
  return mask;
}

function adjacentRoads(state, x, y) {
  return DIRS.map(({ dx, dy }) => ({ x: x + dx, y: y + dy })).filter(
    (p) => tileAt(state, p.x, p.y) === 'road',
  );
}

// BFS from every road touching `from` to the first road touching `to`; both are building tiles.
export function findPath(state, from, to) {
  const key = (p) => p.y * state.width + p.x;
  const goals = new Set(adjacentRoads(state, to.x, to.y).map(key));
  const prev = new Map();
  const queue = [];
  for (const start of adjacentRoads(state, from.x, from.y)) {
    prev.set(key(start), null);
    queue.push(start);
  }
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (goals.has(key(cur))) {
      const path = [];
      for (let p = cur; p; p = prev.get(key(p))) path.unshift(p);
      return path;
    }
    for (const next of adjacentRoads(state, cur.x, cur.y)) {
      if (prev.has(key(next))) continue;
      prev.set(key(next), cur);
      queue.push(next);
    }
  }
  return null;
}

function tilesOfKind(state, kind) {
  const out = [];
  state.tiles.forEach((k, i) => {
    if (k === kind) out.push({ x: i % state.width, y: Math.floor(i / state.width) });
  });
  return out;
}

function pickRoute(state, rng) {
  const shops = tilesOfKind(state, 'shop');
  const routesByHouse = tilesOfKind(state, 'house')
    .map((house) => shops.map((shop) => findPath(state, house, shop)).filter(Boolean))
    .filter((routes) => routes.length > 0);
  if (routesByHouse.length === 0) return null;
  const routes = routesByHouse[Math.floor(rng() * routesByHouse.length)];
  return routes[Math.floor(rng() * routes.length)];
}

function advance(car, dt) {
  let { index, progress } = car;
  progress += CAR_SPEED * dt;
  while (progress >= 1 && index < car.path.length - 1) {
    index++;
    progress -= 1;
  }
  return { ...car, index, progress };
}

export function tick(state, dt, rng = Math.random) {
  const moved = state.cars.map((car) => advance(car, dt));
  const cars = moved.filter((car) => car.index < car.path.length - 1);
  const arrived = moved.length - cars.length;
  let next = {
    ...state,
    cars,
    delivered: state.delivered + arrived,
    money: state.money + arrived * DELIVERY_REWARD,
    spawnTimer: state.spawnTimer + dt,
  };

  if (next.spawnTimer >= SPAWN_INTERVAL) {
    next.spawnTimer -= SPAWN_INTERVAL;
    const path = next.cars.length < MAX_CARS && pickRoute(next, rng);
    if (path) {
      next = {
        ...next,
        cars: [...next.cars, { id: next.nextCarId, path, index: 0, progress: 0 }],
        nextCarId: next.nextCarId + 1,
      };
    }
  }
  return next;
}
