import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, apply, tick, metrics, index, greenAxis, STEP } from '../src/sim.js';
import { seeded } from '../src/rng.js';

const E = 1;
const W = 3;

function line(s, kind, x0, y0, x1, y1) {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) s = apply(s, { type: 'build', kind, x, y });
  return s;
}

function run(s, seconds, rng, each = () => {}) {
  for (let t = 0; t < Math.round(seconds / STEP); t++) {
    const prev = s;
    s = tick(s, rng);
    each(s, prev);
  }
  return s;
}

function countByPool(s, tile) {
  const by = [0, 0, 0, 0];
  for (const car of s.cars) if (car.tile === tile) by[car.dir]++;
  return by;
}

test('building is free, rejects occupied tiles, and returns the same state when nothing changes', () => {
  const s = line(createState(10, 10), 'street', 0, 0, 3, 0);
  assert.equal(s.kind[index(s, 3, 0)], 1);
  assert.equal(apply(s, { type: 'build', kind: 'house', x: 1, y: 0 }), s);
  assert.equal(apply(s, { type: 'build', kind: 'street', x: 10, y: 0 }), s);
  const avenue = apply(s, { type: 'build', kind: 'avenue', x: 1, y: 0 });
  assert.equal(avenue.kind[index(s, 1, 0)], 2);
  assert.equal(apply(avenue, { type: 'bulldoze', x: 1, y: 0 }).kind[index(s, 1, 0)], 0);
});

test('a one-lane street tile holds one car per direction, and opposing directions pass each other', () => {
  // Kerb (4,0) sits between two approaches: eastbound from house (1,1), westbound from house (7,1).
  let s = line(createState(9, 2), 'street', 0, 0, 8, 0);
  s = apply(s, { type: 'build', kind: 'shop', x: 4, y: 1 });
  s = apply(s, { type: 'build', kind: 'house', x: 1, y: 1 });
  s = apply(s, { type: 'build', kind: 'house', x: 7, y: 1 });
  s = apply(s, { type: 'demand', tripsPerMinute: 1200 });
  const kerb = index(s, 4, 0);
  let maxPerPool = 0;
  let bothWays = 0;
  s = run(s, 60, seeded(1), (now) => {
    for (let t = 0; t < now.kind.length; t++) maxPerPool = Math.max(maxPerPool, ...countByPool(now, t));
    const at = countByPool(now, kerb);
    if (at[E] && at[W]) bothWays++;
  });
  assert.equal(maxPerPool, 1);
  assert.equal(bothWays, 3535);
  // Two lanes at 3 tiles/s each, so close to 360 trips per minute, against 1200 offered.
  assert.equal(s.stats.arrivals, 352);
  assert.equal(metrics(s).grade, 'F');
});

test('cars never drive against a one-way arrow and route around it', () => {
  // Straight street (1..9, 2) to a shop at (10,2); (5,2) points west, so trips detour over y=0.
  let s = line(createState(11, 3), 'street', 1, 2, 9, 2);
  s = line(s, 'street', 3, 0, 7, 0);
  s = line(s, 'street', 3, 1, 3, 1);
  s = line(s, 'street', 7, 1, 7, 1);
  s = apply(s, { type: 'build', kind: 'house', x: 0, y: 2 });
  s = apply(s, { type: 'build', kind: 'shop', x: 10, y: 2 });
  s = apply(s, { type: 'oneway', x: 5, y: 2, dir: W });
  s = apply(s, { type: 'demand', tripsPerMinute: 60 });
  s = tick(s, seeded(2));
  assert.equal(s.next[index(s, 3, 2)], index(s, 3, 1));
  assert.equal(s.next[index(s, 4, 2)], index(s, 3, 2));

  const oneway = index(s, 5, 2);
  let againstArrow = 0;
  let onDetour = 0;
  s = run(s, 60, seeded(2), (now) => {
    for (const car of now.cars) {
      if (car.tile === oneway && car.dir === E) againstArrow++;
      if (car.tile === index(s, 5, 0)) onDetour++;
    }
  });
  assert.equal(againstArrow, 0);
  assert.ok(onDetour > 0);
  assert.equal(s.stats.arrivals, 55);
  assert.equal(metrics(s).grade, 'A');
});

function crossing(signal) {
  // Plus-shaped crossing at (5,5): houses feed the west and north arms, shops sit past the east and south arms.
  let s = line(createState(12, 12), 'street', 0, 5, 10, 5);
  s = line(s, 'street', 5, 0, 5, 10);
  s = apply(s, { type: 'build', kind: 'house', x: 0, y: 4 });
  s = apply(s, { type: 'build', kind: 'house', x: 4, y: 0 });
  s = apply(s, { type: 'build', kind: 'shop', x: 11, y: 5 });
  s = apply(s, { type: 'build', kind: 'shop', x: 5, y: 11 });
  if (signal) s = apply(s, { type: 'signal', x: 5, y: 5 });
  return apply(s, { type: 'demand', tripsPerMinute: 600 });
}

test('an unsignalled intersection holds one car at a time', () => {
  let s = crossing(false);
  const box = index(s, 5, 5);
  let most = 0;
  s = run(s, 60, seeded(3), (now) => {
    most = Math.max(most, now.cars.filter((car) => car.tile === box).length);
  });
  assert.equal(most, 1);
  assert.equal(s.stats.arrivals, 171);
});

test('a signalled intersection admits only the green axis', () => {
  let s = crossing(true);
  const box = index(s, 5, 5);
  const enteredOn = [0, 0];
  let wrongAxis = 0;
  s = run(s, 60, seeded(3), (now, prev) => {
    const before = new Map(prev.cars.map((car) => [car.id, car.tile]));
    for (const car of now.cars) {
      if (car.tile !== box || before.get(car.id) === box) continue;
      enteredOn[car.dir & 1]++;
      if ((car.dir & 1) !== greenAxis(prev.time)) wrongAxis++;
    }
  });
  assert.equal(wrongAxis, 0);
  assert.deepEqual(enteredOn, [85, 89]);
  assert.equal(s.stats.arrivals, 168);
});

function forkedRoute() {
  // From the branch (1,3): a 2.7 s street straight east, or a 2.0 s avenue loop over y=0 with one street tile at (6,0).
  let s = createState(11, 5);
  s = apply(s, { type: 'build', kind: 'house', x: 0, y: 3 });
  s = line(s, 'avenue', 1, 3, 1, 3);
  s = line(s, 'street', 2, 3, 9, 3);
  s = apply(s, { type: 'build', kind: 'shop', x: 10, y: 3 });
  s = line(s, 'avenue', 1, 0, 1, 2);
  s = line(s, 'avenue', 2, 0, 9, 0);
  s = apply(s, { type: 'build', kind: 'street', x: 6, y: 0 });
  return apply(s, { type: 'build', kind: 'shop', x: 10, y: 0 });
}

test('routing prefers the faster avenue over a shorter street', () => {
  const s = tick(forkedRoute(), seeded(4));
  assert.equal(s.next[index(s, 1, 3)], index(s, 1, 2));
});

test('when the avenue jams at its narrow tile, a refresh sends trips down the street bypass', () => {
  let s = apply(forkedRoute(), { type: 'demand', tripsPerMinute: 600 });
  const branch = index(s, 1, 3);
  let flippedAt = null;
  s = run(s, 60, seeded(4), (now) => {
    if (flippedAt === null && now.next[branch] === index(s, 2, 3)) flippedAt = Math.round(now.time);
  });
  assert.equal(flippedAt, 4);
});
