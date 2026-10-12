import { apply } from './sim.js';

function rect(s, kind, x0, y0, x1, y1) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) s = apply(s, { type: 'build', kind, x, y });
  return s;
}

// Two clusters of 12 houses each, one along the top edge and one down the left edge, and four shops
// to the south-east. Every layout below serves the same trips, so their grades compare directly.
function homesAndShops(s) {
  s = rect(s, 'house', 4, 0, 15, 0);
  s = rect(s, 'house', 0, 4, 0, 15);
  s = rect(s, 'shop', 26, 40, 27, 40);
  return rect(s, 'shop', 40, 26, 40, 27);
}

function crossing(s, road) {
  s = rect(s, road, 4, 1, 26, 1);
  s = rect(s, road, 26, 1, 26, 39);
  s = rect(s, road, 1, 4, 1, 26);
  return rect(s, road, 1, 26, 39, 26);
}

/** Bad: both feeders are streets that cross at one unsignalled box at (26,26). */
export function crossroads(s) {
  return homesAndShops(crossing(s, 'street'));
}

/** Same geometry with avenues and a signal at the crossing. */
export function signalAvenue(s) {
  return apply(homesAndShops(crossing(s, 'avenue')), { type: 'signal', x: 26, y: 26 });
}

/** Same homes and shops on a 4x4 street lattice, no signals: many crossings, each lightly loaded. */
export function grid(s) {
  for (const c of [1, 13, 26, 39]) {
    s = rect(s, 'street', c, 1, c, 39);
    s = rect(s, 'street', 1, c, 39, c);
  }
  return homesAndShops(s);
}

/** The whole map: a street grid with avenues every 16 tiles, homes everywhere, shops downtown in the east. */
export function city(s) {
  const lineAt = (v) => v % 4 === 2;
  const avenueAt = (v) => v % 16 === 2;
  for (let y = 2; y < s.height - 1; y++) {
    for (let x = 2; x < s.width - 1; x++) {
      if (!lineAt(x) && !lineAt(y)) continue;
      const kind = (lineAt(x) && avenueAt(x)) || (lineAt(y) && avenueAt(y)) ? 'avenue' : 'street';
      s = apply(s, { type: 'build', kind, x, y });
    }
  }
  const downtown = Math.floor(s.width * 0.72);
  for (let by = 3; by + 2 < s.height - 2; by += 4) {
    for (let bx = 3; bx + 2 < s.width - 2; bx += 4) {
      const kind = bx >= downtown ? 'shop' : 'house';
      for (let y = by; y <= by + 2; y++)
        for (let x = bx; x <= bx + 2; x++) if (x !== bx + 1 || y !== by + 1) s = apply(s, { type: 'build', kind, x, y });
    }
  }
  for (let y = 2; y < s.height - 1; y += 16)
    for (let x = 2; x < s.width - 1; x += 16) s = apply(s, { type: 'signal', x, y });
  return s;
}

export const PRESETS = {
  crossroads: { label: 'Crossroads (bad)', build: crossroads },
  signalAvenue: { label: 'Avenues + signal', build: signalAvenue },
  grid: { label: 'Street grid', build: grid },
  city: { label: 'City (full map)', build: city },
};
