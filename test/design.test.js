import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arcFromCursor, arcWithTurn, connect, endTangent, orientEnds } from '../src/net/design.js';
import { emptyNetwork, apply } from '../src/net/network.js';
import { classifyNode } from '../src/net/derive.js';
import * as G from '../src/net/geometry.js';

const deg = d => (d * Math.PI) / 180;
const SNAP = { turnStep: Math.PI / 12, radiusStep: 5 };
const endTangentOf = arc => G.norm(G.sub(arc.to, arc.ctrl));
const minRadius = piece => G.minRadius(G.curve(piece.from, piece.ctrl, piece.to));
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
// A point on the circular arc of radius r that leaves [0,0] heading +x and turns by `turn`.
const onArc = (turn, r) => [r * Math.sin(turn), r * (1 - Math.cos(turn))];

for (const d of [15, 30, 45]) {
  test(`snap makes a ${d}° turn from a cursor near that arc`, () => {
    const cursor = G.add(onArc(deg(d), 120), [0.3, -0.2]);
    const arc = arcFromCursor([0, 0], [1, 0], cursor, SNAP);
    const t = endTangentOf(arc);
    close(t[0], Math.cos(deg(d)), 1e-9, 'end tangent x');
    close(t[1], Math.sin(deg(d)), 1e-9, 'end tangent z');
    close(arc.turn, deg(d), 1e-12, 'turn');
    close(arc.radius / 5, Math.round(arc.radius / 5), 1e-9, 'radius is a multiple of 5');
    assert.equal(arc.radius, 120);
  });
}

test('snap off keeps the raw turn', () => {
  const arc = arcFromCursor([0, 0], [1, 0], onArc(deg(37), 90), { turnStep: 0, radiusStep: 0 });
  close(arc.turn, deg(37), 1e-6, 'turn');
});

test('a locked 30° turn changes only the radius as the cursor moves out', () => {
  const arcs = [40, 80, 160].map(r => arcWithTurn([0, 0], [1, 0], deg(30), onArc(deg(50), r), 5));
  for (const arc of arcs) close(arc.turn, deg(30), 1e-12, 'turn');
  assert.ok(arcs[0].radius < arcs[1].radius && arcs[1].radius < arcs[2].radius, arcs.map(a => a.radius).join(' < '));
});

test('a locked turn bends toward the side the cursor is on', () => {
  assert.ok(arcWithTurn([0, 0], [1, 0], deg(45), [50, -30], 5).turn < 0);
  assert.ok(arcWithTurn([0, 0], [1, 0], deg(45), [50, 30], 5).turn > 0);
});

test('corner projects both ends to where their rays meet', () => {
  assert.deepEqual(connect('corner', [0, 0], [1, 0], [100, 50], [0, -1]), {
    kind: 'corner',
    pieces: [{ from: [0, 0], to: [100, 0], ctrl: null }, { from: [100, 0], to: [100, 50], ctrl: null }],
  });
});

test('smooth fills the shorter leg with an arc and keeps the rest straight', () => {
  const c = connect('smooth', [0, 0], [1, 0], [100, 50], [0, -1]);
  assert.deepEqual(c, {
    kind: 'smooth',
    pieces: [{ from: [0, 0], to: [50, 0], ctrl: null }, { from: [50, 0], to: [100, 50], ctrl: [100, 0] }],
  });
  close(minRadius(c.pieces[1]), 50 * Math.SQRT1_2, 1e-6, 'a symmetric 90° quadratic with 50 m legs');
});

test('the smooth fillet is wider than one quadratic through the corner when the legs differ a lot', () => {
  const c = connect('smooth', [0, 0], [1, 0], [200, 50], [0, -1]);
  const arc = c.pieces.at(-1);
  assert.deepEqual(arc, { from: [150, 0], to: [200, 50], ctrl: [200, 0] });
  close(minRadius(arc), 35.355, 1e-3, 'fillet');
  close(minRadius({ from: [0, 0], to: [200, 50], ctrl: [200, 0] }), 22.84, 1e-2, 'single quadratic');
});

test('smooth joins an offset with an S of two arcs that meet tangent', () => {
  const c = connect('smooth', [0, 0], [1, 0], [100, 20], [-1, 0]);
  assert.equal(c.kind, 'smooth');
  assert.equal(c.pieces.length, 2);
  const [p, q] = c.pieces;
  assert.deepEqual(p.to, [50, 10]);
  assert.deepEqual(q.from, [50, 10]);
  const out = G.norm(G.sub(p.to, p.ctrl)), into = G.norm(G.sub(q.ctrl, q.from));
  close(out[0], into[0], 1e-6, 'join tangent x');
  close(out[1], into[1], 1e-6, 'join tangent z');
  for (const piece of c.pieces) assert.ok(minRadius(piece) > 25, `radius ${minRadius(piece)}`);
});

test('parallel rays facing the same way have no corner', () => {
  assert.deepEqual(connect('corner', [0, 0], [1, 0], [0, 50], [1, 0]), { kind: 'none', reason: 'parallel' });
});

test('ends facing each other on one line join with one straight', () => {
  const pieces = [{ from: [0, 0], to: [80, 0], ctrl: null }];
  assert.deepEqual(connect('smooth', [0, 0], [1, 0], [80, 0], [-1, 0]), { kind: 'smooth', pieces });
  assert.deepEqual(connect('corner', [0, 0], [1, 0], [80, 0], [-1, 0]), { kind: 'corner', pieces });
});

test('ends closer than 4 m are refused', () => {
  assert.deepEqual(connect('smooth', [0, 0], [1, 0], [3, 0], [-1, 0]), { kind: 'none', reason: 'tooClose' });
});

const free = (x, z) => ({ kind: 'free', x, z });
function streetPair() {
  let net = emptyNetwork();
  for (const [from, to] of [[free(-300, 0), free(-200, 0)], [free(-100, 150), free(-100, 50)]]) {
    const r = apply(net, { type: 'build', from, to, ctrl: null, profile: 'street' });
    assert.equal(r.error, undefined);
    net = r.net;
  }
  const at = (x, z) => [...net.nodes.values()].find(n => n.x === x && n.z === z).id;
  return { net, a: at(-200, 0), b: at(-100, 50) };
}
const piecesFor = (conn, profile) => conn.pieces.map(p => ({ ...p, profile }));
const posOf = (net, id) => [net.nodes.get(id).x, net.nodes.get(id).z];

test('a chain joins two street ends in one step, and both ends become continuations', () => {
  const { net, a, b } = streetPair();
  assert.deepEqual(endTangent(net, a), [1, 0]);
  assert.deepEqual(orientEnds(net, a, b), { from: a, to: b });
  const conn = connect('smooth', posOf(net, a), endTangent(net, a), posOf(net, b), endTangent(net, b));
  assert.equal(conn.pieces.length, 2);
  const r = apply(net, { type: 'chain', pieces: piecesFor(conn, 'street'), fromNode: a, toNode: b });
  assert.equal(r.error, undefined);
  assert.equal(classifyNode(r.net, r.net.nodes.get(a)).kind, 'continue');
  assert.equal(classifyNode(r.net, r.net.nodes.get(b)).kind, 'continue');
  assert.equal(r.net.segments.size, net.segments.size + 2);
  assert.equal(net.segments.size, 2, 'the network before the chain is untouched, so one undo restores it');
});

test('a chain with a refused piece leaves the network unchanged', () => {
  const { net, a, b } = streetPair();
  const pieces = [
    { from: posOf(net, a), to: [-100, 0], ctrl: null, profile: 'street' },
    { from: [-100, 0], to: posOf(net, b), ctrl: [-90, 0], profile: 'street' },
  ];
  const r = apply(net, { type: 'chain', pieces, fromNode: a, toNode: b });
  assert.equal(r.error.reason, 'radius');
  assert.equal(r.net, net);
  assert.deepEqual({ nodes: r.net.nodes.size, segments: r.net.segments.size }, { nodes: 4, segments: 2 });
});

test('one-way ends are ordered so traffic flows through, and refused when both run the same way', () => {
  let net = emptyNetwork();
  for (const [from, to] of [[free(-300, 0), free(-200, 0)], [free(-100, 100), free(-100, 150)], [free(-300, 300), free(-200, 300)]]) {
    net = apply(net, { type: 'build', from, to, ctrl: null, profile: 'oneway' }).net;
  }
  const at = (x, z) => [...net.nodes.values()].find(n => n.x === x && n.z === z).id;
  assert.deepEqual(orientEnds(net, at(-100, 100), at(-200, 0)), { from: at(-200, 0), to: at(-100, 100) });
  assert.deepEqual(orientEnds(net, at(-200, 0), at(-200, 300)), { reason: 'sameWay' });
});
