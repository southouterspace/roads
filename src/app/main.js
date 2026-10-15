import { createRenderer, ROAD_Y } from './render.js';
import { createCameraRig } from './camera.js';
import { apply, planBuild, dividedActions, chainActions, LIFT_STEP, MAX_LIFT } from '../net/network.js';
import { arcFromCursor, arcWithTurn, connect, endTangent, orientEnds } from '../net/design.js';
import { profile, pairOf, dividedOffset } from '../net/profiles.js';
import { classifyNode, segmentPath, nodeY, segCurve, armsAt, structureAt, laneGraph } from '../net/derive.js';
import { REASON_TEXT } from '../net/validate.js';
import { createWorld } from '../net/world.js';
import { createSim, setNetwork as simSetNetwork, tick as simTick, mulberry32, controlKind } from '../net/sim.js';
import { serialize, parse, save } from '../net/save.js';
import { surfaceAt, inWorld } from '../net/terrain.js';
import * as G from '../net/geometry.js';

const $ = id => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);
const SAVE_KEY = 'roads-v3';
const HELP_KEY = 'roads-help-seen';
const NODE_PX = 22, SEG_PX = 16;

const ROAD_OPTIONS = [
  { id: 'street', badge: 'ST', sub: '1 + 1 lanes · 50 km/h' },
  { id: 'avenue', badge: 'AV', sub: '2 + 2 lanes · 60 km/h' },
  { id: 'oneway', badge: '1W', sub: '2 lanes one way · 50 km/h' },
  { id: 'ramp', badge: 'RP', sub: '1 lane · 60 km/h' },
  { id: 'ramp2', badge: 'R2', sub: '2 lanes · 70 km/h' },
  { id: 'hw2', badge: 'H2', sub: '2 lanes one way · 100 km/h' },
  { id: 'hw3', badge: 'H3', sub: '3 lanes one way · 110 km/h' },
  { id: 'div2', badge: 'D2', sub: 'both ways · 100 km/h' },
  { id: 'div3', badge: 'D3', sub: 'both ways · 110 km/h' },
];
const optionName = id => (pairOf.has(id) ? pairOf.get(id).name : profile(id).name);
const CONTROL_OPTIONS = [
  { id: 'auto', name: 'Auto', sub: 'yield or signals' },
  { id: 'yield', name: 'Yield', sub: 'side roads give way' },
  { id: 'stop', name: 'All-way stop', sub: 'one at a time' },
  { id: 'signal', name: 'Signals', sub: 'in phases' },
  { id: 'roundabout', name: 'Roundabout', sub: 'yield to the ring' },
];
const TURN_LOCKS = [0, 15, 30, 45, 60, 90];
const SNAP_TURN = Math.PI / 12, SNAP_RADIUS = 5;
const LINK_TEXT = {
  parallel: 'These roads run side by side and never meet',
  behind: 'These roads point away from each other',
  tooClose: 'The ends are too close together',
  sameWay: 'Both ends carry traffic the same way',
};
const KIND_TEXT = { end: 'Dead end', continue: 'Continuation', taper: 'Taper', diverge: 'Diverge (off-ramp gore)', merge: 'Merge (on-ramp gore)', intersection: 'Intersection' };
const STRUCTURE_TEXT = { grade: 'at grade', wall: 'on a retaining wall', viaduct: 'viaduct', bridge: 'bridge' };

const canvas = $('c');
const view = createRenderer(canvas);
const cam = createCameraRig(view.camera, canvas);

const world = createWorld();
const app = {
  net: world.net, past: [], future: [], tool: 'road', road: 'street', snap: true, curve: false, shift: false,
  turnLock: 0, draft: null, link: null, linkKind: 'smooth', cursorLift: 0, picked: null, inspect: null,
  sim: null, rng: mulberry32(2024), traffic: 'steady',
};
app.sim = createSim(app.net, world.towns, { traffic: app.traffic });
view.setTowns(world.towns);

let toastTimer = 0;
function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

const reasonText = error => REASON_TEXT[error.reason] || (error.reason === 'twoWay' ? 'Only one-way roads can be reversed' : 'That does not work here');

function networkChanged() {
  simSetNetwork(app.sim, app.net);
  view.setNetwork(app.net, app.sim);
  $('undoBtn').disabled = !app.past.length;
  $('redoBtn').disabled = !app.future.length;
  try { localStorage.setItem(SAVE_KEY, serialize(app.net)); } catch {}
  refreshDraft();
  renderInspect();
}

function commit(net) {
  app.past.push(app.net);
  if (app.past.length > 200) app.past.shift();
  app.future = [];
  app.net = net;
  networkChanged();
}

function run(action) {
  const r = apply(app.net, action);
  if (r.error) { toast(reasonText(r.error)); return null; }
  commit(r.net);
  return r;
}

function undo() {
  if (!app.past.length) return;
  app.future.push(app.net);
  app.net = app.past.pop();
  networkChanged();
}
function redo() {
  if (!app.future.length) return;
  app.past.push(app.net);
  app.net = app.future.pop();
  networkChanged();
}
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);

function pickNode(cx, cy, px = NODE_PX, except = null) {
  let best = null, bestD = px;
  for (const n of app.net.nodes.values()) {
    if (n.id === except) continue;
    const s = view.project(n.x, nodeY(n) + ROAD_Y, n.z);
    if (s.behind) continue;
    const d = Math.hypot(s.x - cx, s.y - cy);
    if (d < bestD) { best = n; bestD = d; }
  }
  return best;
}

function pickSegment(cx, cy, px = SEG_PX, except = null) {
  let best = null, bestD = px;
  for (const seg of app.net.segments.values()) {
    if (seg.id === except) continue;
    const pts = segmentPath(app.net, seg).pts;
    let prev = null;
    for (let i = 0; i < pts.length; i += 2) {
      const p = pts[i], s = view.project(p.x, p.y + ROAD_Y, p.z);
      if (s.behind) { prev = null; continue; }
      if (prev) {
        const dx = s.x - prev.s.x, dy = s.y - prev.s.y, l2 = dx * dx + dy * dy || 1;
        const f = G.clamp(((cx - prev.s.x) * dx + (cy - prev.s.y) * dy) / l2, 0, 1);
        const d = Math.hypot(prev.s.x + dx * f - cx, prev.s.y + dy * f - cy);
        if (d < bestD) {
          bestD = d;
          const wx = prev.p.x + (p.x - prev.p.x) * f, wz = prev.p.z + (p.z - prev.p.z) * f;
          best = { seg, point: [wx, wz] };
        }
      }
      prev = { s, p };
    }
  }
  if (!best) return null;
  const { t } = G.nearestT(segCurve(app.net, best.seg), best.point);
  return { seg: best.seg, t };
}

function pickAny(cx, cy) {
  const n = pickNode(cx, cy);
  if (n) return { node: n.id };
  const s = pickSegment(cx, cy);
  return s ? { seg: s.seg.id } : null;
}

const isDivided = () => pairOf.has(app.road);
const roadProfile = () => (isDivided() ? pairOf.get(app.road).carriageway : app.road);
const anchorPos = a => {
  if (a.kind === 'free') return [a.x, a.z];
  if (a.kind === 'node') { const n = app.net.nodes.get(a.id); return [n.x, n.z]; }
  return G.bezier(segCurve(app.net, app.net.segments.get(a.id)), a.t);
};

// A divided highway can continue from the end of another: two carriageway end nodes the right distance apart.
function carriagewayPair(x, z) {
  const off = dividedOffset(roadProfile());
  let best = null;
  for (const n of app.net.nodes.values()) {
    const arms = armsAt(app.net, n.id);
    if (arms.length !== 1 || !arms[0].oneWay || arms[0].inCount === 0) continue;
    const travel = G.scale(arms[0].away, -1);
    const mid = G.sub([n.x, n.z], G.scale(G.right(travel), off));
    const twin = G.sub([n.x, n.z], G.scale(G.right(travel), off * 2));
    const partner = [...app.net.nodes.values()].find(m => m !== n && G.dist([m.x, m.z], twin) < 1.5);
    if (!partner) continue;
    const d = G.dist(mid, [x, z]);
    if (d < 30 && (!best || d < best.d)) best = { d, mid, tangent: travel, lift: n.lift };
  }
  return best;
}

function snapAnchor(cx, cy, lift, role) {
  const d = app.draft;
  if (isDivided()) {
    const g = cam.groundAt(cx, cy, lift);
    if (!g) return null;
    if (role === 'start') {
      const pair = carriagewayPair(g.x, g.z);
      if (pair) return { anchor: { kind: 'free', x: pair.mid[0], z: pair.mid[1] }, tangent: pair.tangent, lift: pair.lift };
    }
    return { anchor: { kind: 'free', x: g.x, z: g.z } };
  }
  const exceptNode = role === 'end' && d.from.kind === 'node' ? d.from.id : null;
  const n = pickNode(cx, cy, NODE_PX, exceptNode);
  if (n) return { anchor: { kind: 'node', id: n.id }, lift: n.lift };
  const exceptSeg = role === 'end' && d.from.kind === 'segment' ? d.from.id : null;
  const s = pickSegment(cx, cy, SEG_PX, exceptSeg);
  if (s) {
    const L = G.bezierLength(segCurve(app.net, s.seg));
    if (s.t * L > 6 && (1 - s.t) * L > 6) return { anchor: { kind: 'segment', id: s.seg.id, t: s.t } };
    const end = app.net.nodes.get(s.t < 0.5 ? s.seg.a : s.seg.b);
    if (end.id !== exceptNode) return { anchor: { kind: 'node', id: end.id }, lift: end.lift };
  }
  const g = cam.groundAt(cx, cy, lift);
  return g ? { anchor: { kind: 'free', x: g.x, z: g.z } } : null;
}

function startTangent(toward) {
  const d = app.draft;
  if (d.tangent) return d.tangent;
  if (d.from.kind === 'node') return endTangent(app.net, d.from.id);
  if (d.from.kind === 'segment') {
    const seg = app.net.segments.get(d.from.id);
    const t = G.bezierTangent(segCurve(app.net, seg), d.from.t);
    return profile(seg.profileA).oneWay || G.dot(t, G.sub(toward, anchorPos(d.from))) >= 0 ? t : G.scale(t, -1);
  }
  return null;
}

// A free end that continues a road becomes an exact arc. One from a free start snaps to 15° headings and 5 m lengths.
function placeFreeEnd(cursor) {
  const d = app.draft, p0 = anchorPos(d.from);
  const tangent = d.ctrl ? null : startTangent(cursor);
  const lock = TURN_LOCKS[app.turnLock], radiusStep = app.snap ? SNAP_RADIUS : 0;
  if (tangent) {
    const arc = lock
      ? arcWithTurn(p0, tangent, (lock * Math.PI) / 180, cursor, radiusStep)
      : arcFromCursor(p0, tangent, cursor, { turnStep: app.snap ? SNAP_TURN : 0, radiusStep });
    return { to: { kind: 'free', x: arc.to[0], z: arc.to[1] }, arc };
  }
  if (!app.snap || d.ctrl) return { to: { kind: 'free', x: cursor[0], z: cursor[1] }, arc: null };
  const v = G.sub(cursor, p0);
  const a = Math.round(Math.atan2(v[1], v[0]) / SNAP_TURN) * SNAP_TURN;
  const len = Math.max(SNAP_RADIUS, Math.round(G.len(v) / SNAP_RADIUS) * SNAP_RADIUS);
  return { to: { kind: 'free', x: p0[0] + Math.cos(a) * len, z: p0[1] + Math.sin(a) * len }, arc: null };
}

function setDraftEnd(cx, cy) {
  const d = app.draft;
  const r = snapAnchor(cx, cy, d.toLift, 'end');
  if (!r) return;
  const p0 = anchorPos(d.from), q = anchorPos(r.anchor);
  if (G.dist(p0, q) < 1) return;
  d.cursor = r.anchor.kind === 'free' ? q : null;
  d.to = r.anchor;
  d.arc = null;
  placeEnd();
}

// Reshapes a free end from the cursor, after the cursor moves or the snap or turn lock changes.
function placeEnd() {
  const d = app.draft;
  if (d && d.cursor) Object.assign(d, placeFreeEnd(d.cursor));
  refreshDraft();
}

function setDraftCtrl(cx, cy) {
  const d = app.draft;
  const lift = (d.fromLift + d.toLift) / 2;
  const g = cam.groundAt(cx, cy, lift);
  if (!g) return;
  d.ctrl = [g.x, g.z];
  refreshDraft();
}

function draftAction() {
  const d = app.draft;
  if (!d || !d.to) return null;
  const liftFrom = d.from.kind === 'free' ? d.fromLift : undefined;
  const liftTo = d.to.kind === 'free' ? d.toLift : undefined;
  if (isDivided()) {
    const p0 = anchorPos(d.from), p2 = anchorPos(d.to);
    const ctrl = d.ctrl || (d.arc ? d.arc.ctrl : null);
    return { type: 'divided', pair: app.road, from: { x: p0[0], z: p0[1] }, to: { x: p2[0], z: p2[1] }, ctrl, liftFrom: d.fromLift, liftTo: d.toLift };
  }
  return { type: 'build', from: d.from, to: d.to, ctrl: d.ctrl || (d.arc ? d.arc.ctrl : undefined), profile: app.road, liftFrom, liftTo };
}

// A bare network holding only the draft, so a refused draft still shows its real shape in red.
function bareNetwork(plans) {
  const net = { nodes: new Map(), segments: new Map(), nextId: 1 };
  const ids = [];
  for (const plan of plans) {
    const a = net.nextId++, b = net.nextId++, s = net.nextId++;
    net.nodes.set(a, { id: a, x: plan.start.pos[0], z: plan.start.pos[1], lift: plan.start.lift, control: 'auto' });
    net.nodes.set(b, { id: b, x: plan.end.pos[0], z: plan.end.pos[1], lift: plan.end.lift, control: 'auto' });
    net.segments.set(s, { id: s, a, b, ctrl: plan.ctrl ? plan.cv.c : null, profileA: plan.profileA, profileB: plan.profileB });
    ids.push(s);
  }
  return { net, ids };
}

function showGhost(r, plans) {
  if (!r.error) { view.setGhost(r.net, r.built.segments, true); return; }
  const bare = bareNetwork(plans);
  view.setGhost(bare.net, bare.ids, false);
}

function steepest(plan) {
  const pts = plan.raw.pts;
  let grade = 0;
  if (!(plan.ends.liftA === 0 && plan.ends.liftB === 0)) {
    for (let i = 0; i + 5 < pts.length; i++) grade = Math.max(grade, Math.abs(pts[i + 5].y - pts[i].y) / (pts[i + 5].s - pts[i].s));
  }
  return grade;
}

const DEG = 180 / Math.PI;
// Positive turns bend toward G.right, which is the driver's right.
const turnText = turn => (Math.abs(turn) * DEG < 0.5 ? 'Straight' : `Turn ${Math.round(Math.abs(turn) * DEG)}° ${turn > 0 ? 'right' : 'left'}`);

// The readout for a route made of plans: turn, radius, length, then grade and the heights at either end.
function readout(plans, turn, radius, error) {
  const len = plans.reduce((s, p) => s + p.raw.L, 0);
  const grade = Math.max(...plans.map(steepest));
  const liftA = plans[0].start.lift, liftB = plans.at(-1).end.lift;
  const tightest = Math.min(...plans.map(p => G.minRadius(p.cv)));
  const need = Math.max(...plans.map(p => Math.max(profile(p.profileA).minRadius, profile(p.profileB).minRadius)));
  const rule = error && error.reason === 'radius' ? ` (tightest ${Math.round(tightest)} m, needs ${need} m)` : '';
  const why = error ? `<span class="why">${reasonText(error)}${rule}</span>` : '';
  const parts = [
    turnText(turn), radius > 5000 ? null : `R ${Math.round(radius)} m`, `${Math.round(len)} m`,
    grade === 0 ? 'follows ground' : `${(grade * 100).toFixed(1)} %`, `${liftA.toFixed(1)} → ${liftB.toFixed(1)} m`,
  ];
  return parts.filter(Boolean).map(p => `<span class="part">${p}</span>`).join(' · ') + why;
}

const anchorExists = a => !a || a.kind === 'free' || (a.kind === 'node' ? app.net.nodes.has(a.id) : app.net.segments.has(a.id));

function refreshDraft() {
  if (app.draft && !(anchorExists(app.draft.from) && anchorExists(app.draft.to))) app.draft = null;
  const d = app.draft;
  show('draftBar', !!d);
  $('turnBtn').textContent = `Turn: ${TURN_LOCKS[app.turnLock] ? TURN_LOCKS[app.turnLock] + '°' : 'Free'}`;
  $('turnBtn').classList.toggle('on', app.turnLock > 0);
  if (!d) { refreshLink(); return; }
  show('picker', false);
  const markers = [];
  const pointOf = a => { const p = anchorPos(a); return { x: p[0], z: p[1] }; };
  const startPt = pointOf(d.from);
  markers[0] = { ...startPt, y: surfaceAt(startPt.x, startPt.z) + (d.from.kind === 'node' ? app.net.nodes.get(d.from.id).lift : d.fromLift) };
  const action = draftAction();
  $('curveBtn').classList.toggle('on', app.curve);
  $('snapBtn').classList.toggle('on', app.snap);
  if (!action) {
    view.setGhost(null);
    view.setMarkers(markers);
    $('draftInfo').innerHTML = `${optionName(app.road)} · height ${d.toLift.toFixed(1)} m<span class="what">Tap or drag to where the road ends</span>`;
    $('buildDraft').disabled = true;
    return;
  }
  const r = apply(app.net, action);
  const plans = (action.type === 'divided' ? dividedActions(app.net, action) : [action]).map(a => planBuild(app.net, a).plan);
  const plan = plans[0];
  showGhost(r, plans);
  const endPt = { x: plan.end.pos[0], z: plan.end.pos[1] };
  markers[1] = { ...endPt, y: plan.end.y };
  if (d.ctrl) markers[2] = { x: d.ctrl[0], z: d.ctrl[1], y: (plan.ends.yA + plan.ends.yB) / 2 };
  view.setMarkers(markers);
  const arc = d.ctrl ? null : d.arc;
  const turn = arc ? arc.turn : G.signedTurn(G.bezierTangent(plan.cv, 0), G.bezierTangent(plan.cv, 1));
  $('draftInfo').innerHTML = readout([plan], turn, arc ? arc.radius : G.minRadius(plan.cv), r.error);
  $('buildDraft').disabled = !!r.error;
}

const nodePos = id => { const n = app.net.nodes.get(id); return [n.x, n.z]; };
const isEnd = id => endTangent(app.net, id) !== null;

// The chain action joining the two picked ends, or the reason there is none.
function linkPlan() {
  const ends = orientEnds(app.net, app.link.a, app.link.b);
  if (ends.reason) return { reason: ends.reason };
  const tA = endTangent(app.net, ends.from), tB = endTangent(app.net, ends.to);
  const conn = connect(app.linkKind, nodePos(ends.from), tA, nodePos(ends.to), tB);
  const pA = armsAt(app.net, ends.from)[0].profile.id, pB = armsAt(app.net, ends.to)[0].profile.id;
  let pieces;
  switch (conn.kind) {
    case 'none': return { reason: conn.reason };
    case 'corner': pieces = conn.pieces.map((p, i) => ({ ...p, profile: i === 0 ? pA : pB, profileB: pB })); break;
    case 'smooth': pieces = conn.pieces.map((p, i, all) => ({ ...p, profile: pA, profileB: i === all.length - 1 ? pB : pA })); break;
  }
  return { action: { type: 'chain', pieces, fromNode: ends.from, toNode: ends.to }, turn: G.signedTurn(tA, G.scale(tB, -1)) };
}

function refreshLink() {
  const l = app.link;
  if (l && !(isEnd(l.a) && (l.b === null || isEnd(l.b)))) app.link = null;
  show('linkBar', !!app.link);
  if (!app.link) { view.setGhost(null); view.setMarkers([]); return; }
  document.querySelectorAll('#linkKinds button').forEach(b => b.classList.toggle('on', b.dataset.kind === app.linkKind));
  const marker = id => { const n = app.net.nodes.get(id); return { x: n.x, z: n.z, y: nodeY(n) }; };
  view.setMarkers([l.a, l.b].filter(id => id !== null).map(marker));
  $('buildLink').disabled = true;
  if (l.b === null) {
    view.setGhost(null);
    $('linkInfo').innerHTML = `<span class="what">Tap a second road end</span>`;
    return;
  }
  const plan = linkPlan();
  if (plan.reason) {
    view.setGhost(null);
    $('linkInfo').innerHTML = `<span class="why">${LINK_TEXT[plan.reason]}</span>`;
    return;
  }
  const r = apply(app.net, plan.action);
  const plans = chainActions(app.net, plan.action).map(a => planBuild(app.net, a).plan);
  showGhost(r, plans);
  $('linkInfo').innerHTML = readout(plans, plan.turn, Math.min(...plans.map(p => G.minRadius(p.cv))), r.error);
  $('buildLink').disabled = !!r.error;
}

function buildLink() {
  if (!app.link || app.link.b === null) return;
  const plan = linkPlan();
  if (plan.action && run(plan.action)) { app.link = null; refreshDraft(); }
}

function setLinkKind(kind) {
  app.linkKind = kind;
  refreshDraft();
}


function startDraft(cx, cy) {
  app.draft = { from: null, fromLift: app.cursorLift, to: null, toLift: app.cursorLift, ctrl: null, fixed: false, dragging: null, tangent: null, cursor: null, arc: null };
  const r = snapAnchor(cx, cy, app.cursorLift, 'start');
  if (!r || (r.anchor.kind === 'free' && !inWorld(r.anchor.x, r.anchor.z))) { app.draft = null; return false; }
  app.draft.from = r.anchor;
  app.draft.tangent = r.tangent || null;
  if (r.lift !== undefined) app.draft.fromLift = app.draft.toLift = r.lift;
  if (r.anchor.kind === 'segment') {
    const c = segmentPath(app.net, app.net.segments.get(r.anchor.id));
    const p = anchorPos(r.anchor);
    const near = c.pts.reduce((b, q) => (Math.hypot(q.x - p[0], q.z - p[1]) < Math.hypot(b.x - p[0], b.z - p[1]) ? q : b));
    app.draft.fromLift = app.draft.toLift = Math.round(near.lift / LIFT_STEP) * LIFT_STEP;
  }
  refreshDraft();
  return true;
}

function cancelDraft() {
  app.draft = null;
  app.link = null;
  refreshDraft();
}

function buildDraft() {
  const action = draftAction();
  if (!action) return;
  const draft = app.draft, endPos = anchorPos(draft.to), lift = draft.toLift;
  app.draft = null;
  if (!run(action)) { app.draft = draft; refreshDraft(); return; }
  if (action.type === 'build') {
    const end = [...app.net.nodes.values()].find(n => Math.hypot(n.x - endPos[0], n.z - endPos[1]) < 0.5);
    if (end && classifyNode(app.net, end).kind === 'end') app.draft = { from: { kind: 'node', id: end.id }, fromLift: end.lift, to: null, toLift: end.lift, ctrl: null, fixed: false, dragging: null, tangent: null, cursor: null, arc: null };
  } else {
    const pair = carriagewayPair(endPos[0], endPos[1]);
    if (pair) app.draft = { from: { kind: 'free', x: pair.mid[0], z: pair.mid[1] }, fromLift: lift, to: null, toLift: lift, ctrl: null, fixed: false, dragging: null, tangent: pair.tangent, cursor: null, arc: null };
  }
  refreshDraft();
}

function changeLift(dir) {
  const d = app.draft;
  if (d && d.to && d.to.kind !== 'free' && !isDivided()) { toast('This end joins an existing road, so its height is fixed'); return; }
  if (d) {
    d.toLift = G.clamp(d.toLift + dir * LIFT_STEP, 0, MAX_LIFT);
    if (!d.to && d.from.kind === 'free') d.fromLift = d.toLift;
  }
  app.cursorLift = d ? d.toLift : G.clamp(app.cursorLift + dir * LIFT_STEP, 0, MAX_LIFT);
  if (!d) toast(`Next road starts ${app.cursorLift.toFixed(1)} m above ground`);
  refreshDraft();
}

$('buildDraft').addEventListener('click', buildDraft);
$('cancelDraft').addEventListener('click', cancelDraft);
$('raiseBtn').addEventListener('click', () => changeLift(1));
$('lowerBtn').addEventListener('click', () => changeLift(-1));
$('curveBtn').addEventListener('click', () => { app.curve = !app.curve; refreshDraft(); });
$('snapBtn').addEventListener('click', () => { app.snap = !app.snap; placeEnd(); });
const cycleTurn = () => { app.turnLock = (app.turnLock + 1) % TURN_LOCKS.length; placeEnd(); };
$('turnBtn').addEventListener('click', cycleTurn);
$('buildLink').addEventListener('click', buildLink);
$('cancelLink').addEventListener('click', cancelDraft);
$('linkKinds').addEventListener('click', e => { const b = e.target.closest('[data-kind]'); if (b) setLinkKind(b.dataset.kind); });

function setTool(t) {
  if (t === 'road' && app.tool === 'road') { show('picker', $('picker').classList.contains('hidden') && !app.draft); return; }
  app.tool = t;
  cancelDraft();
  show('picker', t === 'road' || t === 'upgrade');
  show('controls', false);
  app.picked = null;
  view.setPick(null);
  if (t !== 'inspect') { app.inspect = null; renderInspect(); }
  document.querySelectorAll('#tools [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
}
document.querySelectorAll('#tools [data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

function renderPicker() {
  $('picker').innerHTML = ROAD_OPTIONS.map(o => `<button data-road="${o.id}" class="${o.id === app.road ? 'on' : ''}">${optionName(o.id)}<small>${o.sub}</small></button>`).join('');
  $('roadBadge').textContent = ROAD_OPTIONS.find(o => o.id === app.road).badge;
}
$('picker').addEventListener('click', e => {
  const b = e.target.closest('[data-road]');
  if (!b) return;
  app.road = b.dataset.road;
  renderPicker();
  show('picker', false);
  if (app.tool === 'upgrade') toast(`Tap a road to make it ${optionName(app.road)}`);
  refreshDraft();
});
renderPicker();

function showControls(node) {
  const el = $('controls');
  el.innerHTML = CONTROL_OPTIONS.map(o => `<button data-control="${o.id}" class="${o.id === node.control ? 'on' : ''}">${o.name}<small>${o.sub}</small></button>`).join('');
  el.dataset.node = node.id;
  show('controls', true);
}
$('controls').addEventListener('click', e => {
  const b = e.target.closest('[data-control]');
  if (!b) return;
  const id = Number($('controls').dataset.node);
  if (run({ type: 'setControl', node: id, control: b.dataset.control })) {
    showControls(app.net.nodes.get(id));
    toast(CONTROL_OPTIONS.find(o => o.id === b.dataset.control).name);
  }
});

function tapTool(cx, cy) {
  switch (app.tool) {
    case 'connect': {
      const n = pickNode(cx, cy, 30);
      if (!n || !isEnd(n.id)) { toast('Tap the end of a road'); return; }
      const l = app.link;
      if (l && l.b === null && l.a !== n.id) l.b = n.id;
      else app.link = { a: n.id, b: null };
      refreshDraft();
      return;
    }
    case 'junction': {
      const n = pickNode(cx, cy, 30);
      if (!n) { show('controls', false); return; }
      if (classifyNode(app.net, n).kind !== 'intersection') { toast('Junction control works where three or more roads meet'); return; }
      showControls(n);
      return;
    }
    case 'upgrade': {
      const s = pickSegment(cx, cy);
      if (!s) return;
      const to = roadProfile();
      if (s.seg.profileA === to && s.seg.profileB === to) { toast(`Already ${profile(to).name}`); return; }
      if (run({ type: 'upgrade', seg: s.seg.id, profile: to })) toast(`Now ${profile(to).name}`);
      return;
    }
    case 'reverse': {
      const s = pickSegment(cx, cy);
      if (s && run({ type: 'reverse', seg: s.seg.id })) toast('Reversed');
      return;
    }
    case 'bulldoze': {
      const s = pickSegment(cx, cy);
      if (s) run({ type: 'bulldoze', seg: s.seg.id });
      return;
    }
    case 'inspect': {
      app.inspect = pickAny(cx, cy);
      renderInspect();
      return;
    }
  }
}

function renderInspect() {
  const p = app.inspect;
  const el = $('info');
  if (p && p.seg !== undefined && !app.net.segments.has(p.seg)) app.inspect = null;
  if (p && p.node !== undefined && !app.net.nodes.has(p.node)) app.inspect = null;
  if (!app.inspect) { show('info', false); view.setPick(null); return; }
  view.setPick(app.net, app.inspect, 'pick');
  if (app.inspect.seg !== undefined) {
    const seg = app.net.segments.get(app.inspect.seg);
    const path = segmentPath(app.net, seg);
    const pA = profile(seg.profileA), pB = profile(seg.profileB);
    const structures = [...new Set(path.pts.map(structureAt))].map(s => STRUCTURE_TEXT[s]).join(', ');
    const maxLift = Math.max(...path.pts.map(p => p.lift));
    const lanes = [...laneGraph(app.net).lanes.values()].filter(l => l.seg === seg.id).length;
    const cars = app.sim.cars.filter(c => { const id = c.route[c.ri]; return id.startsWith(`${seg.id}:`); }).length;
    el.innerHTML = `<h4>${pA.id === pB.id ? pA.name : `${pA.name} → ${pB.name} taper`}</h4>
      ${Math.round(path.L)} m · ${lanes} lanes · ${Math.round(Math.min(pA.speed, pB.speed) * 3.6)} km/h<br>
      ${pA.oneWay ? 'One way' : 'Two way'} · ${structures}<br>
      Highest point ${maxLift.toFixed(1)} m above ground<br>${cars} cars on it now`;
  } else {
    const node = app.net.nodes.get(app.inspect.node);
    const cls = classifyNode(app.net, node);
    const ctl = cls.kind === 'intersection' ? CONTROL_OPTIONS.find(o => o.id === node.control).name + (node.control === 'auto' ? ` (${controlKind(app.sim, node.id)})` : '') : 'free flow';
    el.innerHTML = `<h4>${KIND_TEXT[cls.kind]}</h4>${cls.arms.length} road${cls.arms.length === 1 ? '' : 's'} · ${ctl}<br>
      Height ${node.lift.toFixed(1)} m above ground
      <div class="row"><button data-lift="-1">▼ Lower</button><button data-lift="1">▲ Raise</button></div>`;
  }
  show('info', true);
}
$('info').addEventListener('click', e => {
  const b = e.target.closest('[data-lift]');
  if (!b || !app.inspect || app.inspect.node === undefined) return;
  const node = app.net.nodes.get(app.inspect.node);
  run({ type: 'setLift', node: node.id, lift: node.lift + Number(b.dataset.lift) * LIFT_STEP });
});

const press = { x: 0, y: 0, moved: false };
const drawing = () => app.tool === 'road';
const curving = () => app.curve || app.shift;

cam.attach({
  wantsPointer: () => app.tool !== 'camera',
  down(e) {
    press.x = e.clientX; press.y = e.clientY; press.moved = false;
    if (!drawing()) return;
    show('picker', false);
    const d = app.draft;
    if (!d) { if (startDraft(e.clientX, e.clientY)) app.draft.dragging = 'end'; return; }
    if (d.to && curving()) { d.dragging = 'ctrl'; setDraftCtrl(e.clientX, e.clientY); return; }
    d.dragging = 'end';
    if (d.fixed || e.pointerType !== 'mouse') setDraftEnd(e.clientX, e.clientY);
  },
  move(e) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) press.moved = true;
    const d = app.draft;
    if (!drawing() || !d || !d.dragging) return;
    if (d.dragging === 'ctrl') setDraftCtrl(e.clientX, e.clientY);
    else if (press.moved || d.fixed) setDraftEnd(e.clientX, e.clientY);
  },
  up(e) {
    if (!drawing()) { if (!press.moved) tapTool(e.clientX, e.clientY); return; }
    const d = app.draft;
    if (!d) return;
    if (d.dragging === 'end' && d.to && (press.moved || e.pointerType === 'mouse')) {
      if (!press.moved && e.pointerType === 'mouse' && !d.fixed) setDraftEnd(e.clientX, e.clientY);
      d.fixed = true;
    }
    d.dragging = null;
    refreshDraft();
  },
  cancel() { if (app.draft) app.draft.dragging = null; },
  hover(e) {
    if (drawing()) {
      const d = app.draft;
      if (d && !d.fixed) setDraftEnd(e.clientX, e.clientY);
      return;
    }
    if (app.tool === 'camera' || app.tool === 'inspect' && app.inspect) return;
    const nodeTool = app.tool === 'junction' || app.tool === 'connect';
    const pick = nodeTool ? (n => (n ? { node: n.id } : null))(pickNode(e.clientX, e.clientY, 30)) : (s => (s ? { seg: s.seg.id } : null))(pickSegment(e.clientX, e.clientY));
    const key = pick ? JSON.stringify(pick) : '';
    if (key === app.picked) return;
    app.picked = key;
    view.setPick(app.net, pick, app.tool === 'bulldoze' ? 'danger' : 'pick');
  },
});

const TOOL_KEYS = { 1: 'road', 2: 'connect', 3: 'junction', 4: 'upgrade', 5: 'reverse', 6: 'bulldoze', 7: 'inspect', 8: 'camera' };
addEventListener('keydown', e => {
  if (e.key === 'Shift') app.shift = true;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (TOOL_KEYS[e.key]) setTool(TOOL_KEYS[e.key]);
  if (e.key === 'Enter') { if (app.link) buildLink(); else buildDraft(); }
  if (e.key === 'Escape') { cancelDraft(); show('picker', false); show('controls', false); }
  if (e.key === 'r' || e.key === 'PageUp') { e.preventDefault(); changeLift(1); }
  if (e.key === 'f' || e.key === 'PageDown') { e.preventDefault(); changeLift(-1); }
  if (e.key === 'g') { app.snap = !app.snap; toast(app.snap ? 'Snap on: 15° turns and 5 m radii' : 'Snap off'); placeEnd(); }
  if (e.key === 't') { cycleTurn(); toast(`Turn: ${TURN_LOCKS[app.turnLock] ? TURN_LOCKS[app.turnLock] + '°' : 'Free'}`); }
  if (e.key === 'c' && app.tool === 'connect') setLinkKind(app.linkKind === 'smooth' ? 'corner' : 'smooth');
});
addEventListener('keyup', e => { if (e.key === 'Shift') app.shift = false; });

function hud() {
  $('carCount').textContent = app.sim.cars.length;
  const f = app.sim.flow;
  $('flowPct').textContent = f === null ? '–' : Math.round(f * 100) + '%';
  $('flow').style.setProperty('--flow', f === null ? '' : f > 0.8 ? '#2fa36b' : f > 0.55 ? '#d49a1f' : '#d9534f');
}
setInterval(hud, 500);

function setTraffic(t) {
  app.traffic = t;
  app.sim.traffic = t;
  document.querySelectorAll('#trafficSeg button').forEach(b => b.classList.toggle('on', b.dataset.traffic === t));
}
document.querySelectorAll('#trafficSeg button').forEach(b => b.addEventListener('click', () => setTraffic(b.dataset.traffic)));
setTraffic(app.traffic);
$('menuBtn').addEventListener('click', () => show('menu', true));
$('closeMenu').addEventListener('click', () => show('menu', false));
$('helpBtn').addEventListener('click', () => { show('menu', false); show('help', true); });
$('closeHelp').addEventListener('click', () => { show('help', false); try { localStorage.setItem(HELP_KEY, '1'); } catch {} });
$('newBtn').addEventListener('click', () => {
  show('menu', false);
  app.past = [];
  app.future = [];
  app.net = createWorld().net;
  app.sim = createSim(app.net, world.towns, { traffic: app.traffic });
  cancelDraft();
  networkChanged();
  frameStart();
  toast('A fresh map');
});
$('shareBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/maps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(save(app.net)) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'failed');
    const link = `${location.origin}/?map=${data.id}`;
    try { await navigator.clipboard.writeText(link); toast('Link copied: ' + link, 4000); } catch { toast(link, 6000); }
  } catch (err) {
    toast('Could not share: ' + err.message);
  }
});

function frameStart() {
  let best = null;
  for (let i = 0; i < world.towns.length; i++) for (let j = i + 1; j < world.towns.length; j++) {
    const a = world.towns[i], b = world.towns[j], d = Math.hypot(a.x - b.x, a.z - b.z);
    if (!best || d < best.d) best = { a, b, d };
  }
  cam.frame(best.a, best.b);
}

let last = performance.now(), acc = 0;
const STEP = 1 / 20;
function frame(now) {
  const dt = Math.min(0.3, (now - last) / 1000);
  last = now;
  cam.tick(dt);
  acc += dt;
  let n = 0;
  while (acc >= STEP && n++ < 6) { simTick(app.sim, STEP, app.rng); acc -= STEP; }
  if (n >= 6) acc = 0;
  view.updateCars(app.sim, world.towns);
  view.updateSignals(app.sim);
  view.render(cam.rig, cam.rig.dist);
  requestAnimationFrame(frame);
}

async function boot() {
  const mapId = new URLSearchParams(location.search).get('map');
  let loaded = null;
  if (mapId) {
    try {
      const res = await fetch('/api/maps/' + encodeURIComponent(mapId));
      if (res.ok) loaded = parse(await res.text());
      if (loaded && loaded.error) { toast('That shared map is damaged'); loaded = null; }
    } catch {}
  }
  if (!loaded) {
    try {
      const text = localStorage.getItem(SAVE_KEY);
      if (text) { const r = parse(text); if (!r.error) loaded = r; }
    } catch {}
  }
  if (loaded) {
    app.net = loaded.net;
    app.sim = createSim(app.net, world.towns, { traffic: app.traffic });
  }
  networkChanged();
  frameStart();
  let seen = false;
  try { seen = localStorage.getItem(HELP_KEY) === '1'; } catch {}
  show('help', !seen);
  requestAnimationFrame(frame);
}

window.__roads = {
  get net() { return app.net; },
  get sim() { return app.sim; },
  get app() { return app; },
  world,
  apply: action => run(action),
  project: (x, y, z) => view.project(x, y, z),
  setTool,
  setRoad: id => { app.road = id; renderPicker(); },
  counts: () => ({ nodes: app.net.nodes.size, segments: app.net.segments.size }),
  kinds: () => [...app.net.nodes.values()].map(n => classifyNode(app.net, n).kind),
  camera: cam,
  surfaceAt,
};

boot();
