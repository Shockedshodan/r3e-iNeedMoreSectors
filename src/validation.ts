import type { Combination, CurvePoint, LapReference } from './contracts.ts';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidCombination(value: unknown): value is Combination {
  return object(value) && Number.isSafeInteger(value.layoutId) && Number(value.layoutId) >= 0
    && Number.isSafeInteger(value.modelId) && Number(value.modelId) >= 0;
}

export function isValidBoundaries(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.length >= 2 && value[0] === 0 && value.at(-1) === 1
    && value.every((point: unknown, index: number) => typeof point === 'number'
      && Number.isFinite(point) && (index === 0 || point > value[index - 1]));
}

export function sameBoundaries(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((point, index) => point === right[index]);
}

export function isValidCurve(value: unknown): value is readonly CurvePoint[] {
  if (!Array.isArray(value) || value.length < 2) return false;
  let previousFraction = -1;
  let previousTime = 0;
  for (const point of value) {
    if (!object(point) || typeof point.fraction !== 'number' || typeof point.elapsedUs !== 'number'
      || !Number.isFinite(point.fraction) || !Number.isFinite(point.elapsedUs)
      || point.fraction < 0 || point.fraction > 1 || point.fraction <= previousFraction
      || point.elapsedUs < previousTime) return false;
    previousFraction = point.fraction;
    previousTime = point.elapsedUs;
  }
  return value[0].fraction === 0 && value[0].elapsedUs === 0
    && value.at(-1).fraction === 1 && value.at(-1).elapsedUs > 0;
}

export function isValidReference(value: unknown, sectorCount: number): value is LapReference {
  if (!object(value) || !Number.isSafeInteger(value.totalUs) || Number(value.totalUs) <= 0
    || !Array.isArray(value.sectors) || value.sectors.length !== sectorCount) return false;
  let sum = 0;
  for (const sector of value.sectors) {
    if (!object(sector) || !Number.isSafeInteger(sector.durationUs) || Number(sector.durationUs) <= 0
      || !isValidCurve(sector.curve) || sector.curve.length > 129
      || sector.curve.at(-1)!.elapsedUs !== sector.durationUs) return false;
    sum += Number(sector.durationUs);
  }
  return sum === value.totalUs;
}

/** Copy the schema-owned data rather than carrying arbitrary imported fields. */
export function copyReference(reference: LapReference): LapReference {
  return {
    totalUs: reference.totalUs,
    sectors: reference.sectors.map(sector => ({
      durationUs: sector.durationUs,
      curve: sector.curve.map(point => ({ fraction: point.fraction, elapsedUs: point.elapsedUs })),
    })),
  };
}

export function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) immutable(item);
    Object.freeze(value);
  }
  return value;
}
