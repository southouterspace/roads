import { TILES, TILE_NAMES, DIRS, ONEWAY, ONEWAY_DIR, SIGNAL, isIntersection, greenAxis, carPose, spec, neighbor } from './sim.js';

const G = 16; // px per tile in the cached ground layer
const CAR_COLORS = ['#ffca28', '#ef5350', '#29b6f6', '#ab47bc', '#ffffff', '#ff7043'];
const JAM_COLORS = ['#43a047', '#7cb342', '#c0ca33', '#fdd835', '#ffb300', '#fb8c00', '#f4511e', '#d50000'];

let ground = null;
let groundKey = [null, null];
let signals = [];

function paintGround(s) {
  const canvas = ground ?? document.createElement('canvas');
  canvas.width = s.width * G;
  canvas.height = s.height * G;
  const g = canvas.getContext('2d');
  g.fillStyle = TILES.grass.color;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = 'rgba(0,0,0,0.07)';
  g.beginPath();
  for (let x = 0; x <= s.width; x++) g.rect(x * G, 0, 0, canvas.height);
  for (let y = 0; y <= s.height; y++) g.rect(0, y * G, canvas.width, 0);
  g.stroke();

  signals = [];
  for (let i = 0; i < s.kind.length; i++) {
    const name = TILE_NAMES[s.kind[i]];
    const x = (i % s.width) * G;
    const y = ((i / s.width) | 0) * G;
    if (spec(s, i).road) {
      paintRoad(g, s, i, x, y);
      if (s.flags[i] & SIGNAL && isIntersection(s, i)) signals.push(i);
    } else if (name === 'house') {
      g.fillStyle = '#f3e5c8';
      g.fillRect(x + 4, y + 7, 8, 6);
      g.fillStyle = TILES.house.color;
      g.beginPath();
      g.moveTo(x + 2, y + 8);
      g.lineTo(x + 8, y + 2);
      g.lineTo(x + 14, y + 8);
      g.fill();
    } else if (name === 'shop') {
      g.fillStyle = TILES.shop.color;
      g.fillRect(x + 2, y + 3, 12, 11);
      g.fillStyle = '#fff';
      g.fillRect(x + 2, y + 3, 12, 3);
    }
  }
  return canvas;
}

function paintRoad(g, s, i, x, y) {
  const { color, lanes } = spec(s, i);
  const inset = lanes > 1 ? 0 : 2;
  g.fillStyle = color;
  g.fillRect(x + inset, y + inset, G - 2 * inset, G - 2 * inset);
  for (let d = 0; d < 4; d++) {
    const j = neighbor(s, i, d);
    if (j < 0 || s.kind[j] === 0) continue;
    const [dx, dy] = DIRS[d];
    if (dx) g.fillRect(dx > 0 ? x + G / 2 : x, y + inset, G / 2, G - 2 * inset);
    else g.fillRect(x + inset, dy > 0 ? y + G / 2 : y, G - 2 * inset, G / 2);
  }
  if (s.flags[i] & ONEWAY) {
    const [dx, dy] = DIRS[s.flags[i] & ONEWAY_DIR];
    const cx = x + G / 2;
    const cy = y + G / 2;
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(cx + dx * 6, cy + dy * 6);
    g.lineTo(cx - dx * 3 - dy * 4, cy - dy * 3 + dx * 4);
    g.lineTo(cx - dx * 3 + dy * 4, cy - dy * 3 - dx * 4);
    g.fill();
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} s sim state
 * @param {{x:number, y:number, scale:number}} view top-left in tiles, css px per tile
 * @param {{width:number, height:number, dpr:number, showJam:boolean, hover:null|{x:number,y:number,ok:boolean}}} opts
 */
export function draw(ctx, s, view, { width, height, dpr, showJam, hover }) {
  if (groundKey[0] !== s.kind || groundKey[1] !== s.flags) {
    ground = paintGround(s);
    groundKey = [s.kind, s.flags];
  }
  const k = view.scale * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#2f3b2a';
  ctx.fillRect(0, 0, width * dpr, height * dpr);
  ctx.setTransform(k, 0, 0, k, -view.x * k, -view.y * k);
  ctx.imageSmoothingEnabled = view.scale < G;
  ctx.drawImage(ground, 0, 0, s.width, s.height);

  const x0 = Math.max(0, Math.floor(view.x));
  const y0 = Math.max(0, Math.floor(view.y));
  const x1 = Math.min(s.width - 1, Math.floor(view.x + width / view.scale));
  const y1 = Math.min(s.height - 1, Math.floor(view.y + height / view.scale));

  if (showJam) {
    const paths = JAM_COLORS.map(() => new Path2D());
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * s.width + x;
        if (!spec(s, i).road) continue;
        // jam is the share of cars stuck on the tile; 0.45 and up already means a standing queue.
        paths[Math.min(JAM_COLORS.length - 1, Math.floor(s.jam[i] * 2 * JAM_COLORS.length))].rect(x, y, 1, 1);
      }
    }
    ctx.globalAlpha = 0.45;
    paths.forEach((path, b) => {
      ctx.fillStyle = JAM_COLORS[b];
      ctx.fill(path);
    });
    ctx.globalAlpha = 1;
  }

  drawCars(ctx, s, x0 - 1, y0 - 1, x1 + 1, y1 + 1);

  const axis = greenAxis(s.time);
  for (const i of signals) {
    const x = i % s.width;
    const y = (i / s.width) | 0;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    ctx.fillStyle = '#111';
    ctx.fillRect(x + 0.2, y + 0.2, 0.6, 0.6);
    ctx.fillStyle = '#ff1744';
    ctx.fillRect(x + 0.3, y + 0.3, 0.4, 0.4);
    ctx.fillStyle = '#00e676';
    if (axis === 0) ctx.fillRect(x + 0.4, y + 0.1, 0.2, 0.8);
    else ctx.fillRect(x + 0.1, y + 0.4, 0.8, 0.2);
  }

  if (hover) {
    ctx.fillStyle = hover.ok ? 'rgba(76,175,80,0.45)' : 'rgba(229,57,53,0.45)';
    ctx.fillRect(hover.x, hover.y, 1, 1);
    ctx.strokeStyle = hover.ok ? '#1b5e20' : '#b71c1c';
    ctx.lineWidth = 2 / view.scale;
    ctx.strokeRect(hover.x + 0.05, hover.y + 0.05, 0.9, 0.9);
  }
}

function drawCars(ctx, s, x0, y0, x1, y1) {
  for (let c = 0; c < CAR_COLORS.length; c++) {
    ctx.fillStyle = CAR_COLORS[c];
    ctx.beginPath();
    for (const car of s.cars) {
      if (car.id % CAR_COLORS.length !== c) continue;
      const { x, y, dir } = carPose(s, car);
      if (x < x0 || x > x1 + 1 || y < y0 || y > y1 + 1) continue;
      const { lanes } = spec(s, car.tile);
      const oneway = s.flags[car.tile] & ONEWAY;
      const slots = oneway ? 2 * lanes : lanes;
      const lane = car.id % slots;
      // Offset to the right of travel; one-way tiles spread cars across the whole width.
      const off = oneway ? -0.3 + (0.6 * (lane + 0.5)) / slots : 0.13 + 0.2 * lane;
      const [dx, dy] = DIRS[dir];
      const cx = x - dy * off;
      const cy = y + dx * off;
      const w = dx ? 0.34 : 0.2;
      const h = dx ? 0.2 : 0.34;
      ctx.rect(cx - w / 2, cy - h / 2, w, h);
    }
    ctx.fill();
  }
}
