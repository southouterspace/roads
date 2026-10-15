// Serves src/ (or uses ROADS_URL), opens the game in Chromium and returns pointer helpers in world coordinates.
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

export async function openGame() {
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
  async function pickRoad(id) {
    await page.click('[data-tool="road"]');
    if (await page.locator('#picker').isHidden()) await page.click('[data-tool="road"]');
    await page.click(`[data-road="${id}"]`);
  }
  async function build(keepDrawing = false) {
    assert.equal(await page.locator('#buildDraft').isDisabled(), false, `draft refused: ${await page.textContent('#draftInfo')}`);
    await page.click('#buildDraft');
    await settle();
    if (!keepDrawing) await page.keyboard.press('Escape');
  }
  const shot = name => page.screenshot({ path: join(out, name) });
  async function close() {
    await browser.close();
    if (local) local.server.close();
    assert.deepEqual(problems, [], problems.join('\n'));
  }
  return { page, look, screen, settle, click, pickRoad, build, shot, close };
}
