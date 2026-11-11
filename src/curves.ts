import type { CurvePoint, LapReference, SectorDefinition } from './contracts.ts';
import { isValidBoundaries, isValidCurve, isValidReference } from './validation.ts';

function interpolate(points: readonly CurvePoint[], fraction: number): number {
  if (fraction === 0) return 0;
  for (let index = 1; index < points.length; index++) {
    const right = points[index];
    if (fraction <= right.fraction) {
      if (fraction === right.fraction) return right.elapsedUs;
      const left = points[index - 1];
      const progress = (fraction - left.fraction) / (right.fraction - left.fraction);
      return left.elapsedUs + progress * (right.elapsedUs - left.elapsedUs);
    }
  }
  return points.at(-1)!.elapsedUs;
}

export function resampleSectorCurve(points: readonly CurvePoint[], intervals: number): readonly CurvePoint[] {
  if (!isValidCurve(points) || !Number.isSafeInteger(intervals) || intervals <= 0 || intervals >= 2 ** 32 - 1) {
    throw new RangeError('A complete monotonic curve and positive interval count are required');
  }
  return Array.from({ length: intervals + 1 }, (_, index) => {
    const fraction = index / intervals;
    return { fraction, elapsedUs: interpolate(points, fraction) };
  });
}

export function referenceElapsedUs(reference: LapReference, definition: Pick<SectorDefinition, 'boundaries'>, fraction: number): number | null {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1
    || !isValidBoundaries(definition.boundaries)
    || !isValidReference(reference, definition.boundaries.length - 1)) return null;
  if (fraction === 1) return reference.totalUs;
  let offset = 0;
  for (let index = 0; index < reference.sectors.length; index++) {
    const start = definition.boundaries[index];
    const end = definition.boundaries[index + 1];
    const sector = reference.sectors[index];
    if (fraction < end) return offset + interpolate(sector.curve, (fraction - start) / (end - start));
    offset += sector.durationUs;
  }
  return null;
}

export function referenceDeltaUs(reference: LapReference, definition: Pick<SectorDefinition, 'boundaries'>, fraction: number, currentElapsedUs: number): number | null {
  if (!Number.isFinite(currentElapsedUs) || currentElapsedUs < 0) return null;
  const referenceTime = referenceElapsedUs(reference, definition, fraction);
  return referenceTime === null ? null : currentElapsedUs - referenceTime;
}
