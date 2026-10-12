import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, apply, roadMask, findPath, tick, tileAt } from '../src/sim.js';

function build(state, kind, cells) {
  return cells.reduce((s, [x, y]) => apply(s, { type: 'build', kind, x, y }), state);
}

test('building a road deducts 10 money', () => {
  const s = apply(createState(), { type: 'build', kind: 'road', x: 3, y: 4 });
  assert.equal(s.money, 490);
  assert.equal(tileAt(s, 3, 4), 'road');
});

test('building without enough money leaves state unchanged', () => {
  const poor = { ...createState(), money: 40 };
  assert.equal(apply(poor, { type: 'build', kind: 'house', x: 0, y: 0 }), poor);
  assert.equal(apply(poor, { type: 'build', kind: 'road', x: 0, y: 0 }).money, 30);
});

test('building out of bounds or on an occupied tile leaves state unchanged', () => {
  const s = build(createState(), 'road', [[0, 0]]);
  assert.equal(apply(s, { type: 'build', kind: 'road', x: 20, y: 0 }), s);
  assert.equal(apply(s, { type: 'build', kind: 'shop', x: 0, y: 0 }), s);
});

test('bulldoze refunds half the cost', () => {
  const s = build(createState(), 'shop', [[2, 2]]);
  const after = apply(s, { type: 'bulldoze', x: 2, y: 2 });
  assert.equal(after.money, 450);
  assert.equal(tileAt(after, 2, 2), 'grass');
});

test('roadMask on a T-junction', () => {
  const s = build(createState(), 'road', [[0, 1], [1, 1], [2, 1], [1, 2]]);
  assert.equal(roadMask(s, 1, 1), 14);
  const withHouse = build(s, 'house', [[1, 0]]);
  assert.equal(roadMask(withHouse, 1, 1), 15);
});

function lLayout() {
  let s = build(createState(), 'house', [[0, 0]]);
  s = build(s, 'road', [[1, 0], [1, 1], [1, 2], [2, 2]]);
  return build(s, 'shop', [[3, 2]]);
}

test('findPath follows roads from house to shop', () => {
  assert.deepEqual(findPath(lLayout(), { x: 0, y: 0 }, { x: 3, y: 2 }), [
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 1, y: 2 },
    { x: 2, y: 2 },
  ]);
});

test('findPath returns null when the roads are disconnected', () => {
  const s = apply(lLayout(), { type: 'bulldoze', x: 1, y: 1 });
  assert.equal(findPath(s, { x: 0, y: 0 }, { x: 3, y: 2 }), null);
});

function straightLayout() {
  let s = build(createState(), 'house', [[0, 0]]);
  s = build(s, 'road', [[1, 0], [2, 0], [3, 0]]);
  return build(s, 'shop', [[4, 0]]);
}

test('a car spawns, drives to the shop, and pays on delivery', () => {
  const rng = () => 0;
  let s = straightLayout();
  assert.equal(s.money, 320);

  s = tick(s, 1.5, rng);
  assert.deepEqual(s.cars, [
    { id: 1, path: [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }], index: 0, progress: 0 },
  ]);

  s = tick(s, 1, rng);
  assert.deepEqual(s.cars, []);
  assert.equal(s.delivered, 1);
  assert.equal(s.money, 335);
});

test('no car spawns when no shop is reachable', () => {
  const s = tick(apply(straightLayout(), { type: 'bulldoze', x: 2, y: 0 }), 1.5, () => 0);
  assert.deepEqual(s.cars, []);
});

test('bulldozing a road removes cars routed across it', () => {
  const s = tick(straightLayout(), 1.5, () => 0);
  const after = apply(s, { type: 'bulldoze', x: 2, y: 0 });
  assert.deepEqual(after.cars, []);
  assert.equal(after.money, 325);
});
