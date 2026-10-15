// Drives the curve tools with real pointer events: snapped 15°, 30° and 45° turns, a 45° turn lock, and Connect.
// Usage: node scripts/curves.mjs
import assert from 'node:assert/strict';
import { openGame } from './page.mjs';

const { page, look, screen, settle, click, pickRoad, build, shot, close } = await openGame();
const DEG = Math.PI / 180;
const onArc = (p, turn, r) => [p[0] + r * Math.sin(turn), p[1] + r * (1 - Math.cos(turn))];

const net = fn => page.evaluate(fn);
const counts = () => net(() => window.__roads.counts());
// The heading change of the segment leaving the node at (x, z), from its start tangent [1, 0] to its end tangent.
const turnFrom = (x, z) => page.evaluate(([x, z]) => {
  const { net } = window.__roads;
  const node = [...net.nodes.values()].find(n => Math.hypot(n.x - x, n.z - z) < 0.5);
  const seg = [...net.segments.values()].find(s => s.a === node.id);
  const b = net.nodes.get(seg.b), c = seg.ctrl || [node.x, node.z];
  return Math.atan2(b.z - c[1], b.x - c[0]);
}, [x, z]);
async function hover(x, z) {
  const s = await screen(x, z);
  await page.mouse.move(s.x, s.y, { steps: 6 });
  await settle();
}

await look(450, -170, 640, 1.25, 0);
await pickRoad('street');

const curves = [[15, -320], [30, -200], [45, -80]];
for (const [d, z] of curves) {
  await click(300, z);
  await click(400, z);
  await build(true);
  const target = onArc([400, z], d * DEG, 160);
  await hover(...target);
  await click(...target);
  const info = await page.textContent('#draftInfo');
  assert.match(info, new RegExp(`^Turn ${d}° right · R \\d*[05] m`), info);
  await build();
  const turn = await turnFrom(400, z);
  console.log(`snapped ${d}°: built turn ${(turn / DEG).toFixed(4)}°, ${info}`);
  assert.ok(Math.abs(turn - d * DEG) < 0.01, `snapped ${d}° turn is ${turn / DEG}°`);
}
await shot('curves-1-snapped.png');

for (let i = 0; i < 3; i++) await page.keyboard.press('t');
assert.equal(await page.textContent('#turnBtn'), 'Turn: 45°');
await look(420, 60, 420, 1.25, 0);
await click(300, 40);
await click(400, 40);
await build(true);
await hover(470, 70);
await click(470, 70);
const locked = await page.textContent('#draftInfo');
assert.match(locked, /^Turn 45° right/, locked);
await shot('curves-2-locked-draft.png');
await build();
const lockedTurn = await turnFrom(400, 40);
console.log(`locked 45°: built turn ${(lockedTurn / DEG).toFixed(4)}°, ${locked}`);
assert.ok(Math.abs(lockedTurn - 45 * DEG) < 0.01, `locked turn is ${lockedTurn / DEG}°`);
for (let i = 0; i < 3; i++) await page.keyboard.press('t');
assert.equal(await page.textContent('#turnBtn'), 'Turn: Free');

const ends = await net(() => {
  const r = window.__roads;
  const free = (x, z) => ({ kind: 'free', x, z });
  r.apply({ type: 'build', from: free(430, 120), to: free(500, 120), ctrl: null, profile: 'street' });
  r.apply({ type: 'build', from: free(650, 270), to: free(650, 220), ctrl: null, profile: 'street' });
  return r.counts();
});
await look(570, 170, 360, 1.3, 0);
await page.click('[data-tool="connect"]');
await click(500, 120);
await click(650, 220);
await page.click('[data-kind="corner"]');
await settle();
const cornerInfo = await page.textContent('#linkInfo');
assert.match(cornerInfo, /^Turn 90° right · 250 m/, cornerInfo);
await page.click('#buildLink');
await settle();
const corner = await net(() => {
  const r = window.__roads, n = [...r.net.nodes.values()].find(n => Math.hypot(n.x - 650, n.z - 120) < 0.5);
  return { counts: r.counts(), cornerKind: n && r.kinds()[[...r.net.nodes.keys()].indexOf(n.id)] };
});
console.log(`corner: ${cornerInfo}`, JSON.stringify(corner));
assert.equal(corner.counts.segments, ends.segments + 2);
assert.equal(corner.cornerKind, 'continue');
await shot('curves-3-connect-corner.png');

await page.click('#undoBtn');
await settle();
assert.deepEqual(await counts(), ends, 'one undo removes the whole corner');

await click(500, 120);
await click(650, 220);
await page.click('[data-kind="smooth"]');
await settle();
const smoothInfo = await page.textContent('#linkInfo');
await shot('curves-4-connect-smooth-draft.png');
await page.keyboard.press('Enter');
await settle();
const smooth = await net(() => {
  const r = window.__roads, n = [...r.net.nodes.values()];
  const seg = [...r.net.segments.values()].find(s => s.ctrl && Math.hypot(s.ctrl[0] - 650, s.ctrl[1] - 120) < 0.5);
  return { counts: r.counts(), radius: seg ? (() => {
    const a = r.net.nodes.get(seg.a), b = r.net.nodes.get(seg.b);
    let best = Infinity;
    for (let i = 0; i <= 64; i++) {
      const t = i / 64, u = 1 - t;
      const d = [2 * u * (seg.ctrl[0] - a.x) + 2 * t * (b.x - seg.ctrl[0]), 2 * u * (seg.ctrl[1] - a.z) + 2 * t * (b.z - seg.ctrl[1])];
      const dd = [2 * (b.x - 2 * seg.ctrl[0] + a.x), 2 * (b.z - 2 * seg.ctrl[1] + a.z)];
      best = Math.min(best, Math.hypot(...d) ** 3 / Math.abs(d[0] * dd[1] - d[1] * dd[0]));
    }
    return best;
  })() : null, kinds: [[500, 120], [650, 220]].map(([x, z]) => r.kinds()[n.findIndex(m => Math.hypot(m.x - x, m.z - z) < 0.5)]) };
});
console.log(`smooth: ${smoothInfo}`, JSON.stringify(smooth));
assert.equal(smooth.counts.segments, ends.segments + 2, 'a straight and a fillet arc');
assert.ok(smooth.radius > 70, `smooth radius ${smooth.radius}`);
assert.deepEqual(smooth.kinds, ['continue', 'continue']);
await look(570, 170, 360, 1.3, 0);
await shot('curves-5-connect-smooth.png');

await page.setViewportSize({ width: 390, height: 844 });
await page.click('[data-tool="road"]');
await page.keyboard.press('Escape');
await look(500, -100, 520, 1.25, 0);
const end45 = onArc([400, -80], 45 * DEG, 160);
await click(...end45);
await hover(end45[0] + 30, end45[1] + 60);
assert.match(await page.textContent('#draftInfo'), /^Turn \d+° right · R \d+ m/);
await shot('curves-6-draft-390.png');
await page.keyboard.press('Escape');
await page.click('[data-tool="connect"]');
await look(740, 30, 420, 1.3, 0);
const free = await net(() => {
  const r = window.__roads, free = (x, z) => ({ kind: 'free', x, z });
  r.apply({ type: 'build', from: free(700, 60), to: free(780, 60), ctrl: null, profile: 'oneway' });
  r.apply({ type: 'build', from: free(700, 0), to: free(780, 0), ctrl: null, profile: 'oneway' });
  return true;
});
assert.ok(free);
await click(780, 60);
await click(780, 0);
const sameWay = await page.textContent('#linkInfo');
assert.equal(sameWay, 'Both ends carry traffic the same way');
await shot('curves-7-link-390.png');

await close();
console.log('curves ok');
