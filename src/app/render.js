import * as THREE from 'three';
import { heightAt, surfaceAt, WORLD, HALF, WATER_LEVEL, RIVER_HALF_WIDTH, riverX } from '../net/terrain.js';
import { segmentPath, nodeLayout, laneGraph, structureAt, nodeY, laneId } from '../net/derive.js';
import { profile, deckWidth } from '../net/profiles.js';
import { MAX_CARS, controlKind, signalColour, mulberry32 } from '../net/sim.js';

export const ROAD_Y = 0.15;
const SLAB = 1.5;
const BARRIER = 1.0;
const PILLAR_SPACING = 36;
const SKY = 0xcfe3ea;

const lerp = (a, b, t) => a + (b - a) * t;

// Collects triangles for one material, then turns them into a mesh.
class Builder {
  constructor() { this.pos = []; this.idx = []; this.col = null; }
  vert(x, y, z) { this.pos.push(x, y, z); return this.pos.length / 3 - 1; }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  tri(a, b, c) { this.idx.push(a, b, c); }
  mesh(material, shadows = true) {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, material);
    m.receiveShadow = true;
    m.castShadow = shadows;
    return m;
  }
}

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createRenderer(canvas) {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.75 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 1800, 5200);
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 9000);

  scene.add(new THREE.HemisphereLight(0xeef6ff, 0x6f8a5a, 1.3));
  const sun = new THREE.DirectionalLight(0xffeedd, 2.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);

  const M = {
    asphalt: new THREE.MeshStandardMaterial({ color: 0x4d525a, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
    pad: new THREE.MeshStandardMaterial({ color: 0x4d525a, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }),
    white: new THREE.MeshBasicMaterial({ color: 0xf2f1ea, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12 }),
    yellow: new THREE.MeshBasicMaterial({ color: 0xf2c94c, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12 }),
    concrete: new THREE.MeshStandardMaterial({ color: 0xd3ccbf, roughness: 0.85 }),
    under: new THREE.MeshStandardMaterial({ color: 0xa69f92, roughness: 0.9 }),
    barrier: new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.7, side: THREE.DoubleSide }),
    island: new THREE.MeshStandardMaterial({ color: 0x6fb35a, roughness: 1 }),
    kerb: new THREE.MeshStandardMaterial({ color: 0xd9d4ca, roughness: 0.8 }),
  };
  const ghostMat = ok => new THREE.MeshBasicMaterial({ color: ok ? 0x37c47a : 0xe5484d, transparent: true, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -16 });
  const GHOST = { ok: ghostMat(true), bad: ghostMat(false), pick: new THREE.MeshBasicMaterial({ color: 0x3f8fd8, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -16 }), danger: ghostMat(false) };

  // Terrain
  const EXT = WORLD + 1600, RES = 300;
  const tg = new THREE.PlaneGeometry(EXT, EXT, RES, RES).rotateX(-Math.PI / 2);
  const tp = tg.attributes.position, colors = new Float32Array(tp.count * 3), c = new THREE.Color();
  for (let i = 0; i < tp.count; i++) {
    const x = tp.getX(i), z = tp.getZ(i), h = heightAt(x, z);
    tp.setY(i, h);
    const outside = Math.max(Math.abs(x), Math.abs(z)) > HALF;
    if (h < WATER_LEVEL) c.setHex(0xa89d7c);
    else if (h < WATER_LEVEL + 0.9) c.setHex(0xd8c99a);
    else c.setHSL(0.24 + Math.sin(x * 0.011 + z * 0.007) * 0.02, 0.36, 0.43 + (h / 30) * 0.08 + Math.sin(x * 0.05) * Math.cos(z * 0.043) * 0.015);
    if (outside) c.lerp(new THREE.Color(0x9fb88c), 0.35);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  tg.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  tg.computeVertexNormals();
  const terrain = new THREE.Mesh(tg, new THREE.MeshLambertMaterial({ vertexColors: true }));
  terrain.receiveShadow = true;
  scene.add(terrain);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(EXT, EXT).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x5fa8d8, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.88 }));
  water.position.y = WATER_LEVEL;
  scene.add(water);
  const edge = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x9fb88c }));
  edge.position.y = -2;
  scene.add(edge);
  const border = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
    Array.from({ length: 4 * 60 }, (_, i) => {
      const s = (i % 60) / 60, side = Math.floor(i / 60);
      const [x, z] = [[-HALF + s * WORLD, -HALF], [HALF, -HALF + s * WORLD], [HALF - s * WORLD, HALF], [-HALF, HALF - s * WORLD]][side];
      return new THREE.Vector3(x, surfaceAt(x, z) + 1, z);
    })), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
  scene.add(border);

  // Trees, hidden where roads are built
  const treeRng = mulberry32(99), trees = [];
  while (trees.length < 2600) {
    const x = (treeRng() - 0.5) * WORLD, z = (treeRng() - 0.5) * WORLD;
    const forest = Math.sin(x * 0.004 + 1.3) * Math.cos(z * 0.0035 - 0.4) + Math.sin(x * 0.011) * 0.4;
    if (forest < 0.35 && treeRng() > 0.08) continue;
    if (Math.abs(x - riverX(z)) < RIVER_HALF_WIDTH + 10) continue;
    trees.push({ x, z, s: 0.7 + treeRng() * 0.7, y: heightAt(x, z) });
  }
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.35, 0.5, 4, 6).translate(0, 2, 0), new THREE.MeshStandardMaterial({ color: 0x7a5a3c }), trees.length);
  const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(3.4, 9, 7).translate(0, 8, 0), new THREE.MeshStandardMaterial({ color: 0x4f8f48, roughness: 0.9, flatShading: true }), trees.length);
  crown.castShadow = true;
  const crownColor = new THREE.Color();
  trees.forEach((t, i) => { crownColor.setHSL(0.27 + treeRng() * 0.06, 0.4, 0.3 + treeRng() * 0.1); crown.setColorAt(i, crownColor); });
  scene.add(trunk, crown);
  const dummy = new THREE.Object3D();
  function placeTrees(blocked) {
    trees.forEach((t, i) => {
      dummy.position.set(t.x, t.y - 0.3, t.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(blocked(t.x, t.z) ? 0 : t.s);
      dummy.updateMatrix();
      trunk.setMatrixAt(i, dummy.matrix);
      crown.setMatrixAt(i, dummy.matrix);
    });
    trunk.instanceMatrix.needsUpdate = true;
    crown.instanceMatrix.needsUpdate = true;
  }

  // Towns
  const townGroup = new THREE.Group();
  scene.add(townGroup);
  let townTrees = () => false;
  function setTowns(towns) {
    townGroup.clear();
    const all = towns.flatMap(t => t.buildings.map(b => ({ ...b, color: t.color })));
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const windows = canvasTexture(64, 64, (g, w, h) => {
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(70,90,110,0.55)';
      for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) g.fillRect(4 + k * 15, 5 + r * 15, 9, 8);
    });
    windows.wrapS = windows.wrapT = THREE.RepeatWrapping;
    const mat = new THREE.MeshStandardMaterial({ map: windows, roughness: 0.7 });
    const inst = new THREE.InstancedMesh(box, mat, all.length);
    const roofs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.6, 1).translate(0, 0.3, 0), new THREE.MeshStandardMaterial({ color: 0x9aa2a8 }), all.length);
    inst.castShadow = roofs.castShadow = true;
    inst.receiveShadow = true;
    const col = new THREE.Color();
    all.forEach((b, i) => {
      const base = Math.min(heightAt(b.x - b.w / 2, b.z - b.d / 2), heightAt(b.x + b.w / 2, b.z + b.d / 2), heightAt(b.x, b.z)) - 1;
      dummy.position.set(b.x, base, b.z);
      dummy.rotation.set(0, b.rot, 0);
      dummy.scale.set(b.w, b.h + 1, b.d);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      dummy.position.y = base + b.h + 1;
      dummy.scale.set(b.w * 0.96, 1, b.d * 0.96);
      dummy.updateMatrix();
      roofs.setMatrixAt(i, dummy.matrix);
      col.set(b.color).lerp(new THREE.Color(0xf4f1ea), 0.25 + (i % 5) * 0.08);
      inst.setColorAt(i, col);
    });
    townGroup.add(inst, roofs);
    for (const t of towns) {
      const tex = canvasTexture(512, 128, (g, w, h) => {
        g.fillStyle = '#' + new THREE.Color(t.color).getHexString();
        g.beginPath();
        g.roundRect(8, 16, w - 16, h - 32, 44);
        g.fill();
        g.fillStyle = '#fff';
        g.font = '600 56px system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(t.name, w / 2, h / 2 + 2);
      });
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
      s.scale.set(0.16, 0.04, 1);
      s.position.set(t.x, heightAt(t.x, t.z) + 70, t.z);
      s.renderOrder = 20;
      townGroup.add(s);
    }
    townTrees = (x, z) => towns.some(t => Math.abs(x - t.x) < 150 && Math.abs(z - t.z) < 150);
  }

  // Road meshes
  const netGroup = new THREE.Group(), padGroup = new THREE.Group(), ghostGroup = new THREE.Group(), pickGroup = new THREE.Group();
  scene.add(netGroup, padGroup, ghostGroup, pickGroup);
  const segCache = new Map(), padCache = new Map();
  const pillarMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), M.concrete, 6000);
  pillarMesh.castShadow = pillarMesh.receiveShadow = true;
  pillarMesh.count = 0;
  scene.add(pillarMesh);
  const signalGroup = new THREE.Group();
  scene.add(signalGroup);
  let signals = [];

  const edgeY = (p, side) => Math.max(p.y, surfaceAt(p.x + side[0], p.z + side[1])) + ROAD_Y;

  function deckFrame(path) {
    return path.pts.map(p => {
      const r = [-p.tz, p.tx], hw = p.w / 2;
      const left = [-r[0] * hw, -r[1] * hw], right = [r[0] * hw, r[1] * hw];
      return { p, r, hw, yl: edgeY(p, left), yc: p.y + ROAD_Y, yr: edgeY(p, right), s: structureAt(p) };
    });
  }

  const deckYAt = (f, off) => {
    const t = Math.min(1, Math.abs(off) / f.hw);
    return off < 0 ? lerp(f.yc, f.yl, t) : lerp(f.yc, f.yr, t);
  };

  function buildSegment(net, seg, override) {
    const path = segmentPath(net, seg);
    const frames = deckFrame(path);
    const deck = new Builder(), skirt = new Builder(), under = new Builder(), barrier = new Builder(), white = new Builder(), yellow = new Builder();
    const pillars = [];
    let prev = null;
    for (const f of frames) {
      const { p, r, hw } = f;
      const L = [p.x - r[0] * hw, p.z - r[1] * hw], R = [p.x + r[0] * hw, p.z + r[1] * hw];
      const raised = f.s === 'viaduct' || f.s === 'bridge';
      const bottomL = raised ? f.yc - SLAB : surfaceAt(L[0], L[1]) - 0.8;
      const bottomR = raised ? f.yc - SLAB : surfaceAt(R[0], R[1]) - 0.8;
      const v = {
        l: deck.vert(L[0], f.yl, L[1]), c: deck.vert(p.x, f.yc, p.z), r: deck.vert(R[0], f.yr, R[1]),
        sl0: skirt.vert(L[0], f.yl, L[1]), sl1: skirt.vert(L[0], bottomL, L[1]),
        sr0: skirt.vert(R[0], f.yr, R[1]), sr1: skirt.vert(R[0], bottomR, R[1]),
        ul: under.vert(L[0], f.yc - SLAB, L[1]), ur: under.vert(R[0], f.yc - SLAB, R[1]),
        bl0: barrier.vert(L[0] + r[0] * 0.3, f.yl, L[1] + r[1] * 0.3), bl1: barrier.vert(L[0] + r[0] * 0.3, f.yl + BARRIER, L[1] + r[1] * 0.3),
        br0: barrier.vert(R[0] - r[0] * 0.3, f.yr, R[1] - r[1] * 0.3), br1: barrier.vert(R[0] - r[0] * 0.3, f.yr + BARRIER, R[1] - r[1] * 0.3),
        raised, walled: p.lift > 0.3,
      };
      if (prev) {
        deck.quad(prev.l, prev.c, v.c, v.l);
        deck.quad(prev.c, prev.r, v.r, v.c);
        skirt.quad(prev.sl0, prev.sl1, v.sl1, v.sl0);
        skirt.quad(prev.sr0, v.sr0, v.sr1, prev.sr1);
        if (raised || prev.raised) under.quad(prev.ul, v.ul, v.ur, prev.ur);
        if (v.walled && prev.walled) {
          barrier.quad(prev.bl0, v.bl0, v.bl1, prev.bl1);
          barrier.quad(prev.br0, prev.br1, v.br1, v.br0);
        }
      }
      prev = v;
    }
    if (frames.length) {
      for (const [k, sign] of [[0, -1], [frames.length - 1, 1]]) {
        const f = frames[k];
        if (f.s !== 'viaduct' && f.s !== 'bridge') continue;
        const { p, r, hw } = f;
        const a = skirt.vert(p.x - r[0] * hw, f.yl, p.z - r[1] * hw), b = skirt.vert(p.x + r[0] * hw, f.yr, p.z + r[1] * hw);
        const c2 = skirt.vert(p.x + r[0] * hw, f.yc - SLAB, p.z + r[1] * hw), d = skirt.vert(p.x - r[0] * hw, f.yc - SLAB, p.z - r[1] * hw);
        if (sign > 0) skirt.quad(a, b, c2, d); else skirt.quad(a, d, c2, b);
      }
    }
    for (let s = PILLAR_SPACING / 2; s < path.len - 6; s += PILLAR_SPACING) {
      let k = 0;
      while (k < path.cum.length - 1 && path.cum[k + 1] < s) k++;
      const f = frames[k];
      if (!f || (f.s !== 'viaduct' && f.s !== 'bridge') || s < 6) continue;
      const ground = heightAt(f.p.x, f.p.z) - 1;
      pillars.push({ x: f.p.x, z: f.p.z, y0: ground, y1: f.yc - SLAB + 0.05, w: Math.max(2, f.p.w * 0.5), heading: Math.atan2(f.p.tx, f.p.tz) });
    }
    buildMarkings(net, seg, path, frames, white, yellow);
    const g = new THREE.Group();
    const add = (b, mat, shadows) => { const m = b.mesh(override || mat, shadows); if (m) g.add(m); };
    add(deck, M.asphalt, false);
    add(skirt, M.concrete, true);
    add(under, M.under, true);
    add(barrier, M.barrier, true);
    if (!override) { add(white, M.white, false); add(yellow, M.yellow, false); }
    return { group: g, pillars };
  }

  // A ramp shares the mainline deck at its gore; its markings start where it leaves that deck.
  function goreCover(net, seg) {
    const decks = [];
    for (const nodeId of [seg.a, seg.b]) {
      const { cls } = nodeLayout(net, nodeId);
      if ((cls.kind !== 'diverge' && cls.kind !== 'merge') || cls.branch.seg !== seg.id) continue;
      const pts = segmentPath(net, net.segments.get(cls.main.seg)).pts;
      decks.push(cls.main.end === 'a' ? pts.slice(0, 80) : pts.slice(-80));
    }
    if (!decks.length) return () => false;
    return (x, z) => decks.some(pts => pts.some(p => {
      const dx = x - p.x, dz = z - p.z;
      return Math.abs(dx * p.tx + dz * p.tz) <= 1.2 && Math.abs(-dx * p.tz + dz * p.tx) < p.w / 2;
    }));
  }

  function line(b, frames, offsetAt, width, dash, period, covered) {
    let s = 0, prev = null;
    for (let k = 0; k < frames.length; k++) {
      const f = frames[k], o = offsetAt(k);
      const { p, r } = f;
      if (o === null || covered(p.x + r[0] * o, p.z + r[1] * o)) {
        prev = null;
        if (k + 1 < frames.length) s += Math.hypot(frames[k + 1].p.x - p.x, frames[k + 1].p.z - p.z);
        continue;
      }
      const y = deckYAt(f, o) + 0.03;
      const a = b.vert(p.x + r[0] * (o - width / 2), y, p.z + r[1] * (o - width / 2));
      const c2 = b.vert(p.x + r[0] * (o + width / 2), y, p.z + r[1] * (o + width / 2));
      if (prev) {
        const mid = (s + prev.s) / 2;
        if (!dash || mid % period < dash) b.quad(prev.a, prev.c, c2, a);
      }
      prev = { a, c: c2, s };
      if (k + 1 < frames.length) s += Math.hypot(frames[k + 1].p.x - p.x, frames[k + 1].p.z - p.z);
    }
  }

  function buildMarkings(net, seg, path, frames, white, yellow) {
    const { lanes } = laneGraph(net);
    const n = frames.length;
    const hwy = profile(seg.profileA).kind !== 'street';
    const covered = goreCover(net, seg);
    for (const dir of [1, -1]) {
      const mine = [];
      for (let i = 0; i < 4; i++) { const l = lanes.get(laneId(seg.id, dir, i)); if (l) mine.push(l); }
      if (!mine.length) continue;
      const lw = profile(seg.profileA).laneWidth;
      const at = (lane, k) => lane.offs[dir > 0 ? k : n - 1 - k];
      const toAB = o => o * dir;
      line(white, frames, k => toAB(at(mine[mine.length - 1], k) + lw / 2), 0.18, 0, 0, covered);
      const oneWay = profile(seg.profileA).oneWay;
      line(oneWay ? white : yellow, frames, k => toAB(at(mine[0], k) - lw / 2 + (oneWay ? 0 : 0.14)), 0.14, 0, 0, covered);
      for (let i = 0; i + 1 < mine.length; i++) {
        line(white, frames, k => {
          const a = at(mine[i], k), b = at(mine[i + 1], k);
          return Math.abs(b - a) > 2.4 ? toAB((a + b) / 2) : null;
        }, 0.14, hwy ? 4 : 3, hwy ? 12 : 9, covered);
      }
    }
  }

  function buildPad(net, node, override) {
    const layout = nodeLayout(net, node.id);
    const { cls } = layout;
    const two = cls.kind === 'end' && cls.arms[0] && !cls.arms[0].oneWay;
    if (layout.radius <= 0 && !two) return null;
    const pad = new Builder(), skirt = new Builder(), barrier = new Builder(), white = new Builder();
    const y = nodeY(node) + ROAD_Y;
    const centre = pad.vert(node.x, y, node.z);
    const ring = [];
    if (two) {
      const hw = deckWidth(cls.arms[0].profile) / 2 + 1.5;
      for (let k = 0; k < 28; k++) {
        const a = (k / 28) * Math.PI * 2, x = node.x + Math.cos(a) * hw, z = node.z + Math.sin(a) * hw;
        ring.push({ x, z, y: Math.max(y, surfaceAt(x, z) + ROAD_Y), edge: true });
      }
    } else {
      for (const arm of cls.arms) {
        const seg = net.segments.get(arm.seg), path = segmentPath(net, seg);
        const p = arm.end === 'a' ? path.pts[0] : path.pts[path.pts.length - 1];
        const away = arm.end === 'a' ? [p.tx, p.tz] : [-p.tx, -p.tz];
        const r = [-away[1], away[0]], hw = p.w / 2;
        const L = [p.x - r[0] * hw, p.z - r[1] * hw], R = [p.x + r[0] * hw, p.z + r[1] * hw];
        ring.push({ x: L[0], z: L[1], y: Math.max(p.y, surfaceAt(L[0], L[1])) + ROAD_Y, edge: false });
        ring.push({ x: R[0], z: R[1], y: Math.max(p.y, surfaceAt(R[0], R[1])) + ROAD_Y, edge: true });
        const kind = controlKind(state.sim, node.id);
        if (cls.kind === 'intersection' && arm.inCount > 0 && !override) {
          const lw = arm.profile.laneWidth, hwIn = arm.oneWay ? hw - arm.profile.shoulder : arm.inCount * lw + arm.profile.median / 2;
          const from = -hwIn, to = arm.oneWay ? hwIn : -0.2;
          const back = 0.8, dash = kind === 'yield' || kind === 'roundabout';
          const steps = Math.max(2, Math.ceil(Math.abs(to - from) / 0.9));
          for (let k = 0; k < steps; k++) {
            if (dash && k % 2) continue;
            const o0 = from + ((to - from) * k) / steps, o1 = from + ((to - from) * (k + 1)) / steps;
            const bx = p.x + away[0] * back, bz = p.z + away[1] * back;
            const q = (o, d) => white.vert(bx + r[0] * o + away[0] * d, p.y + ROAD_Y + 0.05, bz + r[1] * o + away[1] * d);
            white.quad(q(o0, -0.25), q(o1, -0.25), q(o1, 0.25), q(o0, 0.25));
          }
        }
      }
      if (layout.ring) {
        for (let k = 0; k < 36; k++) {
          const a = (k / 36) * Math.PI * 2, R = layout.ring.r + 4.5, x = node.x + Math.cos(a) * R, z = node.z + Math.sin(a) * R;
          ring.push({ x, z, y: Math.max(y - ROAD_Y, surfaceAt(x, z)) + ROAD_Y, edge: true, angle: a });
        }
      }
    }
    ring.forEach(v => { v.angle = Math.atan2(v.z - node.z, v.x - node.x); });
    ring.sort((a, b) => a.angle - b.angle);
    const ids = ring.map(v => pad.vert(v.x, v.y, v.z));
    for (let k = 0; k < ids.length; k++) pad.tri(centre, ids[(k + 1) % ids.length], ids[k]);
    const raised = node.lift > 0.3;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length];
      if (!a.edge && !two && !layout.ring) continue;
      const bottom = v => (node.lift >= 4 ? v.y - ROAD_Y - SLAB : surfaceAt(v.x, v.z) - 0.8);
      const a0 = skirt.vert(a.x, a.y, a.z), a1 = skirt.vert(a.x, bottom(a), a.z), b0 = skirt.vert(b.x, b.y, b.z), b1 = skirt.vert(b.x, bottom(b), b.z);
      skirt.quad(a0, b0, b1, a1);
      if (raised) {
        const c0 = barrier.vert(a.x, a.y, a.z), c1 = barrier.vert(a.x, a.y + BARRIER, a.z), d0 = barrier.vert(b.x, b.y, b.z), d1 = barrier.vert(b.x, b.y + BARRIER, b.z);
        barrier.quad(c0, d0, d1, c1);
      }
    }
    const g = new THREE.Group();
    const add = (b, mat, sh) => { const m = b.mesh(override || mat, sh); if (m) g.add(m); };
    add(pad, M.pad, false);
    add(skirt, M.concrete, true);
    add(barrier, M.barrier, true);
    if (!override) add(white, M.white, false);
    if (layout.ring && !override) {
      const isl = new THREE.Mesh(new THREE.CylinderGeometry(layout.ring.island, layout.ring.island + 0.3, 0.6, 40).translate(0, 0.3, 0), M.island);
      const kerb = new THREE.Mesh(new THREE.CylinderGeometry(layout.ring.island + 0.6, layout.ring.island + 0.6, 0.25, 40).translate(0, 0.12, 0), M.kerb);
      isl.position.set(node.x, y, node.z);
      kerb.position.set(node.x, y, node.z);
      isl.receiveShadow = kerb.receiveShadow = true;
      g.add(kerb, isl);
    }
    const pillars = node.lift >= 4 ? [{ x: node.x, z: node.z, y0: heightAt(node.x, node.z) - 1, y1: y - ROAD_Y - SLAB + 0.05, w: 3, heading: 0 }] : [];
    return { group: g, pillars };
  }

  const segSig = (net, seg) => {
    const path = segmentPath(net, seg), pts = path.pts, a = pts[0], b = pts[pts.length - 1], m = pts[pts.length >> 1];
    const f = p => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)},${p.w.toFixed(2)}`;
    return `${seg.profileA}|${seg.profileB}|${pts.length}|${f(a)}|${f(m)}|${f(b)}`;
  };
  const padSig = (net, node) => {
    const layout = nodeLayout(net, node.id);
    const arms = layout.cls.arms.map(a => {
      const path = segmentPath(net, net.segments.get(a.seg)), p = a.end === 'a' ? path.pts[0] : path.pts[path.pts.length - 1];
      return `${a.seg}${a.end}${p.x.toFixed(2)},${p.z.toFixed(2)},${p.w.toFixed(2)}`;
    });
    return `${node.x},${node.z},${node.lift},${node.control},${layout.cls.kind},${layout.radius.toFixed(2)},${controlKind(state.sim, node.id)}|${arms.join('|')}`;
  };

  const state = { net: null, sim: null };

  function disposeGroup(g) {
    g.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }

  function setNetwork(net, sim) {
    state.net = net;
    state.sim = sim;
    const seen = new Set();
    for (const seg of net.segments.values()) {
      seen.add(seg.id);
      const sig = segSig(net, seg), hit = segCache.get(seg.id);
      if (hit && hit.sig === sig) continue;
      if (hit) { netGroup.remove(hit.group); disposeGroup(hit.group); }
      const built = buildSegment(net, seg);
      segCache.set(seg.id, { sig, ...built });
      netGroup.add(built.group);
    }
    for (const [id, hit] of segCache) if (!seen.has(id)) { netGroup.remove(hit.group); disposeGroup(hit.group); segCache.delete(id); }
    const seenN = new Set();
    for (const node of net.nodes.values()) {
      seenN.add(node.id);
      const sig = padSig(net, node), hit = padCache.get(node.id);
      if (hit && hit.sig === sig) continue;
      if (hit && hit.group) { padGroup.remove(hit.group); disposeGroup(hit.group); }
      const built = buildPad(net, node);
      padCache.set(node.id, { sig, group: built ? built.group : null, pillars: built ? built.pillars : [] });
      if (built) padGroup.add(built.group);
    }
    for (const [id, hit] of padCache) if (!seenN.has(id)) { if (hit.group) { padGroup.remove(hit.group); disposeGroup(hit.group); } padCache.delete(id); }

    let n = 0;
    for (const list of [...[...segCache.values()].map(h => h.pillars), ...[...padCache.values()].map(h => h.pillars)]) {
      for (const p of list) {
        if (n >= pillarMesh.instanceMatrix.count) break;
        dummy.position.set(p.x, p.y0, p.z);
        dummy.rotation.set(0, p.heading, 0);
        dummy.scale.set(p.w, Math.max(0.1, p.y1 - p.y0), 1.8);
        dummy.updateMatrix();
        pillarMesh.setMatrixAt(n++, dummy.matrix);
      }
    }
    pillarMesh.count = n;
    pillarMesh.instanceMatrix.needsUpdate = true;
    pillarMesh.computeBoundingSphere();

    const cell = 24, grid = new Set();
    for (const seg of net.segments.values()) {
      for (const p of segmentPath(net, seg).pts) {
        if (p.lift > 4) continue;
        const r = Math.ceil((p.w / 2 + 4) / cell);
        const cx = Math.floor(p.x / cell), cz = Math.floor(p.z / cell);
        for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) grid.add((cx + i) * 100003 + (cz + j));
      }
    }
    placeTrees((x, z) => townTrees(x, z) || grid.has(Math.floor(x / cell) * 100003 + Math.floor(z / cell)));
    rebuildSignals(net);
  }

  function rebuildSignals(net) {
    signalGroup.clear();
    signals = [];
    if (!state.sim) return;
    const pole = new THREE.CylinderGeometry(0.15, 0.15, 6, 6).translate(0, 3, 0);
    const head = new THREE.BoxGeometry(0.6, 1.6, 0.6).translate(0, 6.2, 0);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3f45 });
    for (const node of net.nodes.values()) {
      if (controlKind(state.sim, node.id) !== 'signal') continue;
      const { cls } = nodeLayout(net, node.id);
      for (const arm of cls.arms) {
        if (arm.inCount === 0) continue;
        const path = segmentPath(net, net.segments.get(arm.seg));
        const p = arm.end === 'a' ? path.pts[0] : path.pts[path.pts.length - 1];
        const away = arm.end === 'a' ? [p.tx, p.tz] : [-p.tx, -p.tz];
        const travel = [-away[0], -away[1]], r = [-travel[1], travel[0]];
        const o = p.w / 2 + 0.6;
        const x = p.x + r[0] * o, z = p.z + r[1] * o, y = Math.max(p.y, surfaceAt(x, z)) + ROAD_Y;
        const mat = new THREE.MeshBasicMaterial({ color: 0xff3b3b });
        const g = new THREE.Group();
        g.add(new THREE.Mesh(pole, poleMat), new THREE.Mesh(head, mat));
        g.position.set(x, y, z);
        g.rotation.y = Math.atan2(travel[0], travel[1]);
        signalGroup.add(g);
        signals.push({ node: node.id, seg: arm.seg, mat });
      }
    }
  }

  const LIGHT = { red: 0xff3b3b, amber: 0xffb020, green: 0x3ddc84 };
  function updateSignals(sim) {
    for (const s of signals) s.mat.color.setHex(LIGHT[signalColour(sim, s.node, s.seg) || 'red']);
  }

  function clearGroup(g) {
    for (const o of [...g.children]) { g.remove(o); disposeGroup(o); }
  }

  // The ghost is the real road mesh from a candidate network, tinted.
  function setGhost(net, segIds, ok) {
    clearGroup(ghostGroup);
    if (!net) return;
    const mat = ok ? GHOST.ok : GHOST.bad;
    for (const id of segIds) {
      const seg = net.segments.get(id);
      if (seg) ghostGroup.add(buildSegment(net, seg, mat).group);
    }
  }

  function setPick(net, pick, kind) {
    clearGroup(pickGroup);
    if (!net || !pick) return;
    const mat = kind === 'danger' ? GHOST.danger : GHOST.pick;
    if (pick.seg !== undefined) {
      const seg = net.segments.get(pick.seg);
      if (seg) pickGroup.add(buildSegment(net, seg, mat).group);
    } else if (pick.node !== undefined) {
      const node = net.nodes.get(pick.node);
      if (!node) return;
      const built = buildPad(net, node, mat);
      if (built) pickGroup.add(built.group);
      else {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 0.4, 24), mat);
        m.position.set(node.x, nodeY(node) + ROAD_Y + 0.3, node.z);
        pickGroup.add(m);
      }
    }
  }

  // Markers for the draft: start, end and control point handles.
  const markerGeo = new THREE.SphereGeometry(1, 16, 12);
  const markerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 });
  const ctrlMat = new THREE.MeshBasicMaterial({ color: 0xffc23d, depthTest: false, transparent: true, opacity: 0.9 });
  const markers = [0, 1, 2].map(i => {
    const m = new THREE.Mesh(markerGeo, i === 2 ? ctrlMat : markerMat);
    m.renderOrder = 30;
    m.visible = false;
    scene.add(m);
    return m;
  });
  function setMarkers(points) {
    markers.forEach((m, i) => {
      const p = points[i];
      m.visible = !!p;
      if (!p) return;
      const d = camera.position.distanceTo(new THREE.Vector3(p.x, p.y, p.z));
      m.position.set(p.x, p.y + ROAD_Y + 0.5, p.z);
      m.scale.setScalar(Math.max(1, d * 0.008));
    });
  }

  // Cars
  const carParts = [
    new THREE.InstancedMesh(new THREE.BoxGeometry(1.8, 0.75, 4.4).translate(0, 0.65, 0), new THREE.MeshStandardMaterial({ roughness: 0.45 }), MAX_CARS),
    new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.6, 2.3).translate(0, 1.3, -0.25), new THREE.MeshStandardMaterial({ color: 0x2a3640, roughness: 0.3 }), MAX_CARS),
    new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.22, 0.08).translate(0, 0.75, 2.21), new THREE.MeshBasicMaterial({ color: 0xfff6d8 }), MAX_CARS),
    new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.22, 0.08).translate(0, 0.75, -2.21), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_CARS),
  ];
  const [carBody, , , carTail] = carParts;
  carBody.castShadow = true;
  const TAIL_OFF = new THREE.Color(0x7a1d1d), TAIL_ON = new THREE.Color(0xff3b3b);
  for (const p of carParts) {
    p.frustumCulled = false;
    p.count = 0;
    scene.add(p);
  }
  for (let n = 0; n < MAX_CARS; n++) { carBody.setColorAt(n, TAIL_OFF); carTail.setColorAt(n, TAIL_OFF); }
  const townColors = [];
  function updateCars(sim, towns) {
    if (townColors.length !== towns.length) towns.forEach((t, i) => { townColors[i] = new THREE.Color(t.color); });
    const cars = sim.cars;
    const n = Math.min(cars.length, MAX_CARS);
    for (let i = 0; i < n; i++) {
      const a = cars[i];
      dummy.position.set(a.x, a.y + ROAD_Y, a.z);
      dummy.rotation.set(-a.pitch, a.heading, 0, 'YXZ');
      dummy.scale.setScalar(Math.min(1, a.age * 3 + 0.2));
      dummy.updateMatrix();
      for (const part of carParts) part.setMatrixAt(i, dummy.matrix);
      carBody.setColorAt(i, townColors[a.color]);
      carTail.setColorAt(i, a.brake ? TAIL_ON : TAIL_OFF);
    }
    for (const part of carParts) { part.count = n; part.instanceMatrix.needsUpdate = true; }
    carBody.instanceColor.needsUpdate = true;
    carTail.instanceColor.needsUpdate = true;
  }

  function resize() {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }

  function render(focus, dist) {
    const span = Math.min(1600, Math.max(140, dist * 1.3));
    sun.position.set(focus.x + span * 0.6, surfaceAt(focus.x, focus.z) + span * 1.2, focus.z + span * 0.35);
    sun.target.position.set(focus.x, surfaceAt(focus.x, focus.z), focus.z);
    Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: span * 4 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.normalBias = span / 300;
    renderer.render(scene, camera);
  }

  const v3 = new THREE.Vector3();
  function project(x, y, z) {
    v3.set(x, y, z).project(camera);
    const r = canvas.getBoundingClientRect();
    return { x: r.left + ((v3.x + 1) / 2) * r.width, y: r.top + ((1 - v3.y) / 2) * r.height, behind: v3.z > 1 };
  }

  resize();
  addEventListener('resize', resize);
  return { renderer, scene, camera, setTowns, setNetwork, setGhost, setPick, setMarkers, updateCars, updateSignals, render, project, resize };
}
