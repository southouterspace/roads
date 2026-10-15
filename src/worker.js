import { parse, save } from './net/save.js';

const MAP_ID = /^\/api\/maps\/([a-z0-9]{10})$/;
const MAX_BYTES = 1_000_000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

async function createMap(request, env) {
  const text = await request.text();
  if (text.length > MAX_BYTES) return json({ error: 'map too large' }, 413);
  const result = parse(text);
  if (result.error) return json({ error: 'invalid map: ' + result.error }, 400);
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  await env.MAPS.put('map:' + id, JSON.stringify(save(result.net)), { expirationTtl: 60 * 60 * 24 * 365 });
  return json({ id }, 201);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/maps' && request.method === 'POST') return createMap(request, env);

    const match = pathname.match(MAP_ID);
    if (match && request.method === 'GET') {
      const map = await env.MAPS.get('map:' + match[1]);
      return map ? new Response(map, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' } }) : json({ error: 'not found' }, 404);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    return env.ASSETS.fetch(request);
  },
};
