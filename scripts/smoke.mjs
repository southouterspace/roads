// Drives the real page with pointer events: a divided highway, a viaduct, a curve and an off-ramp.
// Usage: node scripts/smoke.mjs  (serves src/ itself; set ROADS_URL to test a running server instead)
import assert from 'node:assert/strict';
import { openGame } from './page.mjs';

const { page, look, screen, settle, click, pickRoad, build, shot, close } = await openGame();
const start = await page.evaluate(() => window.__roads.counts());

await look(-60, 560, 950, 1.1, 0.35);
await pickRoad('div2');
await click(-300, 560);
await click(200, 560);
await shot('1-divided-draft.png');
await build();

await pickRoad('street');
for (let i = 0; i < 3; i++) await page.keyboard.press('r');
await click(-100, 470, 7.5);
await click(-100, 650, 7.5);
await build();

for (let i = 0; i < 3; i++) await page.keyboard.press('f');
await click(-260, 300);
await click(-150, 380);
await page.keyboard.down('Shift');
const bend = await screen(-150, 300);
const mid = await screen(-200, 340);
await page.mouse.move(mid.x, mid.y);
await page.mouse.down();
await page.mouse.move(bend.x, bend.y, { steps: 12 });
await page.mouse.up();
await page.keyboard.up('Shift');
await settle();
await shot('2-curve-draft.png');
await build();

await pickRoad('ramp');
await click(-40, 568);
await click(70, 640);
await shot('3-ramp-draft.png');
await build();

const result = await page.evaluate(() => {
  const r = window.__roads;
  const segs = [...r.net.segments.values()];
  return {
    counts: r.counts(),
    kinds: r.kinds().reduce((m, k) => ({ ...m, [k]: (m[k] || 0) + 1 }), {}),
    hw2: segs.filter(s => s.profileA === 'hw2').length,
    ramps: segs.filter(s => s.profileA === 'ramp').length,
    curved: segs.filter(s => s.profileA === 'street' && s.ctrl).length,
    viaduct: [...r.net.nodes.values()].filter(n => n.lift === 7.5).length,
  };
});
console.log(JSON.stringify(result));
assert.equal(result.counts.segments, start.segments + 6, 'divided 2 + viaduct 1 + curve 1 + ramp 1 + split 1');
assert.equal(result.counts.nodes, start.nodes + 10, 'divided 4 + viaduct 2 + curve 2 + gore 1 + ramp end 1');
assert.equal(result.hw2, 3);
assert.equal(result.ramps, 1);
assert.equal(result.curved, 1);
assert.equal(result.viaduct, 2);
assert.equal(result.kinds.diverge, 1);

await page.click('[data-tool="road"]');
await page.click('[data-road="avenue"]');
await page.keyboard.press('Escape');
const joined = await page.evaluate(() => {
  const r = window.__roads, near = (x, z) => [...r.net.nodes.values()].find(n => Math.hypot(n.x - x, n.z - z) < 1);
  return !!r.apply({ type: 'build', from: { kind: 'node', id: near(-380, 420).id }, to: { kind: 'node', id: near(-80, 780).id }, profile: 'avenue' });
});
assert.ok(joined, 'an avenue joins Brookvale and Elmstead across the highway');
await page.waitForTimeout(20000);
const traffic = await page.evaluate(() => ({ simSeconds: Math.round(window.__roads.sim.time), cars: window.__roads.sim.cars.length, kinds: window.__roads.kinds().filter(k => k === 'intersection').length }));
console.log(JSON.stringify(traffic));
assert.ok(traffic.cars > 0, 'cars are driving');

await look(-60, 560, 700, 1.0, 0.35);
await shot('4-overview.png');
await look(-100, 560, 140, 0.45, 1.3);
await shot('5-viaduct.png');
const gore = await page.evaluate(() => {
  const r = window.__roads, ids = [...r.net.nodes.keys()], kinds = r.kinds();
  const n = r.net.nodes.get(ids[kinds.indexOf('diverge')]);
  return { x: n.x, z: n.z };
});
await look(gore.x + 25, gore.z + 15, 110, 1.2, 0.2);
await shot('6-gore.png');
await look(-190, 340, 160, 0.9, 0.4);
await shot('7-curve.png');
const crossing = await page.evaluate(() => {
  const r = window.__roads;
  const n = [...r.net.nodes.values()].filter(n => r.kinds()[[...r.net.nodes.keys()].indexOf(n.id)] === 'intersection').sort((a, b) => b.z - a.z).find(n => n.z > 500 && n.z < 620);
  return n ? { x: n.x, z: n.z } : null;
});
if (crossing) { await look(crossing.x, crossing.z, 90, 0.7, 0.9); await shot('8-crossing.png'); }
await look(-560, 420, 260, 0.75, 0.6);
await shot('9-town.png');

await close();
console.log('smoke ok');
