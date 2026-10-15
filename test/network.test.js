import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyNetwork, apply } from '../src/net/network.js';
import { classifyNode, segCurve, laneGraph, laneCounts, laneId } from '../src/net/derive.js';
import { bezierTangent } from '../src/net/geometry.js';

const free = (x, z) => ({ kind: 'free', x, z });
const node = id => ({ kind: 'node', id });
const onSeg = (id, t) => ({ kind: 'segment', id, t });

function build(net, action) {
  const r = apply(net, { type: 'build', ...action });
  assert.equal(r.error, undefined, `build refused: ${r.error && r.error.reason}`);
  return r.net;
}

const kinds = net => [...net.nodes.values()].map(n => classifyNode(net, n).kind);
const newIds = (before, after, key) => [...after[key].keys()].filter(id => !before[key].has(id));

test('a straight street between two free points is two dead ends', () => {
  const net = build(emptyNetwork(), { from: free(-500, -500), to: free(-400, -500), profile: 'street' });
  assert.equal(net.nodes.size, 2);
  assert.equal(net.segments.size, 1);
  assert.deepEqual(kinds(net), ['end', 'end']);
});

test('building from the end of a road continues its tangent', () => {
  const first = build(emptyNetwork(), { from: free(-500, -500), to: free(-400, -480), profile: 'street' });
  const old = [...first.segments.values()][0];
  const second = build(first, { from: node(old.b), to: free(-320, -420), profile: 'street' });
  const added = second.segments.get(newIds(first, second, 'segments')[0]);
  const tOld = bezierTangent(segCurve(second, old), 1), tNew = bezierTangent(segCurve(second, added), 0);
  assert.ok(added.ctrl !== null);
  assert.ok(Math.abs(tOld[0] - tNew[0]) < 1e-6 && Math.abs(tOld[1] - tNew[1]) < 1e-6, `${tOld} vs ${tNew}`);
});

test('tight curves and steep highways are refused with a named reason', () => {
  const tight = apply(emptyNetwork(), { type: 'build', from: free(-500, -500), to: free(-490, -490), ctrl: [-490, -500], profile: 'street' });
  assert.equal(tight.error.reason, 'radius');
  const steep = apply(emptyNetwork(), { type: 'build', from: free(-100, 0), to: free(0, 0), ctrl: null, profile: 'hw2', liftFrom: 0, liftTo: 20 });
  assert.equal(steep.error.reason, 'grade');
});

test('an off-ramp drawn from a carriageway makes a diverge with the rightmost lane feeding the exit', () => {
  const hw = build(emptyNetwork(), { from: free(-600, -200), to: free(-100, -200), profile: 'hw2' });
  const hwSeg = [...hw.segments.keys()][0];
  const net = build(hw, { from: onSeg(hwSeg, 0.5), to: free(-200, -150), profile: 'ramp' });
  const gore = net.nodes.get(newIds(hw, net, 'nodes')[0]);
  const cls = classifyNode(net, gore);
  assert.equal(cls.kind, 'diverge');
  const segs = [...net.segments.values()];
  const incoming = segs.find(s => s.b === gore.id);
  const main = segs.find(s => s.a === gore.id && s.profileA === 'hw2');
  const ramp = segs.find(s => s.a === gore.id && s.profileA === 'ramp');
  assert.equal(cls.main.seg, main.id);
  assert.equal(cls.branch.seg, ramp.id);
  const { conns } = laneGraph(net);
  const targets = lane => new Set([...conns.values()].filter(c => c.fromLane === lane).map(c => c.toLane));
  assert.deepEqual(targets(laneId(incoming.id, 1, 0)), new Set([laneId(main.id, 1, 0)]));
  assert.ok(targets(laneId(incoming.id, 1, 1)).has(laneId(ramp.id, 1, 0)));
});

test('an on-ramp ending on a carriageway makes a merge', () => {
  const hw = build(emptyNetwork(), { from: free(-600, -200), to: free(-100, -200), profile: 'hw2' });
  const hwSeg = [...hw.segments.keys()][0];
  const net = build(hw, { from: free(-450, -150), to: onSeg(hwSeg, 0.6), ctrl: [-350, -200], profile: 'ramp' });
  const gore = net.nodes.get(newIds(hw, net, 'nodes').find(id => classifyNode(net, net.nodes.get(id)).kind !== 'end'));
  const cls = classifyNode(net, gore);
  assert.equal(cls.kind, 'merge');
  assert.equal(cls.side, 'right');
});

test('crossing at grade makes an intersection, a viaduct crosses freely, a low deck is refused', () => {
  const street = build(emptyNetwork(), { from: free(-500, -500), to: free(-400, -500), profile: 'street' });
  const cross = build(street, { from: free(-450, -560), to: free(-450, -440), profile: 'street' });
  const centre = [...cross.nodes.values()].find(n => classifyNode(cross, n).kind === 'intersection');
  assert.ok(centre, 'an intersection node exists');
  assert.equal(classifyNode(cross, centre).arms.length, 4);
  assert.equal(cross.segments.size, 4);

  const over = build(street, { from: free(-450, -560), to: free(-450, -440), profile: 'street', liftFrom: 7.5, liftTo: 7.5 });
  assert.equal(over.nodes.size, 4);
  assert.equal(over.segments.size, 2);

  const low = apply(street, { type: 'build', from: free(-450, -560), to: free(-450, -440), profile: 'street', liftFrom: 2.5, liftTo: 2.5 });
  assert.equal(low.error.reason, 'clearance');
});

test('a 3-to-2 lane taper drops a lane into its neighbour', () => {
  const taper = build(emptyNetwork(), { from: free(-600, 200), to: free(-300, 200), profile: 'hw3', profileB: 'hw2' });
  const seg = [...taper.segments.values()][0];
  const net = build(taper, { from: node(seg.b), to: free(-100, 200), profile: 'hw2' });
  const counts = laneCounts(net, seg);
  assert.equal(counts.fwd.start, 3);
  assert.equal(counts.fwd.end, 2);
  const { lanes, conns } = laneGraph(net);
  const dropped = lanes.get(laneId(seg.id, 1, 2));
  assert.equal(dropped.joins, laneId(seg.id, 1, 1));
  const end = dropped.pts[dropped.pts.length - 1], neighbour = lanes.get(laneId(seg.id, 1, 1)).pts.at(-1);
  assert.ok(Math.hypot(end.x - neighbour.x, end.z - neighbour.z) < 1e-6);
  const next = [...net.segments.values()].find(s => s.a === seg.b);
  const fromDropped = [...conns.values()].filter(c => c.fromLane === dropped.id).map(c => c.toLane);
  assert.ok(fromDropped.includes(laneId(next.id, 1, 1)));
});
