import { TILES, roadMask } from './sim.js';

const ROAD_DIRS = [
  [1, 0, -1],
  [2, 1, 0],
  [4, 0, 1],
  [8, -1, 0],
];

function drawRoad(ctx, state, x, y, s) {
  const mask = roadMask(state, x, y);
  const cx = x * s + s / 2;
  const cy = y * s + s / 2;
  const half = s * 0.32;
  ctx.fillStyle = TILES.road.color;
  ctx.fillRect(cx - half, cy - half, half * 2, half * 2);
  for (const [bit, dx, dy] of ROAD_DIRS) {
    if (!(mask & bit)) continue;
    const left = dx ? Math.min(cx, cx + (dx * s) / 2) : cx - half;
    const top = dy ? Math.min(cy, cy + (dy * s) / 2) : cy - half;
    ctx.fillRect(left, top, dx ? s / 2 : half * 2, dy ? s / 2 : half * 2);
  }
  ctx.strokeStyle = '#f5d76e';
  ctx.lineWidth = Math.max(1, s * 0.05);
  ctx.setLineDash([s * 0.12, s * 0.12]);
  ctx.beginPath();
  for (const [bit, dx, dy] of ROAD_DIRS) {
    if (!(mask & bit)) continue;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + (dx * s) / 2, cy + (dy * s) / 2);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawHouse(ctx, state, x, y, s) {
  const px = x * s;
  const py = y * s;
  ctx.fillStyle = '#f3e5c8';
  ctx.fillRect(px + s * 0.22, py + s * 0.45, s * 0.56, s * 0.4);
  ctx.fillStyle = TILES.house.color;
  ctx.beginPath();
  ctx.moveTo(px + s * 0.12, py + s * 0.48);
  ctx.lineTo(px + s * 0.5, py + s * 0.15);
  ctx.lineTo(px + s * 0.88, py + s * 0.48);
  ctx.fill();
}

function drawShop(ctx, state, x, y, s) {
  const px = x * s;
  const py = y * s;
  ctx.fillStyle = TILES.shop.color;
  ctx.fillRect(px + s * 0.12, py + s * 0.2, s * 0.76, s * 0.66);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(px + s * 0.12, py + s * 0.2, s * 0.76, s * 0.14);
  ctx.fillStyle = '#c5cae9';
  ctx.fillRect(px + s * 0.4, py + s * 0.56, s * 0.2, s * 0.3);
}

const PAINTERS = { grass: null, road: drawRoad, house: drawHouse, shop: drawShop };

const CAR_COLORS = ['#ffca28', '#ef5350', '#29b6f6', '#ab47bc', '#ffffff', '#ff7043'];

function drawCar(ctx, car, s) {
  const a = car.path[car.index];
  const b = car.path[Math.min(car.index + 1, car.path.length - 1)];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Shift perpendicular to travel so opposing cars use separate lanes.
  const lane = 0.14;
  const cx = (a.x + dx * car.progress + 0.5 - dy * lane) * s;
  const cy = (a.y + dy * car.progress + 0.5 + dx * lane) * s;
  const long = s * 0.3;
  const short = s * 0.18;
  const [w, h] = dy ? [short, long] : [long, short];
  ctx.fillStyle = CAR_COLORS[car.id % CAR_COLORS.length];
  ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
}

export function draw(ctx, state, { size, hover }) {
  const W = state.width * size;
  const H = state.height * size;
  ctx.fillStyle = TILES.grass.color;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= state.width; x++) {
    ctx.moveTo(x * size + 0.5, 0);
    ctx.lineTo(x * size + 0.5, H);
  }
  for (let y = 0; y <= state.height; y++) {
    ctx.moveTo(0, y * size + 0.5);
    ctx.lineTo(W, y * size + 0.5);
  }
  ctx.stroke();

  state.tiles.forEach((kind, i) => {
    PAINTERS[kind]?.(ctx, state, i % state.width, Math.floor(i / state.width), size);
  });

  for (const car of state.cars) drawCar(ctx, car, size);

  if (hover) {
    ctx.fillStyle = hover.ok ? 'rgba(76,175,80,0.4)' : 'rgba(229,57,53,0.4)';
    ctx.fillRect(hover.x * size, hover.y * size, size, size);
    ctx.strokeStyle = hover.ok ? '#1b5e20' : '#b71c1c';
    ctx.lineWidth = 2;
    ctx.strokeRect(hover.x * size + 1, hover.y * size + 1, size - 2, size - 2);
  }
}
