import html from './index.html';

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#7dbb53"/><path d="M38 100 L46 0 H54 L62 100 Z" fill="#3d4148"/><path d="M50 8v12M50 32v12M50 56v12M50 80v12" stroke="#f2c94c" stroke-width="4"/></svg>';
const MANIFEST = JSON.stringify({
  name: 'Road Builder',
  short_name: 'Roads',
  start_url: '/',
  display: 'fullscreen',
  background_color: '#9fd6ee',
  theme_color: '#9fd6ee',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
});
const MAP_ID = /^\/api\/maps\/([a-z0-9]{10})$/;
const CELL = /^[.twdG][.sh0-7][.sh][xgo]$/;
const TRAFFIC = ['calm', 'steady', 'rush'];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

async function createMap(request, env) {
  const text = await request.text();
  if (text.length > 20000) return json({ error: 'map too large' }, 413);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const n = Number(data.n);
  const grid = typeof data.grid === 'string' ? data.grid : '';
  const cellsOk = Number.isInteger(n) && n >= 8 && n <= 64 && grid.length === n * n * 4 && (grid.match(/.{4}/g) || []).every(c => CELL.test(c));
  const districtsOk = Array.isArray(data.districts) && data.districts.length <= 12 &&
    data.districts.every(d => Array.isArray(d) && d.length === 5 && d.every(v => Number.isInteger(v) && v >= 0 && v < 64));
  if (data.v !== 2 || !cellsOk || !districtsOk) return json({ error: 'invalid map' }, 400);
  const map = { v: 2, n, grid, districts: data.districts, traffic: TRAFFIC.includes(data.traffic) ? data.traffic : 'steady' };
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  await env.MAPS.put('map:' + id, JSON.stringify(map), { expirationTtl: 60 * 60 * 24 * 365 });
  return json({ id }, 201);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/maps' && request.method === 'POST') return createMap(request, env);

    const match = pathname.match(MAP_ID);
    if (match && request.method === 'GET') {
      const map = await env.MAPS.get('map:' + match[1]);
      return map ? new Response(map, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' } }) : json({ error: 'not found' }, 404);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    if (pathname === '/' || pathname === '/index.html') {
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
    }
    if (pathname === '/manifest.webmanifest') return new Response(MANIFEST, { headers: { 'content-type': 'application/manifest+json' } });
    if (pathname === '/icon.svg') return new Response(ICON, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
    return new Response('Not found', { status: 404 });
  },
};
