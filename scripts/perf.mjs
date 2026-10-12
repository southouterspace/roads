// Fills the full-map city preset to about 1500 active cars, then times 600 ticks.
import { createState, apply, tick, STEP, REROUTE_EVERY } from '../src/sim.js';
import { city } from '../src/presets.js';
import { seeded } from '../src/rng.js';

const TARGET = 1500;
const rng = seeded(1);
let s = apply(city(createState(96, 64)), { type: 'demand', tripsPerMinute: 3000 });
while (s.cars.length < TARGET) s = tick(s, rng);
console.log(`filled to ${s.cars.length} cars at ${s.time.toFixed(1)} sim s`);

const times = [];
let routed = 0;
for (let i = 0; i < 600; i++) {
  const t0 = performance.now();
  const next = tick(s, rng);
  times.push(performance.now() - t0);
  if (next.routedAt !== s.routedAt) routed++;
  s = next;
}
times.sort((a, b) => a - b);
const pct = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(3);
console.log(`cars at end: ${s.cars.length}`);
console.log(`ms per tick over 600 ticks: median ${pct(0.5)}, p90 ${pct(0.9)}, max ${pct(1)}`);
console.log(`${routed} of the 600 ticks rebuilt the routing tree (every ${REROUTE_EVERY / STEP} ticks)`);
console.log(`8x speed at 60 fps runs 8 ticks per frame: about ${(pct(0.5) * 8).toFixed(1)} ms of sim per frame`);
