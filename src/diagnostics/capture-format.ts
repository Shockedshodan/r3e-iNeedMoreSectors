/** Versioned, projected raw telemetry. No lap-record authorization is encoded. */
export interface CaptureLimits {
  maxBufferedBytes: number;
  batchBytes: number;
  maxSessionBytes: number;
  maxDurationMs: number;
}
export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  maxBufferedBytes: 4 * 1024 * 1024,
  batchBytes: 256 * 1024,
  maxSessionBytes: 256 * 1024 * 1024,
  maxDurationMs: 30 * 60 * 1000,
};
export interface CaptureHeader {
  kind: 'header';
  version: 1;
  captureId: string;
  startedAt: string;
  source: 'live' | 'synthetic';
  hudVersion: string;
  gameVersion: string;
  bridgeVersion: string;
  browser: string;
  pollMs: number;
  limits: CaptureLimits;
}
export interface CaptureAnnotation {
  /** Omitted for legacy independent annotations. */
  source?: 'independent' | 'telemetry';
  completedLap: number;
  outcome: 'valid' | 'invalid' | 'incomplete' | 'unknown';
  totalUs?: number;
  /** Independent label/display uncertainty, not a relaxation of native checks. */
  totalToleranceUs?: number;
  layoutId?: number;
  modelId?: number;
  notes?: string;
}
export type CaptureEventType = 'open' | 'close' | 'error' | 'message' | 'malformed' | 'annotation' | 'loss';
export interface CaptureEvent {
  kind: 'event';
  seq: number;
  tMs: number;
  connectionId: number;
  type: CaptureEventType;
  data?: Record<string, unknown>;
  reason?: string;
  messageType?: string;
  byteLength?: number;
  annotation?: CaptureAnnotation;
}
export interface CaptureFooter {
  kind: 'footer';
  complete: boolean;
  reason: string;
  eventCount: number;
  lastSeq: number;
  durationMs: number;
  queueHighWaterBytes: number;
  lossCount: number;
}
export type CaptureRow = CaptureHeader | CaptureEvent | CaptureFooter;
export interface CaptureDocument {
  header: CaptureHeader;
  events: CaptureEvent[];
  footer: CaptureFooter | null;
  complete: boolean;
  problems: string[];
}
export interface CaptureManifest {
  version: 1;
  captureId: string;
  complete: boolean;
  source: 'live' | 'synthetic';
  byteCount: number;
  eventCount: number;
  sha256: string;
  outputPath: string;
  problems: string[];
}
export function projectRawTelemetry(value: unknown): Record<string, unknown> {
  if (!object(value)) return {};
  const result: Record<string, unknown> = {};
  for (const key of RAW_SCALARS) if (owns(value, key)) result[key] = projectedValue(value[key]);
  for (const [key, fields] of Object.entries(RAW_OBJECTS)) {
    if (!owns(value, key)) continue;
    const nested = value[key];
    if (!object(nested)) { result[key] = projectedValue(nested); continue; }
    const selected: Record<string, unknown> = {};
    for (const field of fields) if (owns(nested, field)) selected[field] = projectedValue(nested[field]);
    result[key] = selected;
  }
  return result;
}
export function parseCaptureRow(value: unknown): CaptureRow {
  if (!object(value)) throw new TypeError('Capture row must be an object');
  if (value.kind === 'header') {
    keys(value, ['kind', 'version', 'captureId', 'startedAt', 'source', 'hudVersion', 'gameVersion', 'bridgeVersion', 'browser', 'pollMs', 'limits']);
    if (value.version !== 1) throw new RangeError('Unsupported capture format version');
    if (typeof value.captureId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.captureId)) throw new TypeError('Invalid capture ID');
    if (!string(value.startedAt) || !Number.isFinite(Date.parse(value.startedAt))) throw new TypeError('Invalid capture start time');
    if (value.source !== 'live' && value.source !== 'synthetic') throw new TypeError('Invalid capture source');
    for (const key of ['hudVersion', 'gameVersion', 'bridgeVersion', 'browser']) if (!string(value[key])) throw new TypeError(`Invalid ${key}`);
    if (!finite(value.pollMs) || value.pollMs <= 0) throw new RangeError('Invalid polling interval');
    if (!object(value.limits)) throw new TypeError('Missing capture limits');
    keys(value.limits, ['maxBufferedBytes', 'batchBytes', 'maxSessionBytes', 'maxDurationMs']);
    for (const key of ['maxBufferedBytes', 'batchBytes', 'maxSessionBytes', 'maxDurationMs']) {
      if (!integer(value.limits[key], 1)) throw new RangeError(`Invalid capture limit ${key}`);
    }
    if (Number(value.limits.batchBytes) > Number(value.limits.maxBufferedBytes)) throw new RangeError('Batch exceeds buffer capacity');
  } else if (value.kind === 'event') {
    keys(value, ['kind', 'seq', 'tMs', 'connectionId', 'type', 'data', 'reason', 'messageType', 'byteLength', 'annotation']);
    if (!integer(value.seq, 1) || !finite(value.tMs) || value.tMs < 0 || !integer(value.connectionId, 0)) throw new RangeError('Invalid event sequence, time or connection');
    if (!['open', 'close', 'error', 'message', 'malformed', 'annotation', 'loss'].includes(String(value.type))) throw new TypeError('Unknown capture event type');
    if (!['annotation', 'loss'].includes(String(value.type)) && value.connectionId === 0) throw new RangeError('Telemetry requires a positive connection ID');
    if (value.type === 'message') {
      if (!object(value.data) || canonical(value.data) !== canonical(projectRawTelemetry(value.data))) throw new TypeError('Message contains unprojected/private fields');
    } else if (value.data !== undefined) throw new TypeError('Only message events may contain telemetry');
    if (value.reason !== undefined && !string(value.reason)) throw new TypeError('Invalid event reason');
    if (value.messageType !== undefined && !string(value.messageType)) throw new TypeError('Invalid message type');
    if (value.byteLength !== undefined && !integer(value.byteLength, 0)) throw new RangeError('Invalid message length');
    if (value.type === 'annotation') {
      if (!object(value.annotation)) throw new TypeError('Missing independent annotation');
      keys(value.annotation, ['source', 'completedLap', 'outcome', 'totalUs', 'totalToleranceUs', 'layoutId', 'modelId', 'notes']);
      if (value.annotation.source !== undefined && value.annotation.source !== 'independent' && value.annotation.source !== 'telemetry') throw new TypeError('Invalid annotation source');
      if (!integer(value.annotation.completedLap, 0) || !['valid', 'invalid', 'incomplete', 'unknown'].includes(String(value.annotation.outcome))) throw new TypeError('Invalid annotation label');
      for (const key of ['totalUs', 'totalToleranceUs', 'layoutId', 'modelId']) {
        if (value.annotation[key] !== undefined && !integer(value.annotation[key], key === 'totalUs' ? 1 : 0)) throw new TypeError(`Invalid annotation ${key}`);
      }
      if (value.annotation.notes !== undefined && !string(value.annotation.notes, 4096)) throw new TypeError('Invalid annotation notes');
    } else if (value.annotation !== undefined) throw new TypeError('Labels require annotation events');
  } else if (value.kind === 'footer') {
    keys(value, ['kind', 'complete', 'reason', 'eventCount', 'lastSeq', 'durationMs', 'queueHighWaterBytes', 'lossCount']);
    if (typeof value.complete !== 'boolean' || !string(value.reason)) throw new TypeError('Invalid footer status');
    for (const key of ['eventCount', 'lastSeq', 'queueHighWaterBytes', 'lossCount']) if (!integer(value[key], 0)) throw new RangeError(`Invalid footer ${key}`);
    if (!finite(value.durationMs) || value.durationMs < 0) throw new RangeError('Invalid capture duration');
  } else throw new TypeError('Unknown capture row kind');
  return JSON.parse(JSON.stringify(value)) as CaptureRow;
}
export function parseCapture(text: string, options: { allowIncomplete?: boolean } = {}): CaptureDocument {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0 || lines.some(line => line.trim() === '')) throw new TypeError('Capture has empty/missing rows');
  const rows = lines.map((line, index) => {
    try { return parseCaptureRow(JSON.parse(line)); }
    catch (error) { throw new TypeError(`Invalid capture row ${index + 1}: ${error instanceof Error ? error.message : 'invalid JSON'}`); }
  });
  const header = rows[0];
  if (header.kind !== 'header') throw new TypeError('Capture must begin with a header');
  const events: CaptureEvent[] = [];
  let footer: CaptureFooter | null = null;
  let lastTime = 0;
  for (const row of rows.slice(1)) {
    if (footer) throw new TypeError('Rows after footer are not allowed');
    if (row.kind === 'header') throw new TypeError('Duplicate capture header');
    if (row.kind === 'footer') { footer = row; continue; }
    if (row.seq !== events.length + 1) throw new RangeError('Capture sequence gap or duplicate');
    if (row.tMs < lastTime) throw new RangeError('Capture timestamps move backwards');
    if (row.tMs > header.limits.maxDurationMs) throw new RangeError('Event exceeds capture duration limit');
    lastTime = row.tMs;
    events.push(row);
  }
  if (footer && (footer.eventCount !== events.length || footer.lastSeq !== events.length || footer.durationMs < lastTime)) {
    throw new RangeError('Footer counts/time do not match the stream');
  }
  const problems: string[] = [];
  if (!footer) problems.push('missing-footer');
  if (footer && !footer.complete) problems.push(`incomplete:${footer.reason}`);
  if (events.some(event => event.type === 'loss') || (footer?.lossCount ?? 0) > 0) problems.push('capture-loss');
  if (footer && footer.durationMs > header.limits.maxDurationMs) problems.push('duration-limit');
  if (footer && footer.queueHighWaterBytes > header.limits.maxBufferedBytes) problems.push('buffer-limit');
  if (new TextEncoder().encode(text).byteLength > header.limits.maxSessionBytes) problems.push('session-limit');
  const complete = footer !== null && footer.complete && problems.length === 0;
  if (!complete && !options.allowIncomplete) throw new Error(`Capture is incomplete: ${problems.join(', ')}`);
  return { header, events, footer, complete, problems };
}

const RAW_SCALARS = ['VersionMajor', 'VersionMinor', 'TrackId', 'LayoutId', 'LayoutLength', 'SessionType', 'SessionIteration', 'EventIndex',
  'CompletedLaps', 'LapDistanceFraction', 'LapDistance', 'LapTimeCurrentSelf', 'LapTimePreviousSelf', 'LapValidState', 'PrevLapValid',
  'CurrentLapValid', 'ControlType', 'GameInReplay', 'GamePaused', 'GameInMenus', 'Debug', 'IsDebug', 'Source', 'CarSpeed'] as const;
const RAW_OBJECTS: Record<string, readonly string[]> = {
  VehicleInfo: ['ModelId'], Player: ['GameSimulationTime', 'GameSimulationTicks'],
  SectorTimesCurrentSelf: ['Sector1', 'Sector2', 'Sector3'], SectorTimesPreviousSelf: ['Sector1', 'Sector2', 'Sector3'],
};
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function owns(value: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function integer(value: unknown, min: number): value is number { return finite(value) && Number.isSafeInteger(value) && value >= min; }
function string(value: unknown, max = 1024): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('Unknown/private capture field');
}
function projectedValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Invalid nested shapes remain invalid for the adapter, without retaining
  // arbitrary nested content or claiming this projection is wire-byte exact.
  if (Array.isArray(value)) return [];
  if (object(value)) return {};
  throw new TypeError('Telemetry field is not a JSON value');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
