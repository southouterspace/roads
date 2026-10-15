export const WORLD = 2400;
export const HALF = WORLD / 2;
export const WATER_LEVEL = 1;
export const RIVER_HALF_WIDTH = 34;

const SEED = 1337;

function hash(i, j) {
  let h = (i * 374761393 + j * 668265263 + SEED * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x, z) {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export const riverX = z => 140 + 230 * Math.sin(z / 520) + 70 * Math.sin(z / 190 + 1.3);

const riverDistance = (x, z) => Math.abs(x - riverX(z));

export const isWater = (x, z) => riverDistance(x, z) < RIVER_HALF_WIDTH;

function hills(x, z) {
  return 2 + 26 * (0.75 * valueNoise(x / 700 + 11.3, z / 700 - 4.1) + 0.25 * valueNoise(x / 220 - 7.7, z / 220 + 2.9));
}

// Land and riverbed height. Roads use surfaceAt, which treats the river surface as the ground.
export function heightAt(x, z) {
  const d = riverDistance(x, z);
  if (d < RIVER_HALF_WIDTH) {
    const k = d / RIVER_HALF_WIDTH;
    return WATER_LEVEL - 0.3 - 2.2 * (1 - k * k);
  }
  const bank = WATER_LEVEL + 0.4, h = hills(x, z), t = Math.min(1, (d - RIVER_HALF_WIDTH) / 160);
  return bank + (h - bank) * t * t * (3 - 2 * t);
}

export const surfaceAt = (x, z) => Math.max(heightAt(x, z), WATER_LEVEL);

export const inWorld = (x, z) => Math.abs(x) <= HALF && Math.abs(z) <= HALF;
