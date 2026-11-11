import type { SectorDefinition } from './contracts.ts';

export function createSectorDefinition(layoutId: number, lengthM: number): SectorDefinition {
  if (!Number.isSafeInteger(layoutId) || layoutId < 0 || !Number.isFinite(lengthM) || lengthM <= 0) {
    throw new RangeError('A known layout ID and positive finite length are required');
  }
  const count = Math.max(1, Math.ceil(lengthM / 1500));
  if (count >= 2 ** 32 - 1) throw new RangeError('Layout has too many sectors');
  return Object.freeze({
    layoutId,
    layoutLengthM: lengthM,
    boundaries: Object.freeze(Array.from({ length: count + 1 }, (_, index) => index / count)),
  });
}
