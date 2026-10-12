import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossroads, signalAvenue, grid } from '../src/presets.js';
import { simulate } from '../scripts/compare.mjs';

test('at 300 trips/min the single unsignalled crossroads grades worse than avenues+signal or a grid', (t) => {
  const results = { crossroads: simulate(crossroads, 300), signalAvenue: simulate(signalAvenue, 300), grid: simulate(grid, 300) };
  for (const [name, m] of Object.entries(results)) {
    t.diagnostic(`${name}: grade ${m.grade}, delay ${m.delayRatio.toFixed(2)}, active ${m.active}, waiting ${m.waiting}, ` +
      `${m.perMinute.toFixed(0)}/min arrived, ${m.abandoned} abandoned`);
  }
  assert.deepEqual(Object.values(results).map((m) => m.grade), ['F', 'A', 'B']);
  // The crossroads box passes about 3 cars/s, so arrivals plateau near 180/min whatever the demand.
  assert.equal(Math.round(results.crossroads.perMinute), 178);
});
