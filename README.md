# roads

A browser traffic sandbox. You lay out roads, homes, and workplaces on a 96x64 grid and watch traffic find its way. Building is free. Poor layouts jam: cars take up real road space, queue behind each other, wait their turn at intersections, and back up into the homes they came from.

It is plain HTML, ES modules, and canvas, with no build step and no dependencies.

## Run

```sh
python3 -m http.server
```

Then open http://localhost:8000.

## Play

Tools:

- **Street.** One lane each way at 3 tiles per second.
- **Avenue.** Two lanes each way at 6 tiles per second. Paint over a street to upgrade it.
- **One-way.** Drag along a road to point it in the drag direction. A one-way tile carries twice the lanes in one direction. Click a one-way tile to make it two-way again.
- **Signal.** Click an intersection to add or remove a signal. Without a signal an intersection lets one car through at a time. With one, the green axis goes in both directions at once and the phases alternate every 6 seconds.
- **Home.** Makes trips. A home must touch a road.
- **Work.** Receives trips. Each trip goes to the workplace that is quickest to reach right now, so drivers move to a bypass when the main route is congested.
- **Bulldoze.** Clears a tile.
- **Pan.** Drag to move the map. You can also drag with the right or middle mouse button, use two fingers, or press the arrow keys or WASD. Zoom with the mouse wheel, a pinch, or the − and + buttons. **Fit** frames everything you have built.

Controls:

- **Examples** replaces the map with a preset. The first three serve the same homes and workplaces, so you can compare them directly. **Crossroads** sends every trip through one unsignalled street crossing. **Avenues + signal** has the same shape with avenues and a signal. **Street grid** spreads the trips over a lattice of streets. **City** fills the whole map with houses and a downtown in the east.
- **Demand** sets trips per minute, from 0 to 3000. The scale is logarithmic.
- **Pause, 1x to 8x** set the sim speed.
- **Congestion** tints roads from green (flowing) through amber to red (cars stuck).

The metrics bar shows cars driving, trips waiting at home because the road outside is full, arrivals per minute, average trip time divided by free-flow trip time, and trips that gave up. A car that cannot move for 120 sim seconds gives up, as does a trip that arrives at a home already holding 99 waiting trips. The letter grade comes from the trip-time ratio over the last minute, and time spent waiting at home counts as delay: below 1.3 is A, below 1.7 is B, below 2.3 is C, below 3.5 is D, and anything slower is F.

## Code

- `src/sim.js` holds the pure simulation. `apply(state, action)` edits the map and `tick(state, rng)` advances one fixed step of 1/60 s. Neither function mutates its input. Road behaviour comes from the `TILES` table and from one entry test, `canEnter`, which checks lane capacity, one-way direction, and the intersection or signal rule.
- `src/presets.js` builds the example layouts through `apply`.
- `src/render.js` draws the visible part of the map over a cached ground layer.
- `src/main.js` handles input, pan and zoom, and the fixed-step loop.

## Test and measure

These commands need Node 22 or later.

```sh
npm test          # unit tests, plus the preset comparison at 300 trips/min
npm run compare   # metrics for every preset at 60, 300 and 600 trips/min
npm run perf      # fills the City preset to 1500 cars, then reports ms per tick
```

`npm run compare -- 120 900` runs the comparison at other demands.
