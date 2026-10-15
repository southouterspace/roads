import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/net/world.js';
import { serialize, parse, save } from '../src/net/save.js';

test('save round-trips the starting world', () => {
  const { net } = createWorld();
  const text = serialize(net);
  const back = parse(text);
  assert.equal(back.error, undefined);
  assert.equal(back.net.nodes.size, net.nodes.size);
  assert.equal(back.net.segments.size, net.segments.size);
  assert.equal(serialize(back.net), text);
});

test('parse rejects malformed maps', () => {
  const good = save(createWorld().net);
  assert.equal(parse('{').error, 'invalid JSON');
  assert.equal(parse({ ...good, v: 2 }).error, 'unsupported version');
  assert.equal(parse({ ...good, nodes: [[1, 'x', 0, 0, 'auto'], ...good.nodes.slice(1)] }).error, 'bad node position');
  assert.equal(parse({ ...good, segments: [[good.nextId - 1, 999999, 1, null, 'street', 'street']] }).error, 'bad segment ends');
  assert.equal(parse({ ...good, segments: [...good.segments, [good.nextId + 5, 1, 2, null, 'street', 'street']] }).error, 'bad segment id');
  assert.equal(parse({ ...good, segments: good.segments.map((s, i) => (i ? s : [s[0], s[1], s[2], s[3], 'rocket', s[5]])) }).error, 'bad profile');
});
