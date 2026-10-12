// Runs every preset at the same demand with a seeded rng and prints its metrics.
// Usage: node scripts/compare.mjs [tripsPerMinute ...] (default 60 300 600)
import { createState, apply, tick, metrics, STEP } from '../src/sim.js';
import { PRESETS } from '../src/presets.js';
import { seeded } from '../src/rng.js';

export function simulate(build, tripsPerMinute, seconds = 300, seed = 7) {
  let s = apply(build(createState(96, 64)), { type: 'demand', tripsPerMinute });
  const rng = seeded(seed);
  for (let t = 0; t < Math.round(seconds / STEP); t++) s = tick(s, rng);
  return metrics(s);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const demands = process.argv.slice(2).map(Number);
  for (const demand of demands.length ? demands : [60, 300, 600]) {
    console.log(`\n${demand} trips/min, 300 sim s, seed 7`);
    console.log('preset        grade  delay  active  waiting  arrived/min  abandoned');
    for (const [name, { build }] of Object.entries(PRESETS)) {
      const m = simulate(build, demand);
      console.log(
        `${name.padEnd(13)} ${m.grade.padEnd(6)} ${m.delayRatio.toFixed(2).padStart(5)}` +
          ` ${String(m.active).padStart(7)} ${String(m.waiting).padStart(8)}` +
          ` ${m.perMinute.toFixed(0).padStart(12)} ${String(m.abandoned).padStart(10)}`,
      );
    }
  }
}
