import type {
  CurvePoint, FinishResult, LapCandidate, RecordBook, TimingEngine,
  TimingEngineOptions, TimingFrame,
} from './contracts.ts';
import { mergeRecordBooks, updateRecords } from './records.ts';
import {
  immutable, isValidBoundaries, isValidCombination, isValidReference, sameBoundaries,
} from './validation.ts';

const INTERVALS = 128;
// Only absorb floating-point subtraction error at inclusive distance limits.
const DISTANCE_EPSILON = Number.EPSILON * 8;

interface Capture {
  sessionId: string;
  completedLaps: number;
  valid: boolean;
  grid: CurvePoint[];
  lastPoint: CurvePoint;
}

interface PendingFinish {
  capture: Capture;
  completedLap: number;
  crossedAtMs: number;
}

function usableFrame(frame: TimingFrame): boolean {
  return isValidCombination(frame) && typeof frame.sessionId === 'string' && frame.sessionId.length > 0
    && Number.isFinite(frame.observedAtMs) && frame.observedAtMs >= 0
    && Number.isSafeInteger(frame.completedLaps) && frame.completedLaps >= 0
    && Number.isFinite(frame.distanceFraction) && frame.distanceFraction >= 0 && frame.distanceFraction <= 1
    && Number.isSafeInteger(frame.lapElapsedUs) && frame.lapElapsedUs >= 0;
}

function allowedSource(frame: TimingFrame): boolean {
  return frame.source === 'live' && frame.control === 'player'
    && frame.replay === false && frame.paused === false && frame.inMenus === false;
}

function validResult(result: FinishResult): boolean {
  return result.valid === true && Number.isSafeInteger(result.totalUs) && result.totalUs > 0
    && Array.isArray(result.officialSectorDurationsUs) && result.officialSectorDurationsUs.length === 3
    && result.officialSectorDurationsUs.every(time => Number.isSafeInteger(time) && time > 0)
    && result.officialSectorDurationsUs.reduce((sum, time) => sum + time, 0) === result.totalUs;
}

export function createTimingEngine(options: TimingEngineOptions): TimingEngine {
  const { initialRecords, definition } = options;
  if (!isValidCombination(initialRecords) || initialRecords.schemaVersion !== 1
    || initialRecords.layoutId !== definition.layoutId
    || !Number.isFinite(definition.layoutLengthM) || definition.layoutLengthM <= 0
    || !isValidBoundaries(definition.boundaries) || !isValidBoundaries(initialRecords.boundaries)
    || !sameBoundaries(definition.boundaries, initialRecords.boundaries)
    || (initialRecords.best !== null && !isValidReference(initialRecords.best, definition.boundaries.length - 1))
    || (initialRecords.opt !== null && !isValidReference(initialRecords.opt, definition.boundaries.length - 1))) {
    throw new RangeError('Valid records and a matching sector definition are required');
  }
  if (!Number.isFinite(options.maxFrameGapMs) || options.maxFrameGapMs <= 0
    || !Number.isFinite(options.maxDistanceStep) || options.maxDistanceStep <= 0 || options.maxDistanceStep > 1
    || !Number.isFinite(options.finishTimeoutMs) || options.finishTimeoutMs < 0) {
    throw new RangeError('Finite continuity limits and a nonnegative finish timeout are required');
  }

  const boundaries = [...definition.boundaries];
  const layoutId = initialRecords.layoutId;
  const modelId = initialRecords.modelId;
  const sectorCount = boundaries.length - 1;
  let records: RecordBook = immutable(structuredClone(initialRecords));
  let snapshot = records;
  let current: Capture | null = null;
  let pending: PendingFinish | null = null;
  let lastFrame: TimingFrame | null = null;
  let sessionId: string | null = null;
  let blockedLap: number | null = null;
  let disposed = false;

  function discard(frame: TimingFrame): void {
    const knownLap = current?.completedLaps ?? lastFrame?.completedLaps ?? blockedLap;
    current = null;
    pending = null;
    lastFrame = null;
    blockedLap = Number.isSafeInteger(frame.completedLaps) && frame.completedLaps >= 0
      ? frame.completedLaps : knownLap;
  }

  function gridFraction(index: number): number {
    if (index === sectorCount * INTERVALS) return 1;
    const sectorIndex = Math.floor(index / INTERVALS);
    return boundaries[sectorIndex]
      + (boundaries[sectorIndex + 1] - boundaries[sectorIndex]) * (index % INTERVALS) / INTERVALS;
  }

  /** Retain only the fixed grid and one measured point, never the raw frame history. */
  function append(capture: Capture, point: CurvePoint): void {
    const previous = capture.lastPoint;
    if (point.fraction > previous.fraction) {
      while (capture.grid.length <= sectorCount * INTERVALS) {
        const fraction = gridFraction(capture.grid.length);
        if (fraction > point.fraction + DISTANCE_EPSILON) break;
        const weight = Math.min(1, Math.max(0,
          (fraction - previous.fraction) / (point.fraction - previous.fraction)));
        capture.grid.push({ fraction, elapsedUs: previous.elapsedUs + weight * (point.elapsedUs - previous.elapsedUs) });
      }
    }
    capture.lastPoint = point;
  }

  function start(frame: TimingFrame): void {
    snapshot = records;
    blockedLap = null;
    current = {
      sessionId: frame.sessionId,
      completedLaps: frame.completedLaps,
      valid: frame.currentLapValid === true,
      grid: [{ fraction: 0, elapsedUs: 0 }],
      lastPoint: { fraction: 0, elapsedUs: 0 },
    };
    if (current.valid) append(current, { fraction: frame.distanceFraction, elapsedUs: frame.lapElapsedUs });
  }

  function reconcile(result: FinishResult | null): void {
    if (pending === null || result === null) return;
    if (result.sessionId !== pending.capture.sessionId
      || result.layoutId !== layoutId || result.modelId !== modelId
      || result.completedLap !== pending.completedLap) return;

    const capture = pending.capture;
    pending = null;
    if (!validResult(result) || result.totalUs < capture.lastPoint.elapsedUs) return;
    // The coherent wrap plus associated official total supplies the finish
    // endpoint. The total is never inferred from the next lap's clock.
    append(capture, { fraction: 1, elapsedUs: result.totalUs });
    if (capture.grid.length !== sectorCount * INTERVALS + 1) return;
    const absoluteTimes = boundaries.map((_, index) => Math.round(capture.grid[index * INTERVALS].elapsedUs));
    const sectors = boundaries.slice(0, -1).map((_, sectorIndex) => {
      const startUs = absoluteTimes[sectorIndex];
      const durationUs = absoluteTimes[sectorIndex + 1] - startUs;
      const curve = capture.grid.slice(sectorIndex * INTERVALS, (sectorIndex + 1) * INTERVALS + 1)
        .map((point, index) => ({
          fraction: index / INTERVALS,
          elapsedUs: index === 0 ? 0 : index === INTERVALS ? durationUs
            : Math.min(durationUs, Math.max(0, point.elapsedUs - startUs)),
        }));
      return { durationUs, curve };
    });
    const candidate: LapCandidate = immutable({
      layoutId, modelId,
      complete: true, valid: true, boundaries: [...boundaries],
      reference: { totalUs: result.totalUs, sectors },
    });
    const update = updateRecords(records, candidate);
    if (!update.bestChanged && !update.optChanged) return;
    records = update.records;
    options.onImprovement(update, candidate);
  }

  return {
    consume(frame) {
      if (disposed) return;
      if (!usableFrame(frame) || !allowedSource(frame)) {
        discard(frame);
        return;
      }
      if (frame.layoutId !== layoutId || frame.modelId !== modelId) {
        discard(frame);
        sessionId = null;
        return;
      }
      if (sessionId !== null && frame.sessionId !== sessionId) {
        discard(frame);
        blockedLap = null;
      }
      sessionId = frame.sessionId;

      if (pending !== null && frame.observedAtMs - pending.crossedAtMs > options.finishTimeoutMs) pending = null;
      if (lastFrame === null) {
        if (blockedLap !== frame.completedLaps && frame.distanceFraction === 0 && frame.lapElapsedUs === 0) start(frame);
      } else {
        const previous = lastFrame;
        const gap = frame.observedAtMs - previous.observedAtMs;
        if (gap < 0 || gap > options.maxFrameGapMs) {
          discard(frame);
          return;
        }
        const lapStep = frame.completedLaps - previous.completedLaps;
        if (lapStep === 0) {
          const distanceStep = frame.distanceFraction - previous.distanceFraction;
          if (distanceStep < 0 || distanceStep > options.maxDistanceStep + DISTANCE_EPSILON
            || frame.lapElapsedUs < previous.lapElapsedUs) {
            discard(frame);
            return;
          }
          if (current !== null) {
            current.valid &&= frame.currentLapValid === true;
            if (current.valid) append(current, { fraction: frame.distanceFraction, elapsedUs: frame.lapElapsedUs });
          }
        } else if (lapStep === 1 && frame.distanceFraction < previous.distanceFraction
          && frame.lapElapsedUs < previous.lapElapsedUs
          && 1 - previous.distanceFraction + frame.distanceFraction <= options.maxDistanceStep + DISTANCE_EPSILON) {
          // Replacing an unreconciled older finish bounds retained state to one
          // pending lap. Never associate that older result with this new lap.
          pending = current?.valid ? {
            capture: current, completedLap: frame.completedLaps, crossedAtMs: frame.observedAtMs,
          } : null;
          start(frame);
        } else {
          discard(frame);
          return;
        }
      }
      // Copy the scalar sample: callers may reuse or mutate their frame object.
      lastFrame = { ...frame, finishResult: null };
      reconcile(frame.finishResult);
    },
    records: () => records,
    comparisonSnapshot: () => snapshot,
    pendingFinishCount: () => pending === null ? 0 : 1,
    synchronizeRecords(recovered) {
      if (disposed) return;
      // Recovery updates available references without reclassifying them as a
      // captured lap, changing this lap's comparison, or touching capture state.
      records = mergeRecordBooks(records, recovered);
    },
    dispose() {
      disposed = true;
      current = null;
      pending = null;
      lastFrame = null;
    },
  };
}
