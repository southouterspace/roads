# roads

A small browser road builder. You place houses and shops on a grid and connect them with roads. Cars leave houses, follow the shortest road route to a reachable shop, and earn $15 for each delivery. Roads cost $10, houses $50, and shops $100. Bulldozing refunds half the cost. It is plain HTML, ES modules, and canvas, with no build step and no dependencies. `src/sim.js` holds the pure simulation, `src/render.js` draws it, and `src/main.js` handles input and the game loop.

## Run

```sh
python3 -m http.server
```

Then open http://localhost:8000.

## Test

The tests need Node 22 or later.

```sh
npm test
```
