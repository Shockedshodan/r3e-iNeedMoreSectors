import type {
  FinishResult, LapCandidate, LapReference, RecordBook, SectorDefinition,
  SectorReference, StorageLike, TimingFrame,
} from '../src/contracts.ts';

export const combination = { layoutId: 10, modelId: 20 };
export const definition: SectorDefinition = {
  layoutId: 10, layoutLengthM: 3000, boundaries: [0, 0.5, 1],
};

export function sector(durationUs: number): SectorReference {
  return {
    durationUs,
    curve: [
      { fraction: 0, elapsedUs: 0 },
      { fraction: 0.25, elapsedUs: durationUs * 0.1 },
      { fraction: 0.5, elapsedUs: durationUs * 0.4 },
      { fraction: 1, elapsedUs: durationUs },
    ],
  };
}

export function lap(durations: readonly number[] = [500_000, 500_000]): LapReference {
  return { totalUs: durations.reduce((sum, value) => sum + value, 0), sectors: durations.map(sector) };
}

export function book(durations: readonly number[] | null = null): RecordBook {
  return {
    schemaVersion: 1, ...combination, boundaries: [...definition.boundaries],
    best: durations ? lap(durations) : null,
    opt: durations ? lap(durations) : null,
  };
}

export function candidate(durations: readonly number[] = [500_000, 500_000], overrides: Partial<LapCandidate> = {}): LapCandidate {
  return {
    ...combination, boundaries: [...definition.boundaries], complete: true, valid: true,
    reference: lap(durations), ...overrides,
  };
}

export class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  writes: { key: string; value: string }[] = [];
  failReads = false;
  failWrites = false;
  getItem(key: string): string | null {
    if (this.failReads) throw new Error('Storage unavailable');
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('Quota exceeded');
    this.writes.push({ key, value });
    this.values.set(key, value);
  }
}

export function result(overrides: Partial<FinishResult> = {}): FinishResult {
  return {
    ...combination, sessionId: 'practice-1', completedLap: 1, valid: true,
    totalUs: 1_000_000, officialSectorDurationsUs: [300_000, 300_000, 400_000],
    ...overrides,
  };
}

export function frame(overrides: Partial<TimingFrame> = {}): TimingFrame {
  return {
    ...combination, sessionId: 'practice-1', observedAtMs: 0, completedLaps: 0,
    distanceFraction: 0, lapElapsedUs: 0, currentLapValid: true,
    source: 'live', control: 'player', replay: false, paused: false, inMenus: false,
    finishResult: null, ...overrides,
  };
}

/** Deliberately synthetic: 1 s lap, uniform speed, two custom sectors. */
export function completeLapFrames(finishResult: FinishResult | null = result()): TimingFrame[] {
  return [
    frame(),
    frame({ observedAtMs: 250, distanceFraction: 0.25, lapElapsedUs: 250_000 }),
    frame({ observedAtMs: 500, distanceFraction: 0.5, lapElapsedUs: 500_000 }),
    frame({ observedAtMs: 750, distanceFraction: 0.75, lapElapsedUs: 750_000 }),
    frame({ observedAtMs: 1000, completedLaps: 1, finishResult }),
  ];
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
