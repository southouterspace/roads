const kmh = v => v / 3.6;

const TABLE = [
  { id: 'street', name: 'Street', lanesFwd: 1, lanesBack: 1, median: 0, shoulder: 1, speed: kmh(50), minRadius: 12, maxGrade: 0.10, oneWay: false, kind: 'street' },
  { id: 'avenue', name: 'Avenue', lanesFwd: 2, lanesBack: 2, median: 1.5, shoulder: 1, speed: kmh(60), minRadius: 20, maxGrade: 0.08, oneWay: false, kind: 'street' },
  { id: 'oneway', name: 'One-way', lanesFwd: 2, lanesBack: 0, median: 0, shoulder: 1, speed: kmh(50), minRadius: 12, maxGrade: 0.10, oneWay: true, kind: 'street' },
  { id: 'ramp', name: 'Ramp', lanesFwd: 1, lanesBack: 0, median: 0, shoulder: 1.5, speed: kmh(60), minRadius: 25, maxGrade: 0.08, oneWay: true, kind: 'ramp' },
  { id: 'ramp2', name: '2-lane ramp', lanesFwd: 2, lanesBack: 0, median: 0, shoulder: 1.5, speed: kmh(70), minRadius: 35, maxGrade: 0.08, oneWay: true, kind: 'ramp' },
  { id: 'hw2', name: 'Highway 2', lanesFwd: 2, lanesBack: 0, median: 4, shoulder: 2.5, speed: kmh(100), minRadius: 60, maxGrade: 0.06, oneWay: true, kind: 'highway' },
  { id: 'hw3', name: 'Highway 3', lanesFwd: 3, lanesBack: 0, median: 4, shoulder: 2.5, speed: kmh(110), minRadius: 80, maxGrade: 0.06, oneWay: true, kind: 'highway' },
];

export const PROFILES = new Map(TABLE.map(p => [p.id, Object.freeze({ ...p, laneWidth: 3.5 })]));

export const profile = id => PROFILES.get(id);

// A one-way profile's median is the strip it keeps from its twin when drawn as a divided highway.
export const deckWidth = p => (p.lanesFwd + p.lanesBack) * p.laneWidth + 2 * p.shoulder + (p.oneWay ? 0 : p.median);

export const pairOf = new Map([
  ['div2', { id: 'div2', name: 'Divided highway 2+2', carriageway: 'hw2' }],
  ['div3', { id: 'div3', name: 'Divided highway 3+3', carriageway: 'hw3' }],
]);

export const dividedOffset = carriagewayId => {
  const p = profile(carriagewayId);
  return p.median / 2 + deckWidth(p) / 2;
};

// Lane centre offsets to the right of the a→b direction, ordered left to right as the driver sees them.
export function laneOffsets(p, dir) {
  const w = p.laneWidth;
  if (p.oneWay) {
    if (dir < 0) return [];
    const n = p.lanesFwd;
    return Array.from({ length: n }, (_, i) => -n * w / 2 + (i + 0.5) * w);
  }
  const n = dir > 0 ? p.lanesFwd : p.lanesBack;
  const inner = p.median / 2;
  return Array.from({ length: n }, (_, i) => dir * (inner + (i + 0.5) * w));
}

export const lanesIn = (p, dir) => (dir > 0 ? p.lanesFwd : p.lanesBack);
