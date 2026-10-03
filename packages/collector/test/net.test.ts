import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deltas, parseNettop } from '../src/net.ts';

const SAMPLE = `,bytes_in,bytes_out,
claude.33901,2267,4320,
claude.60333,1337950,69747585,
`;

test('parseNettop: reads claude.<pid> counters and nothing else', () => {
  const parsed = parseNettop(SAMPLE + 'node.123,99,99,\n');
  assert.deepEqual([...parsed.keys()], [33901, 60333]);
  assert.deepEqual(parsed.get(60333), { bytesIn: 1337950, bytesOut: 69747585 });
});

test('deltas: per-pid growth over the elapsed span', () => {
  const previous = new Map([[60333, { bytesIn: 1_000, bytesOut: 5_000, atMs: 0 }]]);
  const current = new Map([[60333, { bytesIn: 7_000, bytesOut: 2_000_000 }]]);
  assert.deepEqual(deltas(previous, current, 5_000).get(60333), {
    bytesIn: 6_000,
    bytesOut: 1_995_000,
    spanMs: 5_000,
  });
});

test('deltas: a counter reset or a new pid yields nothing rather than a guess', () => {
  const previous = new Map([[1, { bytesIn: 9_000, bytesOut: 9_000, atMs: 0 }]]);
  const current = new Map([
    [1, { bytesIn: 100, bytesOut: 100 }], // sockets reopened
    [2, { bytesIn: 500, bytesOut: 500 }], // first sighting
  ]);
  assert.equal(deltas(previous, current, 5_000).size, 0);
});
