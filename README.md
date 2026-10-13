# Road Builder

A calm 3D traffic sandbox for mobile browsers, running on Cloudflare Workers.

**Play:** https://roads.southouterspace.workers.dev

Six color-coded districts (Homes, Downtown, Market, Factory, Stadium, Harbor) send cars to one another. Each car is painted the color of its destination. Build streets, highways, overpasses and intersections, and watch the traffic find its way. There is no money and no way to fail.

## Building

| Tool | What it does |
| --- | --- |
| Street | 30 mph, one lane each way. |
| Highway | 65 mph, two lanes each way. |
| Overpass | An elevated deck on pillars. Ramps are added at the ends, so it crosses roads and water without an intersection. Tap the tool again to switch between street and highway. |
| Junction | Tap an intersection to cycle between an all-way stop, traffic lights and a roundabout. |
| Bulldoze | Removes the top layer of each tile: the overpass deck, then the ramp, then the road. |
| Move | Pan with one finger. |

Road tools draw a straight line along one row or column. Drag to sketch it, then tap **Build** (or **✕** to discard).

**Flow** in the top bar shows how close cars get to free-flowing speed. Cars pick the quickest route, avoid busy tiles, and show brake lights when they slow down. Set the traffic level (Calm, Steady, Rush hour) and the optional ambient sound in the menu.

## Controls

| Action | Touch | Mouse / keyboard |
| --- | --- | --- |
| Sketch a road | One-finger drag, then **Build** | Left drag, then `Enter` (`Esc` cancels) |
| Pan | Two-finger drag, or the **Move** tool | Middle drag |
| Zoom | Pinch | Wheel |
| Rotate | Two-finger twist | Right drag, or `Q` / `E` |
| Pick a tool | Toolbar | `1`–`6` |
| Undo | ↶ | `Ctrl+Z` |

## How it's built

- `src/index.html`: the whole game in one page. It uses Three.js (loaded from jsDelivr) with canvas-drawn textures and instanced cars, so there are no image assets.
- `src/worker.js`: a Worker that serves the page, the PWA manifest and the icon, plus a small API for shareable maps:
  - `POST /api/maps` validates a map and stores it in Workers KV (`MAPS` binding, kept for 1 year). It returns `{ id }`.
  - `GET /api/maps/:id` returns a stored map. The game opens `/?map=:id` links.
- Progress also autosaves to `localStorage`.

## Develop and deploy

```sh
npm install
npm run dev      # http://localhost:8787, with local KV
npm run deploy   # wrangler deploy, using the KV namespace in wrangler.jsonc
```
