import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSectorDefinition } from '../src/sector-definition.ts';

for (const [lengthM, expectedBoundaries] of [
  [1, [0, 1]],
  [1500, [0, 1]],
  [1501, [0, 0.5, 1]],
  [3000, [0, 0.5, 1]],
  [4500, [0, 1 / 3, 2 / 3, 1]],
] as const) {
  test(`${lengthM} m layout uses ceil(length / 1500) equal sectors`, () => {
    const definition = createSectorDefinition(10, lengthM);
    assert.equal(definition.layoutId, 10);
    assert.equal(definition.layoutLengthM, lengthM);
    assert.deepEqual(definition.boundaries, expectedBoundaries);
  });
}

for (const length of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`rejects unavailable or nonfinite layout length ${length}`, () => {
    assert.throws(() => createSectorDefinition(10, length), RangeError);
  });
}

test('rejects unavailable layout ID rather than sharing an unknown layout', () => {
  assert.throws(() => createSectorDefinition(-1, 3000), RangeError);
});
