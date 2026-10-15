import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyNetwork, apply } from '../src/net/network.js';
import { createSim, tick, mulberry32 } from '../src/net/sim.js';

const free = (x, z) => ({ kind: 'free', x, z });

function scenario() {
  let net = emptyNetwork();
  const run = action => {
    const r = apply(net, action);
    assert.equal(r.error, undefined, `${action.type} refused: ${r.error && r.error.reason}`);
    net = r.net;
  };
  const at = (x, z) => {
    for (const n of net.nodes.values()) if (Math.hypot(n.x - x, n.z - z) < 0.5) return { kind: 'node', id: n.id };
    return free(x, z);
  };
  run({ type: 'divided', pair: 'div2', from: { x: -1000, z: -900 }, to: { x: -400, z: -900 }, ctrl: null });
  run({ type: 'build', from: free(-1100, -900), to: at(-1000, -892), ctrl: [-1040, -860], profile: 'ramp' });
  run({ type: 'build', from: at(-1000, -908), to: at(-1100, -900), ctrl: [-1040, -940], profile: 'ramp' });
  run({ type: 'build', from: at(-400, -892), to: free(-300, -900), ctrl: [-360, -860], profile: 'ramp' });
  run({ type: 'build', from: at(-300, -900), to: at(-400, -908), ctrl: [-360, -940], profile: 'ramp' });
  const east = [...net.segments.values()].find(s => s.profileA === 'hw2' && net.nodes.get(s.a).x < net.nodes.get(s.b).x);
  run({ type: 'build', from: { kind: 'segment', id: east.id, t: 0.5 }, to: free(-600, -820), profile: 'ramp' });
  return net;
}

test('cars reach every town over a highway with an off-ramp and nobody stays stuck', () => {
  const net = scenario();
  const towns = [
    { name: 'A', x: -1100, z: -900, r: 5 },
    { name: 'B', x: -300, z: -900, r: 5 },
    { name: 'C', x: -600, z: -820, r: 5 },
  ];
  const state = createSim(net, towns);
  const rng = mulberry32(42);
  for (let i = 0; i < 600 * 10; i++) tick(state, 0.1, rng);
  assert.ok(state.delivered.get('A') >= 1, `A got ${state.delivered.get('A')}`);
  assert.ok(state.delivered.get('B') >= 1, `B got ${state.delivered.get('B')}`);
  assert.ok(state.delivered.get('C') >= 1, `C got ${state.delivered.get('C')}`);
  assert.ok(state.maxWait < 120, `a car waited ${state.maxWait.toFixed(1)} s`);
});
