import * as THREE from 'three';
import { surfaceAt, HALF } from '../net/terrain.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const PAN_KEYS = { w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

export function createCameraRig(camera, canvas) {
  const rig = { x: 0, z: 0, dist: 900, yaw: 0.6, pitch: 0.85 };
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function update() {
    rig.pitch = clamp(rig.pitch, 0.22, 1.52);
    rig.dist = clamp(rig.dist, 25, 3200);
    rig.x = clamp(rig.x, -HALF, HALF);
    rig.z = clamp(rig.z, -HALF, HALF);
    const ty = surfaceAt(rig.x, rig.z), cp = Math.cos(rig.pitch);
    camera.position.set(rig.x + rig.dist * cp * Math.sin(rig.yaw), ty + rig.dist * Math.sin(rig.pitch), rig.z + rig.dist * cp * Math.cos(rig.yaw));
    const floor = surfaceAt(camera.position.x, camera.position.z) + 4;
    if (camera.position.y < floor) camera.position.y = floor;
    camera.lookAt(rig.x, ty, rig.z);
    camera.near = clamp(rig.dist / 200, 0.5, 20);
    camera.far = 9000;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  function rayFrom(cx, cy) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.ray;
  }

  // Where the pointer ray meets the ground raised by `lift` metres.
  function groundAt(cx, cy, lift = 0) {
    const { origin: o, direction: d } = rayFrom(cx, cy);
    const f = t => o.y + d.y * t - (surfaceAt(o.x + d.x * t, o.z + d.z * t) + lift);
    let t0 = 0, t1 = 0, step = Math.max(2, rig.dist / 150);
    if (f(0) < 0) return null;
    while (t1 < 12000) {
      t1 = t0 + step;
      if (f(t1) < 0) break;
      t0 = t1;
      step *= 1.04;
    }
    if (t1 >= 12000) return null;
    for (let i = 0; i < 24; i++) {
      const m = (t0 + t1) / 2;
      if (f(m) > 0) t0 = m; else t1 = m;
    }
    const t = (t0 + t1) / 2;
    return { x: o.x + d.x * t, z: o.z + d.z * t };
  }

  function planeAt(cx, cy, y) {
    const { origin: o, direction: d } = rayFrom(cx, cy);
    if (Math.abs(d.y) < 1e-6) return null;
    const t = (y - o.y) / d.y;
    return t > 0 ? { x: o.x + d.x * t, z: o.z + d.z * t } : null;
  }

  function panScreen(ax, ay, bx, by) {
    const y = surfaceAt(rig.x, rig.z);
    const a = planeAt(ax, ay, y), b = planeAt(bx, by, y);
    if (!a || !b) return;
    rig.x += a.x - b.x;
    rig.z += a.z - b.z;
    update();
  }

  function zoomAt(cx, cy, factor) {
    const hit = groundAt(cx, cy);
    const before = rig.dist;
    rig.dist = clamp(rig.dist * factor, 25, 3200);
    if (hit) {
      const k = 1 - rig.dist / before;
      rig.x += (hit.x - rig.x) * k;
      rig.z += (hit.z - rig.z) * k;
    }
    update();
  }

  // Routes pointers: one finger or left button goes to the active tool, two fingers or the other buttons move the camera.
  function attach(handlers) {
    const pointers = new Map();
    let gesture = null, multi = null;
    const twoFinger = () => {
      const [a, b] = [...pointers.values()];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, span: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x) };
    };
    canvas.addEventListener('pointerdown', e => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        if (e.pointerType === 'mouse' && e.button === 2) gesture = 'orbit';
        else if (e.pointerType === 'mouse' && e.button === 1) gesture = 'pan';
        else if (handlers.wantsPointer()) { gesture = 'tool'; handlers.down(e); }
        else gesture = 'pan';
      } else if (pointers.size === 2) {
        if (gesture === 'tool') handlers.cancel(e);
        gesture = 'multi';
        multi = twoFinger();
      } else gesture = 'none';
    });
    canvas.addEventListener('pointermove', e => {
      const p = pointers.get(e.pointerId);
      if (!p) { if (e.pointerType === 'mouse') handlers.hover(e); return; }
      const px = p.x, py = p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (gesture === 'tool') handlers.move(e);
      else if (gesture === 'pan') panScreen(px, py, p.x, p.y);
      else if (gesture === 'orbit') { rig.yaw -= (p.x - px) * 0.006; rig.pitch += (p.y - py) * 0.004; update(); }
      else if (gesture === 'multi' && pointers.size === 2) {
        const m = twoFinger();
        panScreen(multi.x, multi.y, m.x, m.y);
        if (m.span > 10 && multi.span > 10) zoomAt(m.x, m.y, multi.span / m.span);
        let da = m.ang - multi.ang;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        rig.yaw -= da;
        update();
        multi = m;
      }
    });
    const end = e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (gesture === 'tool') handlers.up(e);
      gesture = pointers.size === 0 ? null : 'none';
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * 0.0012)); }, { passive: false });
    document.addEventListener('gesturestart', e => e.preventDefault());
  }

  const held = new Set();
  addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey) return;
    if (PAN_KEYS[e.key]) held.add(e.key);
    if (e.key === 'q') { rig.yaw += 0.15; update(); }
    if (e.key === 'e') { rig.yaw -= 0.15; update(); }
  });
  addEventListener('keyup', e => held.delete(e.key));
  addEventListener('blur', () => held.clear());

  function tick(dt) {
    if (!held.size) return;
    let mx = 0, mz = 0;
    for (const k of held) { mx += PAN_KEYS[k][0]; mz += PAN_KEYS[k][1]; }
    const s = rig.dist * 0.9 * dt, c = Math.cos(rig.yaw), si = Math.sin(rig.yaw);
    rig.x += (mx * c + mz * si) * s;
    rig.z += (-mx * si + mz * c) * s;
    update();
  }

  // Looks across the line from a to b so both sit side by side on screen.
  function frame(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z, span = Math.hypot(dx, dz);
    rig.x = (a.x + b.x) / 2;
    rig.z = (a.z + b.z) / 2;
    const portrait = camera.aspect < 1;
    rig.yaw = portrait ? Math.atan2(-dx, -dz) : Math.atan2(dx, dz) + Math.PI / 2;
    rig.dist = span * (portrait ? 1.25 : 0.95) + 250;
    rig.pitch = portrait ? 1.1 : 0.95;
    update();
  }

  update();
  return { rig, update, groundAt, planeAt, attach, tick, frame };
}
