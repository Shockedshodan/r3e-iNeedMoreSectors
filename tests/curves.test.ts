import assert from 'node:assert/strict';
import { test } from 'node:test';
import { referenceDeltaUs, referenceElapsedUs, resampleSectorCurve } from '../src/curves.ts';
import { deepFreeze, definition, lap } from './helpers.ts';
import type { CurvePoint } from '../src/contracts.ts';

test('resamples a nonlinear measured curve, preserving its endpoints and shape', () => {
  const points = deepFreeze([
    { fraction: 0, elapsedUs: 0 },
    { fraction: 0.5, elapsedUs: 200_000 },
    { fraction: 1, elapsedUs: 1_000_000 },
  ]);
  assert.deepEqual(resampleSectorCurve(points, 4), [
    { fraction: 0, elapsedUs: 0 },
    { fraction: 0.25, elapsedUs: 100_000 },
    { fraction: 0.5, elapsedUs: 200_000 },
    { fraction: 0.75, elapsedUs: 600_000 },
    { fraction: 1, elapsedUs: 1_000_000 },
  ]);
});

test('128 intervals produce a bounded 129 points per sector without altering input', () => {
  const points = deepFreeze(lap().sectors[0].curve);
  const resampled = resampleSectorCurve(points, 128);
  assert.equal(resampled.length, 129);
  assert.deepEqual(resampled[0], { fraction: 0, elapsedUs: 0 });
  assert.deepEqual(resampled.at(-1), { fraction: 1, elapsedUs: 500_000 });
  for (let i = 1; i < resampled.length; i++) {
    assert.ok(resampled[i].fraction > resampled[i - 1].fraction);
    assert.ok(resampled[i].elapsedUs >= resampled[i - 1].elapsedUs);
  }
});

const malformedCurves: [string, CurvePoint[]][] = [
  ['empty', []],
  ['missing start', [{ fraction: 0.2, elapsedUs: 0 }, { fraction: 1, elapsedUs: 10 }]],
  ['missing finish', [{ fraction: 0, elapsedUs: 0 }, { fraction: 0.9, elapsedUs: 10 }]],
  ['nonzero origin time', [{ fraction: 0, elapsedUs: 2 }, { fraction: 1, elapsedUs: 10 }]],
  ['duplicate distance', [{ fraction: 0, elapsedUs: 0 }, { fraction: 0, elapsedUs: 1 }, { fraction: 1, elapsedUs: 10 }]],
  ['decreasing time', [{ fraction: 0, elapsedUs: 0 }, { fraction: 0.5, elapsedUs: 12 }, { fraction: 1, elapsedUs: 10 }]],
  ['nonfinite time', [{ fraction: 0, elapsedUs: 0 }, { fraction: 1, elapsedUs: Number.NaN }]],
  ['nonfinite distance', [{ fraction: 0, elapsedUs: 0 }, { fraction: Number.NaN, elapsedUs: 10 }]],
];
for (const [name, points] of malformedCurves) {
  test(`resampling rejects ${name} instead of manufacturing a usable trace`, () => {
    assert.throws(() => resampleSectorCurve(points, 128), RangeError);
  });
}

for (const intervals of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
  test(`rejects invalid resampling interval count ${intervals}`, () => {
    assert.throws(() => resampleSectorCurve(lap().sectors[0].curve, intervals), RangeError);
  });
}

for (const [fraction, expectedUs] of [
  [0, 0], [0.125, 40_000], [0.375, 280_000],
  [0.5, 400_000], [0.625, 460_000], [0.75, 640_000], [1, 1_000_000],
]) {
  test(`reference interpolation at lap distance ${fraction} yields ${expectedUs} us`, () => {
    assert.equal(referenceElapsedUs(lap([400_000, 600_000]), definition, fraction), expectedUs);
  });
}

test('Opt delta stitches custom sectors with preceding durations, not the game delta', () => {
  // At 75% distance: 400k preceding sector + 40% of the 600k sector = 640k.
  assert.equal(referenceDeltaUs(lap([400_000, 600_000]), definition, 0.75, 700_000), 60_000);
});

test('negative delta means faster than the saved reference', () => {
  assert.equal(referenceDeltaUs(lap([400_000, 600_000]), definition, 0.75, 600_000), -40_000);
});

for (const fraction of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`distance ${fraction} has no comparison rather than extrapolating`, () => {
    assert.equal(referenceElapsedUs(lap(), definition, fraction), null);
  });
}

test('unavailable current clock cannot produce a delta', () => {
  assert.equal(referenceDeltaUs(lap(), definition, 0.5, -1), null);
  assert.equal(referenceDeltaUs(lap(), definition, 0.5, Number.NaN), null);
});

test('a mismatched or malformed reference has no comparison', () => {
  assert.equal(referenceElapsedUs(lap([1_000_000]), definition, 0.5), null);
  assert.equal(referenceElapsedUs({ ...lap(), totalUs: 1 }, definition, 0.5), null);
  assert.equal(referenceElapsedUs(lap(), { ...definition, boundaries: [0, 0.8, 0.5, 1] }, 0.5), null);
});
