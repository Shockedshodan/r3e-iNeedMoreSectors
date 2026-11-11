import type { FinishResult, TimingFrame } from '../contracts.ts';
import { DEFAULT_CONTINUITY_LIMITS } from './continuity-settings.ts';

export interface AdaptedTelemetry {
  frame: TimingFrame;
  layoutLengthM: number;
  trackName: string;
  layoutName: string;
}

export interface RaceRoomAdapterOptions {
  nowMs?: () => number;
  enableRecordWrites?: boolean;
  finishTimeoutMs?: number;
}

export interface RaceRoomAdapter {
  adapt(raw: unknown, source?: 'live' | 'debug'): AdaptedTelemetry | null;
  reset(): void;
  status(): string;
}

type ObjectData = Record<string, unknown>;

function object(value: unknown): value is ObjectData {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function secondsUs(value: unknown, minimumUs = 0): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const time = Math.round(value * 1_000_000);
  return Number.isSafeInteger(time) && time >= minimumUs ? time : null;
}

interface ResultClocks {
  totalUs: number | null;
  firstUs: number | null;
  secondUs: number | null;
  thirdUs: number | null;
}

interface PreviousResult {
  clocks: ResultClocks;
  valid: boolean | null;
}

const CLOCK_FIELDS: readonly (keyof ResultClocks)[] = ['totalUs', 'firstUs', 'secondUs', 'thirdUs'];

function previousResult(data: ObjectData): PreviousResult {
  const sectors = data.SectorTimesPreviousSelf;
  return {
    clocks: {
      totalUs: secondsUs(data.LapTimePreviousSelf, 1),
      firstUs: object(sectors) ? secondsUs(sectors.Sector1, 1) : null,
      secondUs: object(sectors) ? secondsUs(sectors.Sector2, 1) : null,
      thirdUs: object(sectors) ? secondsUs(sectors.Sector3, 1) : null,
    },
    valid: data.PrevLapValid === 1 ? true : data.PrevLapValid === 0 ? false : null,
  };
}

function coherentResult(clocks: ResultClocks) {
  const { totalUs, firstUs, secondUs, thirdUs } = clocks;
  if (totalUs === null || firstUs === null || secondUs === null || thirdUs === null
    || firstUs <= 0 || firstUs >= secondUs || secondUs >= thirdUs || thirdUs !== totalUs) return null;
  return { totalUs, durations: [firstUs, secondUs - firstUs, thirdUs - secondUs] };
}

interface ObservationState {
  identity: string;
  completedLaps: number;
  distance: number;
  elapsedUs: number;
  simulationTime: number | null;
  atMs: number;
  clocks: ResultClocks;
}

interface PendingAssociation {
  completedLap: number;
  crossedAtMs: number;
  priorClocks: ResultClocks;
  lastElapsedUs: number;
}

export function createRaceRoomAdapter(options: RaceRoomAdapterOptions = {}): RaceRoomAdapter {
  const nowMs = options.nowMs ?? (() => Date.now());
  const timeout = options.finishTimeoutMs ?? DEFAULT_CONTINUITY_LIMITS.finishTimeoutMs;
  if (!Number.isFinite(timeout) || timeout < 0) throw new RangeError('Finish timeout must be finite and nonnegative');
  let epoch = 0;
  let prior: ObservationState | null = null;
  let pending: PendingAssociation | null = null;
  let invalidThroughLap = -1;
  let finishReason: string | null = null;
  let state = 'Waiting for RaceRoom practice telemetry';

  function reset(): void {
    epoch += 1;
    prior = null;
    pending = null;
    invalidThroughLap = -1;
    finishReason = null;
  }

  function reject(reason: string): null {
    reset();
    state = reason;
    return null;
  }

  return {
    reset,
    status: () => state,
    adapt(value, source = 'live') {
      if (!object(value)) return reject('Malformed telemetry');
      const data = value;
      if (data.SessionType !== 0) return reject('Practice sessions are supported first');
      const vehicle = data.VehicleInfo;
      const elapsedUs = secondsUs(data.LapTimeCurrentSelf);
      const atMs = nowMs();
      if (!integer(data.LayoutId) || !object(vehicle) || !integer(vehicle.ModelId)
        || typeof data.LayoutLength !== 'number' || !Number.isFinite(data.LayoutLength) || data.LayoutLength <= 0
        || !integer(data.CompletedLaps) || typeof data.LapDistanceFraction !== 'number'
        || !Number.isFinite(data.LapDistanceFraction) || data.LapDistanceFraction < 0 || data.LapDistanceFraction > 1
        || elapsedUs === null || !Number.isFinite(atMs) || atMs < 0) return reject('Unavailable or malformed player timing');

      const identity = JSON.stringify([data.LayoutId, vehicle.ModelId, data.SessionType, data.SessionIteration, data.EventIndex]);
      const player = data.Player;
      const simulationTime = object(player) && typeof player.GameSimulationTime === 'number'
        && Number.isFinite(player.GameSimulationTime) && player.GameSimulationTime >= 0 ? player.GameSimulationTime : null;
      if (prior !== null && (identity !== prior.identity || data.CompletedLaps < prior.completedLaps
        || atMs < prior.atMs || (simulationTime !== null && prior.simulationTime !== null && simulationTime < prior.simulationTime))) reset();

      const sessionId = `r3e:${epoch}:${identity}`;
      const debug = source === 'debug' || data.Debug === true || data.IsDebug === true || data.Source === 'debug';
      const control = data.ControlType === 0 ? 'player' : data.ControlType === 1 ? 'ai' : 'remote';
      const replay = data.GameInReplay !== 0 || data.ControlType === 3;
      const paused = data.GamePaused !== 0;
      const inMenus = data.GameInMenus !== 0;
      const eligible = !debug && control === 'player' && !replay && !paused && !inMenus;

      if (data.LapValidState === 2) invalidThroughLap = Math.max(invalidThroughLap, data.CompletedLaps + 1);
      let currentLapValid: boolean | null = data.LapValidState === 0 ? true
        : data.LapValidState === 1 || data.LapValidState === 2 ? false : null;
      if (data.CompletedLaps <= invalidThroughLap) currentLapValid = false;
      const previous = previousResult(data);
      let finishResult: FinishResult | null = null;

      if (!eligible) {
        pending = null;
        prior = null;
        state = 'Telemetry is not active live player driving';
      } else {
        if (pending && atMs - pending.crossedAtMs > timeout) pending = null;
        if (prior && data.CompletedLaps === prior.completedLaps + 1
          && data.LapDistanceFraction < prior.distance && elapsedUs < prior.elapsedUs) {
          pending = {
            completedLap: data.CompletedLaps, crossedAtMs: atMs,
            priorClocks: prior.clocks, lastElapsedUs: prior.elapsedUs,
          };
          finishReason = null;
        } else if (prior && (data.CompletedLaps !== prior.completedLaps
          || data.LapDistanceFraction < prior.distance || elapsedUs < prior.elapsedUs)) {
          pending = null;
        }
        if (pending) {
          const baseline = pending.priorClocks;
          const fresh = CLOCK_FIELDS.some(key => previous.clocks[key] !== null
            && previous.clocks[key] !== baseline[key]);
          const coherent = coherentResult(previous.clocks);
          const mixed = previous.clocks.totalUs !== baseline.totalUs
            && (['firstUs', 'secondUs'] as const).some(key => baseline[key] !== null
              && previous.clocks[key] === baseline[key]);
          if (fresh && previous.valid === false) {
            // Invalidity is evidence even before all of the finish clocks agree.
            finishReason = 'Invalid previous result; partial or inconsistent finish clocks cannot restore validity';
            pending = null;
          } else if (!fresh) {
            finishReason = 'Unchanged native finish clocks are stale or ambiguous';
          } else if (mixed) {
            finishReason = 'Mixed result contains unchanged stale native sector clocks';
          } else if (!coherent) {
            finishReason = 'Partial or inconsistent native finish clocks';
          } else if (previous.valid !== true) {
            finishReason = 'Previous result validity is unavailable';
          } else if (coherent.totalUs < pending.lastElapsedUs) {
            finishReason = 'Previous result clock is shorter than the captured lap';
          } else if (options.enableRecordWrites === true && data.CompletedLaps === pending.completedLap) {
            finishResult = {
              sessionId, layoutId: data.LayoutId, modelId: vehicle.ModelId,
              completedLap: pending.completedLap, valid: true,
              totalUs: coherent.totalUs, officialSectorDurationsUs: coherent.durations,
            };
            finishReason = null;
            pending = null;
          }
        }
        prior = {
          identity, completedLaps: data.CompletedLaps,
          distance: data.LapDistanceFraction, elapsedUs, simulationTime, atMs,
          // Clearing and restoring a clock must not manufacture freshness.
          clocks: {
            totalUs: previous.clocks.totalUs ?? prior?.clocks.totalUs ?? null,
            firstUs: previous.clocks.firstUs ?? prior?.clocks.firstUs ?? null,
            secondUs: previous.clocks.secondUs ?? prior?.clocks.secondUs ?? null,
            thirdUs: previous.clocks.thirdUs ?? prior?.clocks.thirdUs ?? null,
          },
        };
        state = options.enableRecordWrites === true
          ? 'Fixture recording enabled; live semantics remain unverified'
          : 'Connected; live record writes disabled until telemetry semantics are verified';
        if (finishReason) state += `; ${finishReason}`;
      }

      return {
        frame: {
          sessionId, layoutId: data.LayoutId, modelId: vehicle.ModelId,
          observedAtMs: atMs, completedLaps: data.CompletedLaps,
          distanceFraction: data.LapDistanceFraction, lapElapsedUs: elapsedUs,
          currentLapValid, source: debug ? 'debug' : 'live', control, replay, paused, inMenus, finishResult,
        },
        layoutLengthM: data.LayoutLength,
        trackName: typeof data.TrackName === 'string' ? data.TrackName : '',
        layoutName: typeof data.LayoutName === 'string' ? data.LayoutName : '',
      };
    },
  };
}
