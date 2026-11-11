import type { CurvePoint, LapReference, SectorDefinition } from './contracts.ts';
import { notImplemented } from './not-implemented.ts';

export function resampleSectorCurve(points: readonly CurvePoint[], intervals: number): readonly CurvePoint[] {
  return notImplemented('resampleSectorCurve');
}

export function referenceElapsedUs(reference: LapReference, definition: SectorDefinition, fraction: number): number | null {
  return notImplemented('referenceElapsedUs');
}

export function referenceDeltaUs(reference: LapReference, definition: SectorDefinition, fraction: number, currentElapsedUs: number): number | null {
  return notImplemented('referenceDeltaUs');
}
