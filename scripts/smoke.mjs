// Drives the real page with pointer events: a divided highway, a viaduct, a curve and an off-ramp.
// Usage: node scripts/smoke.mjs  (serves src/ itself; set ROADS_URL to test a running server instead)
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const out = fileURLToPath(new URL('./out/', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

async function serve() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    try {
      const body = await readFile(join(root, path === '/' ? 'index.html' : path));
      res.writeHead(200, { 'content-type': TYPES[extname(path)] || (path === '/' ? 'text/html' : 'application/octet-stream') });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

await mkdir(out, { recursive: true });
const local = process.env.ROADS_URL ? null : await serve();
const url = process.env.ROADS_URL || local.url;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const problems = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', e => problems.push(`pageerror: ${e.stack}`));

await page.goto(url);
await page.waitForFunction(() => window.__roads && window.__roads.counts().segments > 0);
await page.click('#closeHelp');
const start = await page.evaluate(() => window.__roads.counts());

const look = (x, z, dist, pitch = 1.0, yaw = 0.5) => page.evaluate(([x, z, dist, pitch, yaw]) => {
  Object.assign(window.__roads.camera.rig, { x, z, dist, pitch, yaw });
  window.__roads.camera.update();
}, [x, z, dist, pitch, yaw]);
const screen = (x, z, lift = 0) => page.evaluate(([x, z, lift]) => window.__roads.project(x, window.__roads.surfaceAt(x, z) + lift + 0.15, z), [x, z, lift]);
const settle = () => page.waitForTimeout(250);
async function click(x, z, lift = 0) {
  const s = await screen(x, z, lift);
  await page.mouse.move(s.x, s.y, { steps: 4 });
  await page.mouse.down();
  await page.mouse.up();
  await settle();
}
async function drag(x, z, lift = 0) {
  const s = await screen(x, z, lift);
  await page.mouse.down();
  await page.mouse.move(s.x, s.y, { steps: 12 });
  await page.mouse.up();
  await settle();
}
async function pickRoad(id) {
  await page.click('[data-tool="road"]');
  if (await page.locator('#picker').isHidden()) await page.click('[data-tool="road"]');
  await page.click(`[data-road="${id}"]`);
}
const build = async () => {
  assert.equal(await page.locator('#buildDraft').isDisabled(), false, `draft refused: ${await page.textContent('#draftInfo')}`);
  await page.click('#buildDraft');
  await settle();
  await page.keyboard.press('Escape');
};
const shot = name => page.screenshot({ path: join(out, name) });

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

await browser.close();
if (local) local.server.close();
assert.deepEqual(problems, [], problems.join('\n'));
console.log('smoke ok');
