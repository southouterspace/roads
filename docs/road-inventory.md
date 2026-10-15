# Road inventory

This document lists what a road builder needs so you can build real road networks: elevated roads, off-ramps, curves and lane changes. It also explains why the tile grid had to go, and how each item maps to the data model in `src/net/`.

## Why the tile grid was replaced

The previous game stored the world as a 28 × 28 grid of tiles. Each tile had a ground layer and one deck layer, and roads ran north, south, east or west. That model cannot represent most of the items below:

- A curve is a sequence of tile corners, so the radius is fixed at one tile.
- Elevation has two values, ground and deck. A ramp is something the game adds for you. You cannot build a stacked interchange or set a grade.
- A tile holds one road, so two carriageways cannot run side by side. Without separate carriageways there is nothing for an off-ramp to leave from.
- Junctions are tiles with three or four arms at right angles, so a 20° gore where a ramp splits off cannot exist.

Adding features to the grid would not fix these limits. The new model is a graph of nodes and curved segments in continuous 3D space, which is the approach SimCity 4 Network Addon Mod, Cities: Skylines and real road design software use.

## Design rule: a road is a profile along a 3D curve

Every road in the game is defined by three things:

1. **Plan geometry.** A straight line or a curve between two nodes, drawn on the map.
2. **Vertical geometry.** The height of each node. The game blends heights along the segment with a smooth vertical curve.
3. **Cross-section.** A profile from the profile table. It sets lanes, lane width, direction, speed and limits.

Most items that look like separate pieces in other games come from these three. An elevated road is a road whose height is above the terrain. An on-ramp is a one-lane, one-way profile that ends at a merge node. A lane drop is a segment whose two ends use different profiles. You do not pick a separate piece for each case, and the game does not need a separate code path for each.

## The inventory

Each item has a priority. **Core** means the sandbox does not work without it. **Next** means it adds a lot but can wait. **Later** means it is nice to have. "Derived" means the game works it out from the model and you never place it directly.

### 1. Plan geometry

| Item | Priority | How it works |
| --- | --- | --- |
| Straight segment | Core | Segment with no control point. |
| Curve segment | Core | Quadratic Bézier with one control point. Two-click draw: start, then end, with the bend set by the tangent you are continuing or by dragging the control point. |
| Tangent continuation | Core | When you start drawing from the end of a road, the new curve leaves along that road's direction, so curves join smoothly with no kink. |
| Minimum radius | Core | Each profile sets a minimum radius. A tighter curve shows red and cannot be built. |
| Angle and length snapping | Core | 15° angle snap and 5 m length snap, toggled with a key. |
| Snap to node or segment | Core | Ending on an existing node joins it. Ending on a segment splits that segment and joins there. |
| S-curves and spirals | Next | Chain two curves. True clothoid transitions are left out, because a Bézier with tangent continuity looks right at this scale. |

### 2. Vertical geometry

| Item | Priority | How it works |
| --- | --- | --- |
| Node elevation | Core | Each node stores a lift above the terrain, in 2.5 m steps. Raise or lower it while drawing, or edit a node afterwards. |
| Grade | Core | The game interpolates height along the segment with a smoothstep curve, so ramps have a gentle start and finish. |
| Maximum grade | Core | Each profile sets a limit: streets 10 %, highways 6 %, ramps 8 %. A steeper segment cannot be built. |
| At-grade roads follow the terrain | Core | A segment whose ends both have zero lift follows the ground over hills. |
| Vertical clearance | Core | Two segments that cross in plan view need 5 m between them, or they must meet at a junction. |
| Banking (superelevation) | Later | Visual only. |

### 3. Structure (derived from height above terrain)

| Item | Priority | How it works |
| --- | --- | --- |
| At-grade road | Core | Deck sits on the terrain. |
| Retaining wall or embankment | Core | Lift between 0 and the pillar threshold. The deck gets solid side walls down to the ground. |
| Viaduct | Core | Lift above the threshold. The deck is a slab with barriers, and pillars are placed at a regular spacing. |
| Bridge over water | Core | A viaduct over water. Pillars stand in the water. |
| Tunnel or cutting | Next | Needs terrain that can be cut, which this version does not have. |

### 4. Cross-sections (the profile table)

Two-way roads are a single segment. A divided highway is two one-way carriageways. This is the most important choice in the model: an off-ramp leaves one carriageway, so a carriageway must be a segment of its own.

| Profile | Priority | Lanes | Speed | Min radius | Max grade |
| --- | --- | --- | --- | --- | --- |
| Street | Core | 1 + 1 | 50 km/h | 12 m | 10 % |
| Avenue | Core | 2 + 2 | 60 km/h | 20 m | 8 % |
| One-way street | Core | 2 one way | 50 km/h | 12 m | 10 % |
| Ramp | Core | 1 one way | 60 km/h | 25 m | 8 % |
| Two-lane ramp | Core | 2 one way | 70 km/h | 35 m | 8 % |
| Highway, 2-lane carriageway | Core | 2 one way | 100 km/h | 60 m | 6 % |
| Highway, 3-lane carriageway | Core | 3 one way | 110 km/h | 80 m | 6 % |
| Divided highway (draws both carriageways) | Core | 2 + 2 or 3 + 3 | as above | as above | as above |
| Lanes with turn pockets, bus lanes, bike lanes, sidewalks | Later | | | | |

### 5. Transitions along a road

| Item | Priority | How it works |
| --- | --- | --- |
| Taper (lane add or lane drop) | Core | A segment whose two ends use different profiles. The deck width blends from one to the other, and lanes that end merge into the lane next to them. |
| Profile change at a node | Core | Two segments with different profiles that meet at a two-way node. The node becomes a short taper. |
| Elevation transition (ramp up to a viaduct) | Core | Covered by vertical geometry. |
| Upgrade in place | Core | The Upgrade tool changes a segment's profile and keeps its geometry and connections. |
| Reverse direction | Core | Swaps the ends of a one-way segment. |

### 6. Nodes and junctions (derived from what meets at a node)

The game classifies each node from the segments that meet there. You do not place a junction type.

| Junction | Priority | When it happens |
| --- | --- | --- |
| Dead end | Core | One segment. Two-way roads get a turning circle. |
| Continuation | Core | Two segments in line. |
| Taper node | Core | Two segments with different profiles. |
| Diverge (off-ramp gore) | Core | Three one-way segments: one in and two out. The outgoing segment that is closer to straight ahead is the mainline. The rightmost lanes feed the exit. |
| Merge (on-ramp gore) | Core | Three one-way segments: two in and one out. The ramp lane joins on the right. If the outgoing road has fewer lanes than come in, the extra lane merges and the ramp yields to the mainline. |
| Intersection: T, cross or multi-way | Core | Three or more segments where at least one is two-way, or a mix that is not a clean merge or diverge. |
| Intersection control: yield, all-way stop, signals | Core | Set per node with the Junction tool. |
| Roundabout | Core | A junction control. Drawn as a ring, and entering traffic yields to the ring. |
| Grade separation | Core | Two segments that cross at different heights without a node. Checked by the clearance rule. |
| Automatic intersection on crossing | Core | Drawing across an at-grade road at the same height splits both segments and adds an intersection. |

### 7. Interchanges (assemblies, not pieces)

An interchange is a set of carriageways, ramps, merges and diverges. Real interchanges vary a lot, so the game does not treat them as fixed pieces. If you can build items 1 to 6, you can build any interchange by hand.

| Template | Priority | Notes |
| --- | --- | --- |
| Diamond | Next | Four ramps meeting a crossing street at two intersections. A stamp tool would place it as ordinary editable segments. |
| Partial cloverleaf (parclo) | Next | |
| Trumpet | Later | |
| Full cloverleaf | Later | Weaving makes it a poor design, so it is low priority. |
| Stack | Later | Needs four levels, which the elevation model already supports. |

### 8. Editing tools

| Tool | Priority |
| --- | --- |
| Draw road, with a live ghost that is red when the rule it breaks is shown (radius, grade, clearance, too short, too sharp an angle) | Core |
| Raise and lower while drawing, with the height shown | Core |
| Bulldoze a segment | Core |
| Upgrade or downgrade a profile | Core |
| Reverse a one-way segment | Core |
| Junction control | Core |
| Inspect a segment or node | Core |
| Undo and redo | Core |
| Move a node or bend a curve after it is built | Next |
| Parallel draw offset (draw a frontage road next to a highway) | Next |

### 9. Traffic (what makes the network a simulation)

| Item | Priority | How it works |
| --- | --- | --- |
| Lane graph | Core | Each segment produces one path per lane. Each node produces connector paths from incoming lanes to outgoing lanes, using the rules in section 6. |
| Routing | Core | Shortest travel time over the lane graph, with a cost added for busy lanes. |
| Car following | Core | Cars keep a gap to the car ahead in the same lane and slow down for curves. |
| Merging | Core | Cars on a ramp yield to the mainline when there is not enough gap. |
| Right of way at junctions | Core | Signals in phases, all-way stop one car at a time, roundabout and yield give way to traffic already in the junction. |
| Lane changes on a carriageway | Next | Cars currently pick their lane at the start of each segment. |
| Origins and destinations | Core | Towns placed on the world map send cars to one another. |

### 10. The world

| Item | Priority |
| --- | --- |
| A large map in metres (about 2.4 km across) with hills and a river | Core |
| Free camera: pan, orbit, zoom, tilt | Core |
| Follow a car | Next |
| Day and night | Later |
| Terrain editing | Later |

## What was left out, and why

- **Clothoid curves.** They matter for real highway design. In a game, Bézier curves that keep tangent continuity look the same.
- **A large set of fixed pieces**, such as a "45° elevated 3-lane off-ramp". A piece catalogue grows with every combination of profile, height and angle. The profile, height and curve model above covers all of them with three settings.
- **Terrain cuts and tunnels.** These need a terrain that can be edited. That is a separate project, and the model can add them later as another structure type.
- **Pedestrians, parking and zoning.** These make a city builder, not a road builder.
