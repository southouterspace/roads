export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const scale = (a, k) => [a[0] * k, a[1] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const len = a => Math.hypot(a[0], a[1]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const norm = a => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l];
};
// Right-hand side of a heading on the x/z plane with y up.
export const right = t => [-t[1], t[0]];
export const smoothstep = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const angleBetween = (a, b) => Math.acos(clamp(dot(norm(a), norm(b)), -1, 1));

// A curve is { p0, c, p2 } with c null for a straight line. Straight lines use their midpoint as the control,
// which makes the quadratic degenerate to linear with uniform speed.
export const curve = (p0, c, p2) => ({ p0, c: c || lerp(p0, p2, 0.5), p2 });

export function bezier(cv, t) {
  const u = 1 - t;
  return [
    u * u * cv.p0[0] + 2 * u * t * cv.c[0] + t * t * cv.p2[0],
    u * u * cv.p0[1] + 2 * u * t * cv.c[1] + t * t * cv.p2[1],
  ];
}

export function bezierDeriv(cv, t) {
  const u = 1 - t;
  return [
    2 * u * (cv.c[0] - cv.p0[0]) + 2 * t * (cv.p2[0] - cv.c[0]),
    2 * u * (cv.c[1] - cv.p0[1]) + 2 * t * (cv.p2[1] - cv.c[1]),
  ];
}

export function bezierTangent(cv, t) {
  const d = bezierDeriv(cv, t);
  if (len(d) > 1e-9) return norm(d);
  return norm(sub(cv.p2, cv.p0));
}

const SECOND = cv => [
  2 * (cv.p2[0] - 2 * cv.c[0] + cv.p0[0]),
  2 * (cv.p2[1] - 2 * cv.c[1] + cv.p0[1]),
];

export function bezierLength(cv, steps = 64) {
  let total = 0, prev = cv.p0;
  for (let i = 1; i <= steps; i++) {
    const p = bezier(cv, i / steps);
    total += dist(prev, p);
    prev = p;
  }
  return total;
}

// Samples spaced evenly by arc length, at roughly `spacing` metres. Returns [{ t, s, p }].
export function arcSamples(cv, spacing = 2) {
  const fine = 256, ts = [0], ss = [0];
  let prev = cv.p0;
  for (let i = 1; i <= fine; i++) {
    const t = i / fine, p = bezier(cv, t);
    ss.push(ss[i - 1] + dist(prev, p));
    ts.push(t);
    prev = p;
  }
  const total = ss[fine];
  const n = Math.max(1, Math.ceil(total / spacing));
  const out = [];
  let j = 0;
  for (let k = 0; k <= n; k++) {
    const s = (total * k) / n;
    while (j < fine - 1 && ss[j + 1] < s) j++;
    const span = ss[j + 1] - ss[j] || 1;
    const t = ts[j] + ((s - ss[j]) / span) * (ts[j + 1] - ts[j]);
    out.push({ t, s, p: bezier(cv, t) });
  }
  return out;
}

export function minRadius(cv) {
  let r = Infinity;
  const dd = SECOND(cv);
  for (let i = 0; i <= 64; i++) {
    const d = bezierDeriv(cv, i / 64);
    const k = Math.abs(cross(d, dd)) / Math.pow(len(d), 3);
    if (k > 1e-12) r = Math.min(r, 1 / k);
  }
  return r;
}

// de Casteljau split of a quadratic at t.
export function splitCurve(cv, t) {
  const c0 = lerp(cv.p0, cv.c, t), c1 = lerp(cv.c, cv.p2, t), m = lerp(c0, c1, t);
  return [{ p0: cv.p0, c: c0, p2: m }, { p0: m, c: c1, p2: cv.p2 }];
}

// Nearest parameter on a curve to a point, by sampling then refining.
export function nearestT(cv, p) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i <= 64; i++) {
    const d = dist(bezier(cv, i / 64), p);
    if (d < bestD) { bestD = d; best = i / 64; }
  }
  let step = 1 / 64;
  for (let k = 0; k < 20; k++) {
    step /= 2;
    for (const t of [best - step, best + step]) {
      if (t < 0 || t > 1) continue;
      const d = dist(bezier(cv, t), p);
      if (d < bestD) { bestD = d; best = t; }
    }
  }
  return { t: best, d: bestD };
}

// Plan-view intersection of segments p1p2 and q1q2. Returns { u, v, p } with u, v in [0, 1] or null.
export function segIntersect(p1, p2, q1, q2) {
  const r = sub(p2, p1), s = sub(q2, q1), den = cross(r, s);
  if (Math.abs(den) < 1e-12) return null;
  const qp = sub(q1, p1), u = cross(qp, s) / den, v = cross(qp, r) / den;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { u, v, p: add(p1, scale(r, u)) };
}

// Intersection of two rays given by point and direction, forward along both. Returns the point or null.
export function rayMeet(p, dp, q, dq) {
  const den = cross(dp, dq);
  if (Math.abs(den) < 1e-9) return null;
  const qp = sub(q, p), u = cross(qp, dq) / den, v = cross(qp, dp) / den;
  if (u <= 0 || v <= 0) return null;
  return add(p, scale(dp, u));
}

// Offset a polyline of {x, z} points sideways. `offsetAt(i)` gives the right-hand offset at point i.
export function offsetPolyline(pts, offsetAt) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const t = norm([b.x - a.x, b.z - a.z]), r = right(t), o = offsetAt(i);
    return { ...p, x: p.x + r[0] * o, z: p.z + r[1] * o };
  });
}

export function cumulative(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    cum.push(cum[i - 1] + Math.hypot(b.x - a.x, (b.y || 0) - (a.y || 0), b.z - a.z));
  }
  return cum;
}

export function signedTurn(a, b) {
  return Math.atan2(cross(a, b), dot(a, b));
}
