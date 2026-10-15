import * as G from './geometry.js';
import { armsAt } from './derive.js';

// Arc        { from, to, ctrl: [x, z] | null, turn, radius, length }
//            turn is signed radians in signedTurn's sense: + bends toward G.right, the driver's right.
// Piece      { from, to, ctrl: [x, z] | null }
// Connection { kind: 'corner' | 'smooth', pieces: Piece[] } | { kind: 'none', reason: 'parallel' | 'behind' | 'tooClose' | 'sameWay' }

export const MAX_TURN = (150 * Math.PI) / 180;
const STRAIGHT_STEP = 5;
const MIN_CONNECT = 4;
const MIN_LEFTOVER = 0.5;
const EPS = 1e-9;

const rotate = (v, a) => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
const snapTo = (v, step) => (step > 0 ? Math.round(v / step) * step : v);

function straight(p0, tangent, along, step) {
  const length = Math.max(step || 1, snapTo(along, step));
  return { from: p0, to: G.add(p0, G.scale(tangent, length)), ctrl: null, turn: 0, radius: Infinity, length };
}

// The symmetric quadratic leaving p0 along `tangent` that turns by `turn`, sized from the cursor's reach along its chord.
function arcOf(p0, tangent, turn, cursor, radiusStep) {
  const v = G.sub(cursor, p0);
  if (Math.abs(turn) < EPS) return straight(p0, tangent, G.dot(v, tangent), radiusStep ? STRAIGHT_STEP : 0);
  const chordDir = rotate(tangent, turn / 2), half = Math.sin(Math.abs(turn) / 2);
  let radius = Math.max(G.dot(v, chordDir), 1) / (2 * half);
  if (radiusStep > 0) radius = Math.max(radiusStep, snapTo(radius, radiusStep));
  const chord = 2 * radius * half;
  const to = G.add(p0, G.scale(chordDir, chord));
  const ctrl = G.add(p0, G.scale(tangent, chord / (2 * Math.cos(turn / 2))));
  return { from: p0, to, ctrl, turn, radius, length: G.bezierLength(G.curve(p0, ctrl, to)) };
}

export function arcFromCursor(p0, tangent, cursor, { turnStep = 0, radiusStep = 0 } = {}) {
  const raw = 2 * G.signedTurn(tangent, G.sub(cursor, p0));
  const turn = G.clamp(snapTo(raw, turnStep), -MAX_TURN, MAX_TURN);
  return arcOf(p0, tangent, turn, cursor, radiusStep);
}

// The turn's size is fixed; the cursor picks the side and, by its reach, the radius.
export function arcWithTurn(p0, tangent, turn, cursor, radiusStep = 0) {
  const side = G.cross(tangent, G.sub(cursor, p0)) < 0 ? -1 : 1;
  return arcOf(p0, tangent, side * G.clamp(Math.abs(turn), 0, MAX_TURN), cursor, radiusStep);
}

export function endTangent(net, nodeId) {
  const arms = armsAt(net, nodeId);
  return arms.length === 1 ? G.scale(arms[0].away, -1) : null;
}

// Which way traffic may cross the gap: 'out' leaves the old road into the gap, 'in' enters it, 'both' for two-way.
function gapFlow(net, nodeId) {
  const arm = armsAt(net, nodeId)[0];
  if (arm.inCount > 0 && arm.outCount === 0) return 'out';
  if (arm.outCount > 0 && arm.inCount === 0) return 'in';
  return 'both';
}

// Orders two dead ends so traffic runs from `from` to `to`, or says why it cannot.
export function orientEnds(net, a, b) {
  const fa = gapFlow(net, a), fb = gapFlow(net, b);
  if (fa !== 'in' && fb !== 'out') return { from: a, to: b };
  if (fb !== 'in' && fa !== 'out') return { from: b, to: a };
  return { reason: 'sameWay' };
}

const collinearFacing = (A, tA, B, tB) => {
  const d = G.sub(B, A);
  return Math.abs(G.cross(tA, d)) < 1e-6 * G.len(d) && G.dot(tA, d) > 0 && G.dot(tA, tB) < -1 + 1e-6;
};

export function connect(kind, A, tA, B, tB) {
  if (G.dist(A, B) < MIN_CONNECT) return { kind: 'none', reason: 'tooClose' };
  if (collinearFacing(A, tA, B, tB)) return { kind, pieces: [{ from: A, to: B, ctrl: null }] };
  const X = G.rayMeet(A, tA, B, tB);
  switch (kind) {
    case 'corner':
      if (!X) return { kind: 'none', reason: Math.abs(G.cross(tA, tB)) < 1e-9 ? 'parallel' : 'behind' };
      return { kind, pieces: [{ from: A, to: X, ctrl: null }, { from: X, to: B, ctrl: null }] };
    case 'smooth':
      return X ? fillet(A, tA, B, tB, X) : hermite(A, tA, B, tB);
  }
  throw new Error(`connect: unknown kind ${kind}`);
}

function fillet(A, tA, B, tB, X) {
  const a = G.dist(X, A), b = G.dist(X, B), L = Math.min(a, b);
  const P = a - L < MIN_LEFTOVER ? A : G.sub(X, G.scale(tA, L));
  const Q = b - L < MIN_LEFTOVER ? B : G.sub(X, G.scale(tB, L));
  const pieces = [];
  if (P !== A) pieces.push({ from: A, to: P, ctrl: null });
  pieces.push({ from: P, to: Q, ctrl: X });
  if (Q !== B) pieces.push({ from: Q, to: B, ctrl: null });
  return { kind: 'smooth', pieces };
}

// The cubic Hermite between the ends, split at its midpoint and each half redrawn as a quadratic.
function hermite(A, tA, B, tB) {
  const k = G.dist(A, B) / 3;
  const P1 = G.add(A, G.scale(tA, k)), P2 = G.add(B, G.scale(tB, k));
  const M = G.scale(G.add(G.add(A, B), G.scale(G.add(P1, P2), 3)), 1 / 8);
  const tM = G.norm(G.sub(G.add(B, P2), G.add(A, P1)));
  const c1 = G.rayMeet(A, tA, M, G.scale(tM, -1)), c2 = G.rayMeet(M, tM, B, tB);
  if (!c1 || !c2) return { kind: 'none', reason: 'behind' };
  return { kind: 'smooth', pieces: [{ from: A, to: M, ctrl: c1 }, { from: M, to: B, ctrl: c2 }] };
}
