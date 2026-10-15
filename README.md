# Road Builder

A calm 3D road builder for mobile and desktop browsers, running on Cloudflare Workers.

**Play:** https://roads.southouterspace.workers.dev

Five towns sit on a 2.4 km map with hills and a river. Each town has its own small street grid, but nothing joins the towns yet. Build streets, avenues, divided highways, ramps, viaducts and bridges, and watch the traffic find its way. Each car is painted the colour of the town it is driving to. There is no money and no way to fail.

## Building

Every road is a curve between two nodes, with a height at each end and a road type. Junctions, ramps and structures follow from that. You never place a junction piece.

| Tool | What it does |
| --- | --- |
| Road | Draws a road. Tap the tool again to pick the type: Street, Avenue, One-way, Ramp, 2-lane ramp, Highway 2, Highway 3, or a divided highway (2+2 or 3+3), which draws both carriageways at once. |
| Junction | Tap an intersection to choose its control: Auto, Yield, All-way stop, Signals or Roundabout. |
| Upgrade | Tap a road to change it to the type picked in the Road menu. Its shape and connections stay. |
| Reverse | Tap a one-way road to swap its direction. |
| Bulldoze | Tap a road to remove it. |
| Inspect | Tap a road or node to see its lanes, speed, structure and height. Nodes can be raised or lowered here. |
| Camera | One finger or the left button moves the map instead of drawing. |

### Drawing a road

1. Tap where the road starts. Starting on the end of a road continues its direction. Starting on the side of a road splits it there, which is how a ramp leaves a highway.
2. Move to where the road ends and tap. Ending on a road joins it.
3. Tap **Build**. The next road starts where this one ended. `Esc` stops.

The ghost is green when the road can be built and red when it breaks a rule. The bar shows the length, the tightest radius, the steepest grade and the height at each end, and says which rule is broken.

| Rule | Meaning |
| --- | --- |
| Too short | Roads need at least 8 m. |
| Curve too tight | Each road type has a minimum radius, from 12 m for streets to 80 m for Highway 3. |
| Too steep | Streets allow 10 %, ramps and avenues 8 %, highways 6 %. |
| Clearance | Roads that cross at different heights need 5 m between them. Roads at the same height join with an intersection. |
| Sharp angle | Roads must meet at 20° or more, except where a ramp leaves or joins a carriageway. |
| Water | A road over the river must be raised. |
| Overlap | A road cannot run on top of another one. |

**Height.** ▲ and ▼ (or `R` / `F`, `PageUp` / `PageDown`) raise or lower the end you are placing in 2.5 m steps. A raised road gets retaining walls. Above 4 m it becomes a viaduct on pillars, or a bridge over the river.

**Curves.** Hold `Shift`, or turn on **Curve**, and drag to place the bend. **Snap** (`G`) keeps angles to 15° and lengths to 5 m.

**Flow** in the top bar shows how close cars get to free-flowing speed. Set the traffic level (Calm, Steady, Rush hour) in the menu.

## Controls

| Action | Touch | Mouse / keyboard |
| --- | --- | --- |
| Draw a road | Tap the start, drag the end, then **Build** | Click the start, click the end, then `Enter` |
| Bend a road | **Curve**, then drag | `Shift` + drag |
| Raise / lower the end | ▲ / ▼ | `R` / `F` |
| Pan | Two-finger drag, or the **Camera** tool | Middle drag, `WASD` or arrow keys |
| Zoom | Pinch | Wheel |
| Rotate and tilt | Two-finger twist | Right drag, or `Q` / `E` |
| Pick a tool | Toolbar | `1`–`7` |
| Undo / redo | ↶ / ↷ | `Ctrl+Z` / `Ctrl+Shift+Z` |

## How it's built

There is no build step. The page is plain ES modules, and Three.js is loaded from jsDelivr.

- `src/net/` is the game model. These are pure modules with no DOM and no Three.js.
  - `network.js` holds the nodes and segments. It is the only place that changes them, through `apply(net, action)`.
  - `validate.js` checks a road before it is built and names the rule it breaks.
  - `derive.js` works out everything else from the network: the 3D path of each segment, the junction kind at each node, the structure under the deck, and the lane graph.
  - `sim.js` runs the traffic over the lane graph: routing, car following, merging and right of way.
  - `profiles.js`, `geometry.js`, `terrain.js`, `world.js` and `save.js` hold the road types, the curve maths, the map, the starting towns and the save format.
- `src/app/` is the browser side: `main.js` (tools and UI), `render.js` (the Three.js scene) and `camera.js`.
- `src/worker.js` serves `src/` through the Workers assets binding, plus a small API for shareable maps:
  - `POST /api/maps` checks a map with the same parser the game uses and stores it in Workers KV (`MAPS` binding, kept for 1 year). It returns `{ id }`.
  - `GET /api/maps/:id` returns a stored map. The game opens `/?map=:id` links.
- Progress also autosaves to `localStorage`.

`docs/road-inventory.md` lists what the model covers and why the old tile grid was replaced.

## Develop and deploy

```sh
npm install
npm test                  # node --test: the model and the traffic sim
node scripts/smoke.mjs    # drives the page in Chromium; screenshots go to scripts/out/
npm run dev               # http://localhost:8787, with local KV
npm run deploy            # wrangler deploy, using the KV namespace in wrangler.jsonc
```
