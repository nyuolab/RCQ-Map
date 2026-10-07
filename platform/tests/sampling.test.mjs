import test from "node:test";
import assert from "node:assert/strict";
import { createMulberry32, sampleIndices, sampleRows } from "../lib/sampling.js";

test("seeded sampling is deterministic and preserves source order", () => {
  assert.deepEqual(sampleIndices(10, 4, 42), [0, 3, 5, 7]);
  assert.deepEqual(sampleIndices(10, 4, 42), sampleIndices(10, 4, 42));
  assert.notDeepEqual(sampleIndices(10, 4, 42), sampleIndices(10, 4, 43));
});

test("sampling is without replacement and does not mutate source rows", () => {
  const rows = Array.from({ length: 100 }, (_, id) => ({ id }));
  const sampled = sampleRows(rows, 40, 42);

  assert.equal(sampled.length, 40);
  assert.equal(new Set(sampled.map((row) => row.id)).size, 40);
  assert.deepEqual(rows.map((row) => row.id), Array.from({ length: 100 }, (_, id) => id));
  assert.deepEqual(
    sampled.map((row) => row.id),
    [...sampled.map((row) => row.id)].sort((left, right) => left - right),
  );
});

test("sampling validates sizes and accepts any signed 32-bit seed", () => {
  assert.throws(() => sampleIndices(4, 5, 42), /Sample size/);
  assert.throws(() => sampleIndices(4, -1, 42), /Sample size/);
  assert.equal(typeof createMulberry32(-42)(), "number");
});
