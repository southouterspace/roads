import { profile, deckWidth } from './profiles.js';
import * as G from './geometry.js';
import { rawCentreline, centreline, incident, armsAt, CLEARANCE } from './derive.js';

export const MIN_LENGTH = 8;
export const MIN_PIECE = 4;
export const MIN_ANGLE = (20 * Math.PI) / 180;
const JOIN_TOLERANCE = 0.5;
const GORE_ZONE = 100;

export const REASON_TEXT = {
  tooShort: 'Too short',
  radius: 'Curve is too tight for this road',
  grade: 'Too steep for this road',
  clearance: 'Too close above or below another road (needs 5 m)',
  angle: 'Meets another road at too sharp an angle',
  water: 'Cannot build on water at ground level, raise it',
  overlap: 'Runs on top of another road',
};

const fail = (reason, p) => ({ reason, at: Array.isArray(p) ? p : [p.x, p.z] });

// A candidate is a segment that may not exist yet:
// { cv, ends: { liftA, liftB, yA, yB }, profileA, profileB, joints: [{ end, node, split, pos }], ignore: Set, autoJoin }
export function validate(net, cand) {
  const result = inspect(net, cand);
  return result.error || null;
}

export function inspect(net, cand) {
  const pA = profile(cand.profileA), pB = profile(cand.profileB);
  const raw = rawCentreline(cand.cv, cand.ends);
  const mid = G.bezier(cand.cv, 0.5);
  const done = error => ({ error, raw, joins: [] });

  const [j0, j1] = [cand.joints.find(j => j.end === 'start'), cand.joints.find(j => j.end === 'end')];
  if (raw.L < MIN_LENGTH) return done(fail('tooShort', mid));
  if (j0 && j1 && j0.node !== null && j0.node === j1.node) return done(fail('tooShort', mid));
  if (j0 && j1 && j0.split && j1.split && j0.split.seg === j1.split.seg) return done(fail('overlap', mid));
  if (j0 && j1 && j0.node !== null && j1.node !== null) {
    for (const s of incident(net, j0.node)) if ((s.a === j1.node || s.b === j1.node) && !cand.ignore.has(s.id)) return done(fail('overlap', mid));
  }

  if (G.minRadius(cand.cv) < Math.max(pA.minRadius, pB.minRadius)) return done(fail('radius', worstCurvePoint(cand.cv)));

  if (!(cand.ends.liftA === 0 && cand.ends.liftB === 0)) {
    const limit = Math.min(pA.maxGrade, pB.maxGrade) + 1e-9;
    const pts = raw.pts;
    for (let i = 0; i < pts.length; i++) {
      const j = Math.min(pts.length - 1, i + 5);
      if (j === i) continue;
      if (Math.abs(pts[j].y - pts[i].y) / (pts[j].s - pts[i].s) > limit) return done(fail('grade', pts[i]));
    }
  }

  for (const p of raw.pts) if (p.water && p.lift < 0.5) return done(fail('water', p));

  for (const j of cand.joints) {
    const away = j.end === 'start' ? G.bezierTangent(cand.cv, 0) : G.scale(G.bezierTangent(cand.cv, 1), -1);
    const newFlowsOut = j.end === 'start';
    const newOneWay = (j.end === 'start' ? pA : pB).oneWay;
    for (const arm of jointArms(net, j)) {
      if (cand.ignore.has(arm.seg)) continue;
      if (G.angleBetween(away, arm.away) >= MIN_ANGLE) continue;
      const armFlowsOut = arm.outCount > 0 && arm.inCount === 0;
      const armFlowsIn = arm.inCount > 0 && arm.outCount === 0;
      const gore = newOneWay && arm.oneWay && (newFlowsOut ? armFlowsOut : armFlowsIn);
      if (!gore) return done(fail('angle', j.pos));
    }
  }

  const width = Math.max(deckWidth(pA), deckWidth(pB));
  const joins = [];
  for (const seg of net.segments.values()) {
    if (cand.ignore.has(seg.id)) continue;
    const other = centreline(net, seg);
    const m = width / 2 + 12;
    const bb = other.bbox;
    if (!raw.pts.some(p => p.x > bb.x0 - m && p.x < bb.x1 + m && p.z > bb.z0 - m && p.z < bb.z1 + m)) continue;
    const shared = cand.joints.filter(j => (j.node !== null && (seg.a === j.node || seg.b === j.node)) || (j.split && j.split.seg === seg.id));
    const nearShared = p => shared.some(j => G.dist([p.x, p.z], j.pos) < 3);

    const hits = crossings(raw.pts, other.pts);
    for (const h of hits) {
      if (nearShared(h)) continue;
      const sep = Math.abs(h.yA - h.yB);
      if (sep >= CLEARANCE) continue;
      if (sep >= JOIN_TOLERANCE || !cand.autoJoin) return done(fail('clearance', h));
      if (G.angleBetween(h.tA, h.tB) < MIN_ANGLE || G.angleBetween(h.tA, h.tB) > Math.PI - MIN_ANGLE) return done(fail('angle', h));
      const a = net.nodes.get(seg.a), b = net.nodes.get(seg.b);
      const atNode = [a, b].find(n => G.dist([n.x, n.z], [h.x, h.z]) < 3);
      joins.push({ s: h.sA, x: h.x, z: h.z, y: (h.yA + h.yB) / 2, node: atNode ? atNode.id : null, seg: atNode ? null : seg.id, t: h.tParamB });
    }

    const otherWidth = deckWidth(profile(seg.profileA));
    const limit = (width + otherWidth) / 2 - 0.5;
    let run = 0;
    for (let i = 0; i < raw.pts.length; i++) {
      const p = raw.pts[i], q = raw.pts[Math.min(raw.pts.length - 1, i + 1)], o = raw.pts[Math.max(0, i - 1)];
      const inGore = shared.some(j => G.dist([p.x, p.z], j.pos) < GORE_ZONE);
      const near = !inGore && closeAlongside(p, G.norm([q.x - o.x, q.z - o.z]), other.pts, limit);
      run = near ? run + 1 : 0;
      if (run * 2 > 12) return done(fail('overlap', p));
    }
  }

  joins.sort((x, y) => x.s - y.s);
  const merged = [];
  for (const j of joins) {
    const prev = merged[merged.length - 1];
    if (prev && j.s - prev.s < 3) continue;
    merged.push(j);
  }
  const cuts = [0, ...merged.map(j => j.s), raw.L];
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i] - cuts[i - 1] < MIN_PIECE) return done(fail('tooShort', i - 1 < merged.length ? merged[Math.max(0, i - 1)] : mid));
  }
  return { error: null, raw, joins: merged };
}

function worstCurvePoint(cv) {
  let best = 0.5, bestR = Infinity;
  for (let i = 0; i <= 32; i++) {
    const t = i / 32, d = G.bezierDeriv(cv, t);
    const dd = [2 * (cv.p2[0] - 2 * cv.c[0] + cv.p0[0]), 2 * (cv.p2[1] - 2 * cv.c[1] + cv.p0[1])];
    const r = Math.pow(G.len(d), 3) / (Math.abs(G.cross(d, dd)) || 1e-12);
    if (r < bestR) { bestR = r; best = t; }
  }
  return G.bezier(cv, best);
}

function jointArms(net, j) {
  if (j.node !== null) return armsAt(net, j.node);
  const seg = net.segments.get(j.split.seg);
  const other = centreline(net, seg);
  const tan = G.bezierTangent(other.cv, j.split.t);
  const p = profile(seg.profileA);
  const oneWayCounts = p.oneWay;
  return [
    { seg: -1, away: G.scale(tan, -1), oneWay: oneWayCounts, inCount: p.lanesFwd, outCount: p.lanesBack },
    { seg: -2, away: tan, oneWay: oneWayCounts, inCount: p.lanesBack, outCount: p.lanesFwd },
  ];
}

function crossings(A, B) {
  const out = [];
  for (let i = 1; i < A.length; i++) {
    const a0 = A[i - 1], a1 = A[i];
    const ax0 = Math.min(a0.x, a1.x), ax1 = Math.max(a0.x, a1.x), az0 = Math.min(a0.z, a1.z), az1 = Math.max(a0.z, a1.z);
    for (let k = 1; k < B.length; k++) {
      const b0 = B[k - 1], b1 = B[k];
      if (Math.max(b0.x, b1.x) < ax0 || Math.min(b0.x, b1.x) > ax1 || Math.max(b0.z, b1.z) < az0 || Math.min(b0.z, b1.z) > az1) continue;
      const hit = G.segIntersect([a0.x, a0.z], [a1.x, a1.z], [b0.x, b0.z], [b1.x, b1.z]);
      if (!hit) continue;
      out.push({
        x: hit.p[0], z: hit.p[1],
        sA: a0.s + (a1.s - a0.s) * hit.u,
        yA: a0.y + (a1.y - a0.y) * hit.u, yB: b0.y + (b1.y - b0.y) * hit.v,
        tParamB: b0.t + (b1.t - b0.t) * hit.v,
        tA: G.norm([a1.x - a0.x, a1.z - a0.z]), tB: G.norm([b1.x - b0.x, b1.z - b0.z]),
      });
    }
  }
  return out;
}

const PARALLEL = Math.cos(MIN_ANGLE);
function closeAlongside(p, tan, pts, limit) {
  for (let k = 1; k < pts.length; k++) {
    const b0 = pts[k - 1], b1 = pts[k];
    const d = [b1.x - b0.x, b1.z - b0.z], l2 = d[0] * d[0] + d[1] * d[1] || 1;
    const f = G.clamp(((p.x - b0.x) * d[0] + (p.z - b0.z) * d[1]) / l2, 0, 1);
    const x = b0.x + d[0] * f, z = b0.z + d[1] * f;
    if (Math.hypot(p.x - x, p.z - z) >= limit) continue;
    if (Math.abs(p.y - (b0.y + (b1.y - b0.y) * f)) >= CLEARANCE) continue;
    if (Math.abs(G.dot(tan, d) / Math.sqrt(l2)) < PARALLEL) continue;
    return true;
  }
  return false;
}
