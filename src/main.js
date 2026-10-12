import { TILES, createState, apply, tick } from './sim.js';
import { draw } from './render.js';

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const hud = {
  money: document.getElementById('money'),
  delivered: document.getElementById('delivered'),
  active: document.getElementById('active'),
};
const toolButtons = [...document.querySelectorAll('#tools button')];

let state = createState();
let tool = 'road';
let size = 32;
let hover = null;
let painting = false;
let lastPainted = null;

function actionFor(x, y) {
  return tool === 'bulldoze' ? { type: 'bulldoze', x, y } : { type: 'build', kind: tool, x, y };
}

function selectTool(next) {
  tool = next;
  for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
}

for (const b of toolButtons) {
  const cost = TILES[b.dataset.tool]?.cost;
  if (cost) b.textContent += ` $${cost}`;
  b.addEventListener('click', () => selectTool(b.dataset.tool));
}
selectTool(tool);

function resize() {
  size = Math.max(12, Math.floor(Math.min(window.innerWidth - 32, 800) / state.width));
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${state.width * size}px`;
  canvas.style.height = `${state.height * size}px`;
  canvas.width = state.width * size * dpr;
  canvas.height = state.height * size * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

function tileFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / size);
  const y = Math.floor((e.clientY - rect.top) / size);
  return x >= 0 && y >= 0 && x < state.width && y < state.height ? { x, y } : null;
}

function paint(tile) {
  if (!tile || (lastPainted && lastPainted.x === tile.x && lastPainted.y === tile.y)) return;
  lastPainted = tile;
  state = apply(state, actionFor(tile.x, tile.y));
}

canvas.addEventListener('pointerdown', (e) => {
  painting = true;
  lastPainted = null;
  canvas.setPointerCapture(e.pointerId);
  paint(tileFromEvent(e));
});
canvas.addEventListener('pointermove', (e) => {
  const tile = tileFromEvent(e);
  hover = tile;
  if (painting) paint(tile);
});
const stopPainting = () => {
  painting = false;
};
canvas.addEventListener('pointerup', stopPainting);
canvas.addEventListener('pointercancel', stopPainting);
canvas.addEventListener('pointerleave', () => {
  hover = null;
});

let last = performance.now();
function frame(now) {
  // Clamp so a backgrounded tab doesn't teleport cars on return.
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  state = tick(state, dt);
  const hoverView = hover && { ...hover, ok: apply(state, actionFor(hover.x, hover.y)) !== state };
  draw(ctx, state, { size, hover: hoverView });
  hud.money.textContent = state.money;
  hud.delivered.textContent = state.delivered;
  hud.active.textContent = state.cars.length;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
