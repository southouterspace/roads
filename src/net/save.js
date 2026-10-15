import { PROFILES } from './profiles.js';
import { HALF } from './terrain.js';
import { CONTROLS, MAX_LIFT } from './network.js';

export const VERSION = 3;
export const MAX_ITEMS = 20000;
const BOUND = HALF + 50;

const round = v => Math.round(v * 1000) / 1000;

export function save(net) {
  return {
    v: VERSION,
    nextId: net.nextId,
    nodes: [...net.nodes.values()].map(n => [n.id, round(n.x), round(n.z), round(n.lift), n.control]),
    segments: [...net.segments.values()].map(s => [s.id, s.a, s.b, s.ctrl ? [round(s.ctrl[0]), round(s.ctrl[1])] : null, s.profileA, s.profileB]),
  };
}

export const serialize = net => JSON.stringify(save(net));

const isId = v => Number.isInteger(v) && v > 0;
const coord = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= BOUND;

// The only way a map enters the game or the share API. Returns { net } or { error }.
export function parse(input) {
  let data = input;
  if (typeof input === 'string') {
    try { data = JSON.parse(input); } catch { return { error: 'invalid JSON' }; }
  }
  if (!data || typeof data !== 'object' || data.v !== VERSION) return { error: 'unsupported version' };
  const { nodes, segments, nextId } = data;
  if (!Array.isArray(nodes) || !Array.isArray(segments) || !isId(nextId)) return { error: 'missing fields' };
  if (nodes.length > MAX_ITEMS || segments.length > MAX_ITEMS) return { error: 'map too large' };
  const net = { nodes: new Map(), segments: new Map(), nextId };
  for (const n of nodes) {
    if (!Array.isArray(n) || n.length !== 5) return { error: 'bad node' };
    const [id, x, z, lift, control] = n;
    if (!isId(id) || id >= nextId || net.nodes.has(id)) return { error: 'bad node id' };
    if (!coord(x) || !coord(z) || typeof lift !== 'number' || !(lift >= 0 && lift <= MAX_LIFT)) return { error: 'bad node position' };
    if (!CONTROLS.includes(control)) return { error: 'bad node control' };
    net.nodes.set(id, { id, x, z, lift, control });
  }
  const used = new Set();
  for (const s of segments) {
    if (!Array.isArray(s) || s.length !== 6) return { error: 'bad segment' };
    const [id, a, b, ctrl, profileA, profileB] = s;
    if (!isId(id) || id >= nextId || net.segments.has(id) || net.nodes.has(id)) return { error: 'bad segment id' };
    if (!net.nodes.has(a) || !net.nodes.has(b) || a === b) return { error: 'bad segment ends' };
    if (ctrl !== null && !(Array.isArray(ctrl) && ctrl.length === 2 && coord(ctrl[0]) && coord(ctrl[1]))) return { error: 'bad control point' };
    if (!PROFILES.has(profileA) || !PROFILES.has(profileB)) return { error: 'bad profile' };
    net.segments.set(id, { id, a, b, ctrl: ctrl ? [ctrl[0], ctrl[1]] : null, profileA, profileB });
    used.add(a);
    used.add(b);
  }
  for (const id of net.nodes.keys()) if (!used.has(id)) return { error: 'orphan node' };
  return { net };
}
