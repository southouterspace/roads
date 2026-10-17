import * as G from './geometry.js';
import { surfaceAt, isWater, WATER_LEVEL } from './terrain.js';

// HeightPlan { pieces, lifts: number[] | null } | { reason: 'shore' }
//   lifts has one entry per joint (pieces.length + 1); null keeps the default blend between the end heights.

export const BRIDGE_CLEARANCE = 5;
const BANK_MARGIN = 6;
const MERGE_GAP = 60;
// Each segment eases its height with a smoothstep, whose steepest point is 1.5 times its average grade.
const GRADE_USE = 0.6;
const MIN_PIECE = 2;
const SAMPLE = 1;

function routeOf(pieces) {
  let offset = 0;
  return pieces.map(p => {
    const cv = G.curve(p.from, p.ctrl, p.to);
    const samples = G.arcSamples(cv, SAMPLE);
    const len = samples.at(-1).s;
    const r = { piece: p, cv, samples, start: offset, len };
    offset += len;
    return r;
  });
}

function tAt(r, s) {
  const sm = r.samples;
  let i = 0;
  while (i < sm.length - 2 && sm[i + 1].s < s) i++;
  const a = sm[i], b = sm[i + 1];
  return a.t + (b.t - a.t) * G.clamp((s - a.s) / ((b.s - a.s) || 1), 0, 1);
}

function pointAt(route, s) {
  const r = route.find(q => s <= q.start + q.len) || route.at(-1);
  return G.bezier(r.cv, tAt(r, s - r.start));
}

function waterSpans(route) {
  const spans = [];
  for (const r of route) {
    for (const q of r.samples) {
      if (!isWater(q.p[0], q.p[1])) continue;
      const s = r.start + q.s, last = spans.at(-1);
      if (last && s - last[1] < MERGE_GAP) last[1] = s;
      else spans.push([s, s]);
    }
  }
  return spans;
}

// Where a ramp at grade g from the ground must start (or end, dir = +1) to reach deckY at sDeck.
function rampFoot(route, sDeck, deckY, g, dir) {
  const total = route.at(-1).start + route.at(-1).len;
  for (let d = 1; ; d += 1) {
    const s = sDeck + dir * d;
    if (s <= 0 || s >= total) return s;
    const p = pointAt(route, s);
    if (deckY - surfaceAt(p[0], p[1]) <= g * d) return s;
  }
}

// Keys of a height profile along the route: { s, y, ground } where ground means the road sits on the terrain there.
function profileKeys(route, spans, ends, g) {
  const total = route.at(-1).start + route.at(-1).len;
  const deckY = WATER_LEVEL + BRIDGE_CLEARANCE;
  const keys = [{ s: 0, y: ends.yA, ground: ends.liftA === 0 }];
  const tooSteep = (a, b) => Math.abs(b.y - a.y) / Math.max(b.s - a.s, 1e-6) > g;
  for (let i = 0; i < spans.length; i++) {
    const bs = Math.max(0, spans[i][0] - BANK_MARGIN), be = Math.min(total, spans[i][1] + BANK_MARGIN);
    const prev = keys.at(-1), deckIn = { s: bs, y: deckY, ground: false };
    if (bs <= prev.s + MIN_PIECE) {
      if (prev.y < deckY - 0.5) return null;
    } else {
      const foot = prev.ground && prev.y < deckY ? rampFoot(route, bs, deckY, g, -1) : null;
      if (foot !== null && foot > prev.s + MIN_PIECE) {
        const p = pointAt(route, foot);
        keys.push({ s: foot, y: surfaceAt(p[0], p[1]), ground: true });
      } else if (tooSteep(prev, deckIn)) return null;
      keys.push(deckIn);
    }
    if (be >= total - MIN_PIECE) {
      if (ends.yB < deckY - 0.5) return null;
      break;
    }
    keys.push({ s: be, y: deckY, ground: false });
    const next = i + 1 < spans.length ? Math.max(0, spans[i + 1][0] - BANK_MARGIN) : total;
    const lastSpan = i + 1 === spans.length;
    if (lastSpan && ends.liftB !== 0) continue;
    const footOut = rampFoot(route, be, deckY, g, 1);
    if (footOut < next - MIN_PIECE) {
      const p = pointAt(route, footOut);
      keys.push({ s: footOut, y: surfaceAt(p[0], p[1]), ground: true });
    }
  }
  const end = { s: total, y: ends.yB, ground: ends.liftB === 0 };
  if (tooSteep(keys.at(-1), end) && !(keys.at(-1).ground && end.ground)) return null;
  keys.push(end);
  return keys;
}

function liftAt(keys, s, point) {
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].s < s) i++;
  const a = keys[i], b = keys[i + 1];
  if (a.ground && b.ground) return 0;
  const y = a.y + (b.y - a.y) * G.clamp((s - a.s) / ((b.s - a.s) || 1), 0, 1);
  return Math.max(0, y - surfaceAt(point[0], point[1]));
}

function splitPieces(route, cuts) {
  const out = [];
  for (const r of route) {
    const local = cuts.map(s => s - r.start).filter(s => s > MIN_PIECE && s < r.len - MIN_PIECE);
    let rest = r.cv, done = 0;
    const halves = [];
    for (const s of local) {
      const t = tAt(r, s);
      const [head, tail] = G.splitCurve(rest, (t - done) / (1 - done));
      halves.push(head);
      rest = tail;
      done = t;
    }
    halves.push(rest);
    const { profile, profileB } = r.piece;
    halves.forEach((h, i) => {
      const last = i === halves.length - 1;
      out.push({ from: h.p0, to: h.p2, ctrl: r.piece.ctrl ? h.c : null, profile, profileB: last ? profileB : profile });
    });
  }
  return out;
}

// Raises the parts of a route that cross water to a bridge deck, with ramps inside the grade limit.
export function bridgeRoute(pieces, { liftA, liftB, maxGrade }) {
  const route = routeOf(pieces);
  const spans = waterSpans(route);
  if (!spans.length) return { pieces, lifts: null };
  const A = pieces[0].from, B = pieces.at(-1).to;
  const ends = { liftA, liftB, yA: surfaceAt(A[0], A[1]) + liftA, yB: surfaceAt(B[0], B[1]) + liftB };
  const keys = profileKeys(route, spans, ends, maxGrade * GRADE_USE);
  if (!keys) return { reason: 'shore' };
  const split = splitPieces(route, keys.slice(1, -1).map(k => k.s));
  const splitRoute = routeOf(split);
  const lifts = [liftA];
  for (const r of splitRoute.slice(0, -1)) lifts.push(liftAt(keys, r.start + r.len, r.piece.to));
  lifts.push(liftB);
  return { pieces: split, lifts };
}
