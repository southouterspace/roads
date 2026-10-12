import { createState, apply, tick, metrics, index, STEP, ONEWAY } from './sim.js';
import { draw } from './render.js';
import { PRESETS } from './presets.js';

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');
const MAX_TICKS_PER_FRAME = 16;
const MIN_SCALE = 4;
const MAX_SCALE = 48;
const MAP = [96, 64];

const TOOLS = {
  street: (x, y) => ({ type: 'build', kind: 'street', x, y }),
  avenue: (x, y) => ({ type: 'build', kind: 'avenue', x, y }),
  oneway: (x, y, dir) => ({ type: 'oneway', x, y, dir }),
  signal: (x, y) => ({ type: 'signal', x, y }),
  home: (x, y) => ({ type: 'build', kind: 'house', x, y }),
  work: (x, y) => ({ type: 'build', kind: 'shop', x, y }),
  bulldoze: (x, y) => ({ type: 'bulldoze', x, y }),
  pan: null,
};

let state = createState(...MAP);
let tool = 'street';
let speed = 1;
let showJam = true;
let hover = null;
const view = { x: 0, y: 0, scale: 16 };
const size = { width: 1, height: 1, dpr: 1 };

// Demand slider is logarithmic: 0 is off, 100 is 3000 trips/min.
const demandFromSlider = (v) => (v <= 0 ? 0 : Math.round(10 * 300 ** (v / 100)));
const sliderFromDemand = (d) => (d <= 0 ? 0 : Math.round((100 * Math.log(d / 10)) / Math.log(300)));

function setDemand(d) {
  state = apply(state, { type: 'demand', tripsPerMinute: d });
  $('demand').value = sliderFromDemand(state.tripsPerMinute);
  $('demand-value').textContent = state.tripsPerMinute;
}

function selectTool(next) {
  tool = next;
  for (const b of document.querySelectorAll('#tools button')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  canvas.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
}

function selectSpeed(next) {
  speed = next;
  for (const b of document.querySelectorAll('#speed button')) b.setAttribute('aria-pressed', String(+b.dataset.speed === speed));
}

function loadExample(name) {
  const demand = state.tripsPerMinute;
  state = apply(PRESETS[name]?.build(createState(...MAP)) ?? createState(...MAP), { type: 'demand', tripsPerMinute: demand });
  fitView();
}

// Frame the built part of the map, or the whole map when it is empty.
function fitView() {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < state.kind.length; i++) {
    if (!state.kind[i]) continue;
    const x = i % state.width;
    const y = (i / state.width) | 0;
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  }
  if (x0 === Infinity) [x0, y0, x1, y1] = [0, 0, state.width - 1, state.height - 1];
  const w = x1 - x0 + 3;
  const h = y1 - y0 + 3;
  view.scale = clampScale(Math.min(size.width / w, size.height / h));
  view.x = (x0 + x1 + 1) / 2 - size.width / view.scale / 2;
  view.y = (y0 + y1 + 1) / 2 - size.height / view.scale / 2;
}

const clampScale = (s) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

function zoomAt(px, py, factor) {
  const tx = view.x + px / view.scale;
  const ty = view.y + py / view.scale;
  view.scale = clampScale(view.scale * factor);
  view.x = tx - px / view.scale;
  view.y = ty - py / view.scale;
}

function panBy(dxPx, dyPx) {
  view.x -= dxPx / view.scale;
  view.y -= dyPx / view.scale;
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  size.dpr = window.devicePixelRatio || 1;
  size.width = Math.max(1, rect.width);
  size.height = Math.max(1, rect.height);
  canvas.width = Math.round(size.width * size.dpr);
  canvas.height = Math.round(size.height * size.dpr);
}

function localPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return { px: e.clientX - rect.left, py: e.clientY - rect.top };
}

function tileAt(e) {
  const { px, py } = localPoint(e);
  const x = Math.floor(view.x + px / view.scale);
  const y = Math.floor(view.y + py / view.scale);
  return index(state, x, y) === null ? null : { x, y };
}

// Painting walks 4-connected steps between pointer samples so fast drags leave no gaps.
let paint = null;
const pointers = new Map();
let pinch = null;

function stepToward(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: from.x + Math.sign(dx), y: from.y, dir: dx > 0 ? 1 : 3 };
  return { x: from.x, y: from.y + Math.sign(dy), dir: dy > 0 ? 2 : 0 };
}

function paintTo(tile) {
  while (tile && (paint.last.x !== tile.x || paint.last.y !== tile.y)) {
    const step = stepToward(paint.last, tile);
    if (tool === 'oneway') {
      state = apply(state, TOOLS.oneway(paint.last.x, paint.last.y, step.dir));
      state = apply(state, TOOLS.oneway(step.x, step.y, step.dir));
    } else {
      state = apply(state, TOOLS[tool](step.x, step.y));
    }
    paint.last = step;
    paint.moved = true;
  }
}

function pinchInfo() {
  const [a, b] = [...pointers.values()];
  return { mx: (a.px + b.px) / 2, my: (a.py + b.py) / 2, dist: Math.hypot(a.px - b.px, a.py - b.py) };
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { ...localPoint(e), pan: e.button === 1 || e.button === 2 || tool === 'pan' });
  if (pointers.size === 2) {
    paint = null;
    pinch = pinchInfo();
    return;
  }
  const tile = tileAt(e);
  if (pointers.get(e.pointerId).pan || !tile) return;
  paint = { last: tile, moved: false };
  if (tool !== 'oneway') state = apply(state, TOOLS[tool](tile.x, tile.y));
});

canvas.addEventListener('pointermove', (e) => {
  const tile = tileAt(e);
  hover = tile;
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const now = localPoint(e);
  if (pointers.size === 2) {
    pointers.set(e.pointerId, { ...p, ...now });
    const next = pinchInfo();
    panBy(next.mx - pinch.mx, next.my - pinch.my);
    if (pinch.dist > 0) zoomAt(next.mx, next.my, next.dist / pinch.dist);
    pinch = next;
  } else if (p.pan) {
    panBy(now.px - p.px, now.py - p.py);
    pointers.set(e.pointerId, { ...p, ...now });
  } else if (paint) {
    paintTo(tile);
  }
});

function endPointer(e) {
  if (paint && tool === 'oneway' && !paint.moved) {
    const i = index(state, paint.last.x, paint.last.y);
    if (state.flags[i] & ONEWAY) state = apply(state, TOOLS.oneway(paint.last.x, paint.last.y, null));
  }
  paint = null;
  pinch = null;
  pointers.delete(e.pointerId);
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => {
  hover = null;
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const { px, py } = localPoint(e);
    zoomAt(px, py, Math.exp(-e.deltaY * 0.0015));
  },
  { passive: false },
);

const KEY_PAN = { ArrowLeft: [1, 0], a: [1, 0], ArrowRight: [-1, 0], d: [-1, 0], ArrowUp: [0, 1], w: [0, 1], ArrowDown: [0, -1], s: [0, -1] };
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const pan = KEY_PAN[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (pan) {
    e.preventDefault();
    panBy(pan[0] * 3 * view.scale, pan[1] * 3 * view.scale);
  } else if (e.key === '+' || e.key === '=') zoomAt(size.width / 2, size.height / 2, 1.25);
  else if (e.key === '-') zoomAt(size.width / 2, size.height / 2, 0.8);
});

// Hover validity asks the reducer: an unchanged state means the action would do nothing.
let hoverCache = { key: '', kind: null, flags: null, ok: false };
function hoverView() {
  if (!hover || !TOOLS[tool]) return null;
  const key = `${tool}:${hover.x},${hover.y}`;
  if (hoverCache.key !== key || hoverCache.kind !== state.kind || hoverCache.flags !== state.flags) {
    const i = index(state, hover.x, hover.y);
    const dir = state.flags[i] & ONEWAY ? null : 1;
    hoverCache = { key, kind: state.kind, flags: state.flags, ok: apply(state, TOOLS[tool](hover.x, hover.y, dir)) !== state };
  }
  return { ...hover, ok: hoverCache.ok };
}

const GRADE_COLORS = { A: '#2e7d32', B: '#7cb342', C: '#f9a825', D: '#ef6c00', F: '#c62828', '-': '#777' };
function updateHud() {
  const m = metrics(state);
  $('m-active').textContent = m.active;
  $('m-waiting').textContent = m.waiting;
  $('m-rate').textContent = m.perMinute.toFixed(0);
  $('m-delay').textContent = Number.isFinite(m.delayRatio) ? `${m.delayRatio.toFixed(2)}x` : '∞';
  $('m-abandoned').textContent = m.abandoned;
  const grade = $('m-grade');
  grade.textContent = m.grade;
  grade.style.background = GRADE_COLORS[m.grade];
}

for (const b of document.querySelectorAll('#tools button')) b.addEventListener('click', () => selectTool(b.dataset.tool));
for (const b of document.querySelectorAll('#speed button')) b.addEventListener('click', () => selectSpeed(+b.dataset.speed));
$('demand').addEventListener('input', (e) => setDemand(demandFromSlider(+e.target.value)));
$('jam').addEventListener('change', (e) => {
  showJam = e.target.checked;
});
$('zoom-in').addEventListener('click', () => zoomAt(size.width / 2, size.height / 2, 1.25));
$('zoom-out').addEventListener('click', () => zoomAt(size.width / 2, size.height / 2, 0.8));
$('fit').addEventListener('click', fitView);
const examples = $('examples');
for (const [name, { label }] of Object.entries(PRESETS)) examples.add(new Option(label, name));
examples.addEventListener('change', () => loadExample(examples.value));

new ResizeObserver(resize).observe(canvas);
resize();
selectTool(tool);
selectSpeed(speed);
setDemand(300);
examples.value = 'crossroads';
loadExample('crossroads');

let last = performance.now();
let acc = 0;
let hudAt = 0;
function frame(now) {
  acc += Math.min((now - last) / 1000, 0.25) * speed;
  last = now;
  let n = 0;
  for (; acc >= STEP && n < MAX_TICKS_PER_FRAME; n++) {
    state = tick(state, Math.random);
    acc -= STEP;
  }
  // A frame that hit the cap drops its backlog so a slow frame can't snowball into slower ones.
  if (n === MAX_TICKS_PER_FRAME) acc = 0;
  draw(ctx, state, view, { ...size, showJam, hover: hoverView() });
  if (now - hudAt > 250) {
    updateHud();
    hudAt = now;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.sandbox = { get state() { return state; }, view, size };
