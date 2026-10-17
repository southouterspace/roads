import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeRoute, BRIDGE_CLEARANCE } from '../src/net/bridge.js';
import { emptyNetwork, apply, chainActions } from '../src/net/network.js';
import { segmentPath, structureAt, classifyNode } from '../src/net/derive.js';
import { isWater, riverX, WATER_LEVEL } from '../src/net/terrain.js';
import { profile } from '../src/net/profiles.js';

const z = 0, river = riverX(z);
const straight = (a, b) => [{ from: a, to: b, ctrl: null, profile: 'street', profileB: 'street' }];

function twoEndsAcrossRiver(gap) {
  let net = emptyNetwork();
  const left = [river - 34 - gap, z], right = [river + 34 + gap, z];
  net = apply(net, { type: 'build', from: { kind: 'free', x: left[0] - 80, z }, to: { kind: 'free', x: left[0], z }, profile: 'street', liftFrom: 0, liftTo: 0 }).net;
  net = apply(net, { type: 'build', from: { kind: 'free', x: right[0] + 80, z }, to: { kind: 'free', x: right[0], z }, profile: 'street', liftFrom: 0, liftTo: 0 }).net;
  const id = p => [...net.nodes.values()].find(n => Math.abs(n.x - p[0]) < 1e-6).id;
  return { net, left, right, a: id(left), b: id(right) };
}

test('a route on dry land keeps the default heights', () => {
  const r = bridgeRoute(straight([-600, 0], [-400, 0]), { liftA: 0, liftB: 0, maxGrade: 0.1 });
  assert.equal(r.lifts, null);
  assert.equal(r.pieces.length, 1);
});

test('a ground-level connection across the river builds a bridge with ramps inside the grade limit', () => {
  const { net, left, right, a, b } = twoEndsAcrossRiver(120);
  const plan = bridgeRoute(straight(left, right), { liftA: 0, liftB: 0, maxGrade: profile('street').maxGrade });
  assert.ok(plan.pieces.length >= 3, `${plan.pieces.length} pieces`);
  const r = apply(net, { type: 'chain', pieces: plan.pieces, lifts: plan.lifts, fromNode: a, toNode: b });
  assert.equal(r.error, undefined);
  let wet = 0, maxGrade = 0;
  for (const id of r.built.segments) {
    const pts = segmentPath(r.net, r.net.segments.get(id)).pts;
    for (let i = 0; i < pts.length; i++) {
      if (isWater(pts[i].x, pts[i].z)) {
        wet++;
        assert.equal(structureAt(pts[i]), 'bridge');
        assert.ok(pts[i].y >= WATER_LEVEL + BRIDGE_CLEARANCE - 1e-6, `deck ${pts[i].y} over water`);
      }
      const j = Math.min(pts.length - 1, i + 5);
      if (j > i && pts[i].lift > 0) maxGrade = Math.max(maxGrade, Math.abs(pts[j].y - pts[i].y) / (pts[j].s - pts[i].s));
    }
  }
  assert.ok(wet > 20, `${wet} deck points over water`);
  assert.ok(maxGrade <= profile('street').maxGrade, `grade ${maxGrade}`);
  assert.equal(classifyNode(r.net, r.net.nodes.get(a)).kind, 'continue');
});

test('without the bridge plan the same connection is refused at the water', () => {
  const { net, left, right, a, b } = twoEndsAcrossRiver(120);
  const r = apply(net, { type: 'chain', pieces: straight(left, right), fromNode: a, toNode: b });
  assert.equal(r.error.reason, 'water');
});

test('ends too close to the bank to ramp up are refused with shore', () => {
  const { left, right } = twoEndsAcrossRiver(3);
  assert.deepEqual(bridgeRoute(straight(left, right), { liftA: 0, liftB: 0, maxGrade: 0.1 }), { reason: 'shore' });
});

test('ends already raised above the deck cross with no ramps', () => {
  const { left, right } = twoEndsAcrossRiver(3);
  const plan = bridgeRoute(straight(left, right), { liftA: 7.5, liftB: 7.5, maxGrade: 0.1 });
  assert.equal(plan.pieces.length, 1, 'one raised span from bank to bank');
  assert.deepEqual(plan.lifts, [7.5, 7.5]);
});
