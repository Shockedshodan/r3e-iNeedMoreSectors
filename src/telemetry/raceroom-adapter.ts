import type { FinishResult, TimingFrame } from '../contracts.ts';

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

function secondsUs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const time = Math.round(value * 1_000_000);
  return Number.isSafeInteger(time) ? time : null;
}

interface PreviousResult {
  totalUs: number;
  durations: readonly number[];
  signature: string;
  valid: boolean | null;
}

function previousResult(data: ObjectData): PreviousResult | null {
  const totalUs = secondsUs(data.LapTimePreviousSelf);
  const sectors = data.SectorTimesPreviousSelf;
  if (totalUs === null || totalUs <= 0 || !object(sectors)) return null;
  const cumulative = [sectors.Sector1, sectors.Sector2, sectors.Sector3].map(secondsUs);
  if (cumulative.some(value => value === null || value <= 0)) return null;
  const values = cumulative as number[];
  if (!(values[0] < values[1] && values[1] < values[2]) || values[2] !== totalUs) return null;
  return {
    totalUs,
    durations: [values[0], values[1] - values[0], values[2] - values[1]],
    // Validity changing alone never establishes the freshness of timing fields.
    signature: JSON.stringify([totalUs, ...values]),
    valid: data.PrevLapValid === 1 ? true : data.PrevLapValid === 0 ? false : null,
  };
}

interface ObservationState {
  identity: string;
  completedLaps: number;
  distance: number;
  elapsedUs: number;
  simulationTime: number | null;
  atMs: number;
  signature: string | null;
}

interface PendingAssociation {
  completedLap: number;
  crossedAtMs: number;
  priorSignature: string | null;
  lastElapsedUs: number;
}

export function createRaceRoomAdapter(options: RaceRoomAdapterOptions = {}): RaceRoomAdapter {
  const nowMs = options.nowMs ?? (() => Date.now());
  const timeout = options.finishTimeoutMs ?? 500;
  if (!Number.isFinite(timeout) || timeout < 0) throw new RangeError('Finish timeout must be finite and nonnegative');
  let epoch = 0;
  let prior: ObservationState | null = null;
  let pending: PendingAssociation | null = null;
  let invalidThroughLap = -1;
  let state = 'Waiting for RaceRoom practice telemetry';

  function reset(): void {
    epoch += 1;
    prior = null;
    pending = null;
    invalidThroughLap = -1;
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
      if (data.VersionMajor !== 3 || data.VersionMinor !== 6) return reject('Unsupported shared-memory version; expected 3.6');
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
            priorSignature: prior.signature, lastElapsedUs: prior.elapsedUs,
          };
        } else if (prior && (data.CompletedLaps !== prior.completedLaps
          || data.LapDistanceFraction < prior.distance || elapsedUs < prior.elapsedUs)) {
          pending = null;
        }
        if (pending && previous && previous.signature !== pending.priorSignature && previous.valid === false) {
          // Once a fresh associated result is explicitly invalid, later field
          // reordering must not resurrect it as a valid lap.
          pending = null;
        }
        if (options.enableRecordWrites === true && pending && previous
          && previous.valid === true && previous.signature !== pending.priorSignature
          && previous.totalUs >= pending.lastElapsedUs && data.CompletedLaps === pending.completedLap) {
          finishResult = {
            sessionId, layoutId: data.LayoutId, modelId: vehicle.ModelId,
            completedLap: pending.completedLap, valid: true,
            totalUs: previous.totalUs, officialSectorDurationsUs: previous.durations,
          };
          pending = null;
        }
        prior = {
          identity, completedLaps: data.CompletedLaps,
          distance: data.LapDistanceFraction, elapsedUs, simulationTime, atMs,
          signature: previous?.signature ?? prior?.signature ?? null,
        };
        state = options.enableRecordWrites === true
          ? 'Fixture recording enabled; live semantics remain unverified'
          : 'Connected; live record writes disabled until telemetry semantics are verified';
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
