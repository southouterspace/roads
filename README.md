# Road Builder

A 3D road-building town simulator for mobile browsers, running on Cloudflare Workers.

**Play:** https://roads.southouterspace.workers.dev

Pave roads to connect homes to shops. Cars drive between them in the right-hand lane, and each finished trip earns money. New buildings appear along your roads. Roads that cross water become bridges.

## Controls

| Action | Touch | Mouse |
| --- | --- | --- |
| Pave or bulldoze | One-finger drag | Left drag |
| Pan | Two-finger drag, or the **Move** tool | Middle drag, or the **Move** tool |
| Zoom | Pinch | Wheel |
| Rotate | Two-finger twist | Right drag, or `Q` / `E` |
| Undo | **Undo** button | `Ctrl+Z` |

## How it's built

- `src/index.html`: the whole game in one page. It uses Three.js (loaded from jsDelivr) with canvas-drawn textures, so there are no image assets.
- `src/worker.js`: a Worker that serves the page, the PWA manifest, and the icon, plus a small API for shareable maps:
  - `POST /api/maps` validates a map and stores it in Workers KV (`MAPS` binding, kept for 1 year). It returns `{ id }`.
  - `GET /api/maps/:id` returns a stored map. The game opens `/?map=:id` links.
- Progress also autosaves to `localStorage`.

## Develop and deploy

```sh
npm install
npm run dev      # http://localhost:8787, with local KV
npm run deploy   # wrangler deploy, using the KV namespace in wrangler.jsonc
```
