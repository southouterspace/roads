// Connects two ground-level street ends on opposite banks of the river and checks that the route becomes a bridge.
// Usage: node scripts/bridge.mjs
import assert from 'node:assert/strict';
import { openGame } from './page.mjs';

const { page, look, settle, click, shot, close } = await openGame();
const river = 140 + 230 * Math.sin(0) + 70 * Math.sin(1.3);
const left = [river - 154, 0], right = [river + 154, 0];

const before = await page.evaluate(([left, right]) => {
  const r = window.__roads;
  const free = (x, z) => ({ kind: 'free', x, z });
  r.apply({ type: 'build', from: free(left[0] - 80, 0), to: free(...left), ctrl: null, profile: 'street' });
  r.apply({ type: 'build', from: free(right[0] + 80, 0), to: free(...right), ctrl: null, profile: 'street' });
  return r.counts();
}, [left, right]);

await look(river, 0, 420, 0.5, 0.6);
await page.click('[data-tool="connect"]');
await click(...left);
await click(...right);
await settle();
const info = await page.textContent('#linkInfo');
await shot('bridge-1-draft.png');
assert.equal(await page.isDisabled('#buildLink'), false, info);
await page.click('#buildLink');
await settle();

const after = await page.evaluate(() => {
  const r = window.__roads;
  const lifts = [...r.net.nodes.values()].filter(n => Math.abs(n.z) < 1 && n.x > 0 && n.x < 420).map(n => +n.lift.toFixed(2));
  return { counts: r.counts(), lifts };
});
console.log(`bridge: ${info}`, JSON.stringify(after));
assert.ok(after.counts.segments > before.segments + 2, 'the crossing is split into ramps and a deck');
assert.ok(after.lifts.some(l => l >= 4.5), 'some node is at bridge height');
await look(river, 0, 260, 0.35, 0.9);
await shot('bridge-2-built.png');
await close();
console.log('bridge ok');
