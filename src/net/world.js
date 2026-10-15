import { emptyNetwork, apply, nearestNode } from './network.js';
import { mulberry32 } from './sim.js';

export const TOWNS = [
  { name: 'Ashford', color: 0x5b9bd5, x: -620, z: -330 },
  { name: 'Brookvale', color: 0xf0a04b, x: -560, z: 420 },
  { name: 'Cedar Hill', color: 0xe06c9f, x: 620, z: -760 },
  { name: 'Dunmore', color: 0x8c6bb1, x: 820, z: 300 },
  { name: 'Elmstead', color: 0x45b07a, x: -80, z: 960 },
];

const BLOCK = 70;
const GATE = 110;

function townStreets(net, town) {
  const grid = [-1, 0, 1].map(v => v * BLOCK);
  const at = (i, j) => [town.x + grid[i], town.z + grid[j]];
  const anchor = (x, z) => {
    const n = nearestNode(net, x, z, 0.5);
    return n ? { kind: 'node', id: n.id } : { kind: 'free', x, z };
  };
  const street = (p, q, profile = 'street') => {
    const r = apply(net, { type: 'build', from: anchor(p[0], p[1]), to: anchor(q[0], q[1]), ctrl: null, profile });
    if (r.error) throw new Error(`world: ${town.name} ${r.error.reason}`);
    net = r.net;
  };
  for (let j = 0; j < 3; j++) for (let i = 0; i < 2; i++) street(at(i, j), at(i + 1, j));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) street(at(i, j), at(i, j + 1));
  const toward = Math.abs(town.x) > Math.abs(town.z) ? [-Math.sign(town.x), 0] : [0, -Math.sign(town.z)];
  const edge = [town.x + toward[0] * BLOCK, town.z + toward[1] * BLOCK];
  const gate = [edge[0] + toward[0] * GATE, edge[1] + toward[1] * GATE];
  street(edge, gate, 'avenue');
  return { net, gate };
}

function buildings(town, gate, rng) {
  const out = [];
  const clearOfGate = b => {
    const half = Math.hypot(b.w, b.d) / 2 + 6, k = BLOCK / (BLOCK + GATE);
    const edge = [town.x + (gate[0] - town.x) * k, town.z + (gate[1] - town.z) * k];
    const minX = Math.min(edge[0], gate[0]) - half, maxX = Math.max(edge[0], gate[0]) + half;
    const minZ = Math.min(edge[1], gate[1]) - half, maxZ = Math.max(edge[1], gate[1]) + half;
    return !(b.x > minX && b.x < maxX && b.z > minZ && b.z < maxZ);
  };
  for (let bi = 0; bi < 4; bi++) for (let bj = 0; bj < 4; bj++) {
    const cx = town.x + (bi - 1.5) * BLOCK, cz = town.z + (bj - 1.5) * BLOCK;
    const outer = bi === 0 || bi === 3 || bj === 0 || bj === 3;
    const count = outer ? 2 : 4;
    for (let k = 0; k < count; k++) {
      const ox = (k % 2 ? 1 : -1) * 15, oz = (k < 2 ? -1 : 1) * 15;
      const w = 14 + rng() * 10, d = 14 + rng() * 10;
      const h = outer ? 6 + rng() * 6 : 9 + rng() * (bi + bj === 3 ? 34 : 18);
      const b = { x: cx + ox * (outer ? 0.8 : 1), z: cz + oz * (outer ? 0.8 : 1), w, d, h, rot: (rng() - 0.5) * 0.1 };
      if (clearOfGate(b)) out.push(b);
    }
  }
  return out;
}

export function createWorld(seed = 7) {
  const rng = mulberry32(seed);
  let net = emptyNetwork();
  const towns = TOWNS.map(t => {
    const r = townStreets(net, t);
    net = r.net;
    return { ...t, r: 50, gate: { x: r.gate[0], z: r.gate[1] }, buildings: buildings(t, r.gate, rng) };
  });
  return { net, towns };
}
