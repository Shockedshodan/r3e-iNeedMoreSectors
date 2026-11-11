import type { CaptureDocument } from './capture-format.ts';

export interface GapStatistics {
  count: number;
  minMs: number | null;
  maxMs: number | null;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}
export interface ConnectionAnalysis {
  connectionId: number;
  messageCount: number;
  duplicateMessageCount: number;
  uniqueSimulationUpdates: number;
  unknownSimulationClockCount: number;
  invalidTimingCount: number;
  receiveGaps: GapStatistics;
  uniqueSimulationUpdateGaps: GapStatistics;
}
export interface ObservedValue { present: boolean; value?: unknown }
export interface TimelineChange {
  seq: number;
  tMs: number;
  offsetMs: number;
  field: string;
  before: ObservedValue;
  after: ObservedValue;
  initial: boolean;
}
export interface FinishWindow {
  connectionId: number;
  seq: number;
  atMs: number;
  completedLap: number;
  lapCountStep: number;
  distanceWrapped: boolean;
  clockWrapped: boolean;
  timeline: TimelineChange[];
  firstChangedResultOffsetMs: number | null;
  lastObservedResultChangeOffsetMs: number | null;
  overlappingCrossings: boolean;
  finality: 'not-established';
}
export interface MovementObservation {
  connectionId: number;
  seq: number;
  tMs: number;
  receiveDeltaMs: number;
  simulationDeltaSeconds: number | null;
  distanceStep: number;
  distanceM: number;
  rawCarSpeedMps: number | null;
  speedTimesSimulationDeltaM: number | null;
}
export interface CaptureAnalysisReport {
  version: 1;
  captureId: string;
  source: 'live' | 'synthetic';
  complete: boolean;
  liveValidated: false;
  recordingEnabled: false;
  provenance: { startedAt: string; hudVersion: string; gameVersion: string; bridgeVersion: string; browser: string; pollMs: number };
  issues: string[];
  summary: { eventCount: number; messageCount: number; duplicateMessageCount: number; invalidTimingCount: number; malformedCount: number; transportResetEvents: number; observedStateResets: number; annotationCount: number; lossEventCount: number };
  connections: ConnectionAnalysis[];
  finishes: FinishWindow[];
  boundaryObservations: { connectionId: number; seq: number; tMs: number; countProgression: boolean; distanceWrapped: boolean; clockWrapped: boolean }[];
  movements: MovementObservation[];
  unknownValues: Record<string, { missing: number; null: number; unavailable: number; malformed: number }>;
  quantizationErrorsUs: { connectionId: number; seq: number; tMs: number; errorUs: number }[];
  losses: { seq: number; tMs: number; reason: string }[];
  diagnostics: { queueHighWaterBytes: number | null; recordedLossCount: number | null };
}
const FIELDS = [
  'VersionMajor', 'VersionMinor', 'LayoutId', 'LayoutLength', 'VehicleInfo.ModelId',
  'SessionType', 'SessionIteration', 'EventIndex', 'CompletedLaps', 'LapDistanceFraction',
  'LapTimeCurrentSelf', 'LapTimePreviousSelf',
  'SectorTimesCurrentSelf.Sector1', 'SectorTimesCurrentSelf.Sector2', 'SectorTimesCurrentSelf.Sector3',
  'SectorTimesPreviousSelf.Sector1', 'SectorTimesPreviousSelf.Sector2', 'SectorTimesPreviousSelf.Sector3',
  'LapValidState', 'PrevLapValid', 'CurrentLapValid', 'ControlType',
  'GameInReplay', 'GamePaused', 'GameInMenus', 'Debug', 'IsDebug', 'Source', 'Player.GameSimulationTime', 'CarSpeed',
] as const;
const RESULT_CLOCKS = new Set<string>([
  'LapTimePreviousSelf', 'SectorTimesPreviousSelf.Sector1',
  'SectorTimesPreviousSelf.Sector2', 'SectorTimesPreviousSelf.Sector3',
]);
const RESULT_FIELDS = new Set([...RESULT_CLOCKS, 'PrevLapValid']);
const IDENTITY_FIELDS = ['LayoutId', 'VehicleInfo.ModelId', 'SessionType', 'SessionIteration', 'EventIndex'];

function read(data: Record<string, unknown>, path: string): ObservedValue {
  let value: unknown = data;
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) return { present: false };
    value = (value as Record<string, unknown>)[key];
  }
  // Reports include only the selected scalar fields, never arbitrary nested
  // objects from a caller-supplied document that bypassed capture projection.
  const scalar = value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)
    ? value : Array.isArray(value) ? '[invalid array]' : '[invalid object]';
  return { present: true, value: scalar };
}
function number(data: Record<string, unknown>, path: string): number | null {
  const observation = read(data, path);
  return typeof observation.value === 'number' && Number.isFinite(observation.value) && observation.value >= 0
    ? observation.value : null;
}
function lapCount(data: Record<string, unknown>): number | null {
  const value = number(data, 'CompletedLaps');
  return value !== null && Number.isSafeInteger(value) ? value : null;
}
function validTiming(data: Record<string, unknown>): boolean {
  const distance = number(data, 'LapDistanceFraction');
  return lapCount(data) !== null && distance !== null && distance <= 1 && number(data, 'LapTimeCurrentSelf') !== null;
}
function same(left: ObservedValue, right: ObservedValue): boolean {
  return left.present === right.present && Object.is(left.value, right.value);
}
function gapStatistics(values: number[]): GapStatistics {
  if (values.length === 0) return { count: 0, minMs: null, maxMs: null, meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
  return {
    count: values.length, minMs: sorted[0], maxMs: sorted[sorted.length - 1],
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
  };
}

interface Point { seq: number; tMs: number; data: Record<string, unknown>; segment: number }
interface ConnectionState {
  report: ConnectionAnalysis;
  receiveGaps: number[];
  updateGaps: number[];
  lastReceiveAt: number | null;
  lastUniqueAt: number | null;
  lastSimulation: number | null;
  previous: Point | null;
  fingerprint: string | null;
  segment: number;
  changes: (Omit<TimelineChange, 'offsetMs'> & { segment: number })[];
}

export function analyzeCapture(document: CaptureDocument, options: { windowMs?: number } = {}): CaptureAnalysisReport {
  const windowMs = options.windowMs ?? 3000;
  if (!Number.isFinite(windowMs) || windowMs < 0) throw new RangeError('Analysis window must be finite and nonnegative');
  let previousAt = -1;
  document.events.forEach((event, index) => {
    if (event.seq !== index + 1) throw new RangeError('Capture sequence must be continuous and ordered');
    if (!Number.isFinite(event.tMs) || event.tMs < 0 || event.tMs < previousAt) throw new RangeError('Capture timestamp order is invalid');
    previousAt = event.tMs;
  });
  const header = document.header;
  const report: CaptureAnalysisReport = {
    version: 1, captureId: header.captureId, source: header.source, complete: document.complete,
    liveValidated: false, recordingEnabled: false,
    provenance: { startedAt: header.startedAt, hudVersion: header.hudVersion, gameVersion: header.gameVersion,
      bridgeVersion: header.bridgeVersion, browser: header.browser, pollMs: header.pollMs },
    issues: [...document.problems],
    summary: { eventCount: document.events.length, messageCount: 0, duplicateMessageCount: 0, invalidTimingCount: 0,
      malformedCount: 0, transportResetEvents: 0, observedStateResets: 0, annotationCount: 0, lossEventCount: 0 },
    connections: [], finishes: [], boundaryObservations: [], movements: [], unknownValues: {},
    quantizationErrorsUs: [], losses: [],
    diagnostics: { queueHighWaterBytes: document.footer?.queueHighWaterBytes ?? null, recordedLossCount: document.footer?.lossCount ?? null },
  };
  if (!document.complete) report.issues.push('Capture is incomplete; its windows cannot qualify live recording.');
  if (header.source === 'synthetic') report.issues.push('Synthetic telemetry verifies tooling, not live semantics.');
  report.issues.push('Observed field stability and latency do not establish authoritative final validity.');
  const states = new Map<number, ConnectionState>();
  const anchors: { finish: FinishWindow; segment: number }[] = [];

  function connection(id: number): ConnectionState {
    let state = states.get(id);
    if (!state) {
      state = {
        report: { connectionId: id, messageCount: 0, duplicateMessageCount: 0, uniqueSimulationUpdates: 0,
          unknownSimulationClockCount: 0, invalidTimingCount: 0, receiveGaps: gapStatistics([]), uniqueSimulationUpdateGaps: gapStatistics([]) },
        receiveGaps: [], updateGaps: [], lastReceiveAt: null, lastUniqueAt: null, lastSimulation: null,
        previous: null, fingerprint: null, segment: 0, changes: [],
      };
      states.set(id, state);
    }
    return state;
  }
  function reset(state: ConnectionState, transport: boolean): void {
    state.previous = null;
    state.fingerprint = null;
    state.lastUniqueAt = null;
    state.lastSimulation = null;
    if (transport) state.lastReceiveAt = null;
    state.segment += 1;
  }

  for (const event of document.events) {
    if (event.type === 'loss') {
      report.summary.lossEventCount += 1;
      report.losses.push({ seq: event.seq, tMs: event.tMs, reason: event.reason ?? 'Unspecified capture loss' });
      for (const state of states.values()) reset(state, true);
      continue;
    }
    if (event.type === 'annotation') { report.summary.annotationCount += 1; continue; }
    const state = connection(event.connectionId);
    if (event.type === 'open' || event.type === 'close' || event.type === 'error') {
      if (event.type !== 'open') report.summary.transportResetEvents += 1;
      reset(state, true);
      continue;
    }
    state.report.messageCount += 1;
    report.summary.messageCount += 1;
    if (state.lastReceiveAt !== null) state.receiveGaps.push(event.tMs - state.lastReceiveAt);
    state.lastReceiveAt = event.tMs;
    if (event.type === 'malformed') {
      report.summary.malformedCount += 1;
      reset(state, false);
      continue;
    }
    const data = event.data ?? {};
    const previous = state.previous;
    const simulation = number(data, 'Player.GameSimulationTime');
    const identityChanged = previous !== null && IDENTITY_FIELDS.some(field => !same(read(previous.data, field), read(data, field)));
    const count = lapCount(data);
    const oldCount = previous ? lapCount(previous.data) : null;
    if (identityChanged || (simulation !== null && state.lastSimulation !== null && simulation < state.lastSimulation)
      || (count !== null && oldCount !== null && count < oldCount)) {
      report.summary.observedStateResets += 1;
      reset(state, false);
    }
    const prior = state.previous;
    const point: Point = { seq: event.seq, tMs: event.tMs, data, segment: state.segment };
    for (const field of FIELDS) {
      const after = read(data, field);
      const before = prior ? read(prior.data, field) : { present: false };
      const unknown = report.unknownValues[field] ??= { missing: 0, null: 0, unavailable: 0, malformed: 0 };
      if (!after.present) unknown.missing += 1;
      else if (after.value === null) unknown.null += 1;
      else if (after.value === -1 || after.value === -1000) unknown.unavailable += 1;
      else {
        const debugFlag = (field === 'Debug' || field === 'IsDebug') && typeof after.value === 'boolean';
        const source = field === 'Source' && (after.value === 'live' || after.value === 'debug');
        if (!debugFlag && !source && (typeof after.value !== 'number' || !Number.isFinite(after.value))) unknown.malformed += 1;
      }
      if (!same(before, after)) state.changes.push({
        seq: event.seq, tMs: event.tMs, field, before, after, initial: prior === null, segment: state.segment,
      });
    }
    const fingerprint = JSON.stringify(FIELDS.map(field => read(data, field)));
    if (fingerprint === state.fingerprint) {
      state.report.duplicateMessageCount += 1;
      report.summary.duplicateMessageCount += 1;
    }
    state.fingerprint = fingerprint;
    if (!validTiming(data)) {
      state.report.invalidTimingCount += 1;
      report.summary.invalidTimingCount += 1;
    }
    if (simulation === null) {
      state.report.unknownSimulationClockCount += 1;
      state.lastSimulation = null;
      state.lastUniqueAt = null;
    } else if (state.lastSimulation === null || simulation > state.lastSimulation) {
      if (state.lastUniqueAt !== null) state.updateGaps.push(event.tMs - state.lastUniqueAt);
      state.report.uniqueSimulationUpdates += 1;
      state.lastSimulation = simulation;
      state.lastUniqueAt = event.tMs;
    }

    if (prior && validTiming(prior.data) && validTiming(data)) {
      const beforeCount = lapCount(prior.data)!;
      const lapStep = count! - beforeCount;
      const distance = number(data, 'LapDistanceFraction')!;
      const previousDistance = number(prior.data, 'LapDistanceFraction')!;
      const distanceWrapped = distance < previousDistance;
      const clockWrapped = number(data, 'LapTimeCurrentSelf')! < number(prior.data, 'LapTimeCurrentSelf')!;
      if (lapStep > 0 || distanceWrapped || clockWrapped) report.boundaryObservations.push({
        connectionId: event.connectionId, seq: event.seq, tMs: event.tMs,
        countProgression: lapStep > 0, distanceWrapped, clockWrapped,
      });
      if (lapStep > 0) anchors.push({
        segment: state.segment,
        finish: { connectionId: event.connectionId, seq: event.seq, atMs: event.tMs,
          completedLap: count!, lapCountStep: lapStep, distanceWrapped, clockWrapped,
          timeline: [], firstChangedResultOffsetMs: null, lastObservedResultChangeOffsetMs: null,
          overlappingCrossings: false, finality: 'not-established' },
      });
      const distanceStep = lapStep === 0 && distance >= previousDistance ? distance - previousDistance
        : lapStep === 1 && distanceWrapped ? 1 - previousDistance + distance : null;
      const length = number(data, 'LayoutLength');
      const beforeSimulation = number(prior.data, 'Player.GameSimulationTime');
      const simulationDelta = simulation !== null && beforeSimulation !== null && simulation > beforeSimulation ? simulation - beforeSimulation : null;
      const speed = number(data, 'CarSpeed');
      const oldSpeed = number(prior.data, 'CarSpeed');
      if (distanceStep !== null && length !== null && length > 0) report.movements.push({
        connectionId: event.connectionId, seq: event.seq, tMs: event.tMs,
        receiveDeltaMs: event.tMs - prior.tMs, simulationDeltaSeconds: simulationDelta,
        distanceStep, distanceM: distanceStep * length, rawCarSpeedMps: speed,
        speedTimesSimulationDeltaM: simulationDelta !== null && speed !== null && oldSpeed !== null
          ? Math.max(speed, oldSpeed) * simulationDelta : null,
      });
    }
    const total = number(data, 'LapTimePreviousSelf');
    const third = number(data, 'SectorTimesPreviousSelf.Sector3');
    if (total !== null && total > 0 && third !== null && third > 0) report.quantizationErrorsUs.push({
      connectionId: event.connectionId, seq: event.seq, tMs: event.tMs,
      errorUs: Math.round(total * 1_000_000) - Math.round(third * 1_000_000),
    });
    state.previous = point;
  }

  for (const { finish, segment } of anchors) {
    const state = states.get(finish.connectionId)!;
    finish.timeline = state.changes.filter(change => change.segment === segment && Math.abs(change.tMs - finish.atMs) <= windowMs)
      .map(({ segment: _segment, ...change }) => ({ ...change, offsetMs: change.tMs - finish.atMs }));
    finish.overlappingCrossings = anchors.some(other => other.finish !== finish && other.segment === segment
      && other.finish.connectionId === finish.connectionId && Math.abs(other.finish.atMs - finish.atMs) <= windowMs);
    if (!finish.overlappingCrossings) {
      const clocks = finish.timeline.filter(change => !change.initial && RESULT_CLOCKS.has(change.field));
      const results = finish.timeline.filter(change => !change.initial && RESULT_FIELDS.has(change.field));
      finish.firstChangedResultOffsetMs = clocks.length ? clocks[0].offsetMs : null;
      finish.lastObservedResultChangeOffsetMs = results.length ? results[results.length - 1].offsetMs : null;
    }
    report.finishes.push(finish);
  }
  if (report.finishes.some(finish => finish.overlappingCrossings)) {
    report.issues.push('Some finish windows overlap neighboring crossings; aggregate result latencies are withheld for those windows.');
  }
  if (report.losses.length) report.issues.push('Capture loss is present; affected windows cannot qualify live recording.');
  report.connections = [...states.values()].map(state => ({ ...state.report,
    receiveGaps: gapStatistics(state.receiveGaps), uniqueSimulationUpdateGaps: gapStatistics(state.updateGaps) }));
  return report;
}

function display(value: ObservedValue): string {
  if (!value.present) return '[missing]';
  if (value.value === undefined) return '[undefined]';
  return typeof value.value === 'string' ? value.value : JSON.stringify(value.value);
}
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function escape(value: unknown): string {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
export function formatAnalysisCsv(report: CaptureAnalysisReport): string {
  const rows: unknown[][] = [['record', 'connectionId', 'sequence', 'tMs', 'offsetMs', 'field', 'before', 'after', 'detail']];
  for (const connection of report.connections) rows.push(['connection', connection.connectionId, '', '', '', '', '', '', JSON.stringify(connection)]);
  for (const finish of report.finishes) {
    rows.push(['finish', finish.connectionId, finish.seq, finish.atMs, '', 'CompletedLaps', '', finish.completedLap,
      'Observed crossing; final validity is not established']);
    for (const change of finish.timeline) rows.push(['field', finish.connectionId, change.seq, change.tMs, change.offsetMs,
      change.field, display(change.before), display(change.after), change.initial ? 'initial observation' : 'change']);
  }
  for (const loss of report.losses) rows.push(['loss', '', loss.seq, loss.tMs, '', '', '', '', loss.reason]);
  return `${rows.map(row => row.map(csvCell).join(',')).join('\n')}\n`;
}
export function formatAnalysisHtml(report: CaptureAnalysisReport): string {
  const rows = report.connections.map(connection => `<tr><td>${connection.connectionId}</td><td>${connection.messageCount}</td><td>${connection.duplicateMessageCount}</td><td>${escape(connection.receiveGaps.maxMs)}</td><td>${escape(connection.uniqueSimulationUpdateGaps.maxMs)}</td></tr>`).join('');
  const finishes = report.finishes.map(finish => `<section><h2>Connection ${finish.connectionId}, lap-count progression to ${finish.completedLap}</h2>
    <p>At ${finish.atMs} ms. First changed result: ${escape(finish.firstChangedResultOffsetMs)} ms; last observed result change: ${escape(finish.lastObservedResultChangeOffsetMs)} ms. Finality is not established.${finish.overlappingCrossings ? ' Neighboring finish windows overlap.' : ''}</p>
    <table><thead><tr><th>Sequence</th><th>Offset ms</th><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>${finish.timeline.map(change => `<tr><td>${change.seq}</td><td>${change.offsetMs}</td><td>${escape(change.field)}</td><td>${escape(display(change.before))}</td><td>${escape(display(change.after))}</td></tr>`).join('')}</tbody></table></section>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Capture observations ${escape(report.captureId)}</title>
<style>body{font:14px system-ui,sans-serif;max-width:1200px;margin:2rem auto;padding:0 1rem;color:#182535}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{padding:.4rem;border:1px solid #bbc7d1;text-align:left;overflow-wrap:anywhere}th{background:#e8eef3}.notice{padding:1rem;background:#fff3cc}section{margin-top:2rem}code{white-space:pre-wrap}</style></head>
<body><h1>Capture observations</h1><p class="notice">Live recording remains disabled. This report is not a validation profile and does not establish final validity.</p>
<dl><dt>Capture</dt><dd>${escape(report.captureId)}</dd><dt>Source</dt><dd>${escape(report.source)}</dd><dt>Complete</dt><dd>${report.complete}</dd><dt>Game</dt><dd>${escape(report.provenance.gameVersion)}</dd><dt>Bridge</dt><dd>${escape(report.provenance.bridgeVersion)}</dd><dt>HUD</dt><dd>${escape(report.provenance.hudVersion)}</dd><dt>Browser</dt><dd>${escape(report.provenance.browser)}</dd></dl>
<ul>${report.issues.map(issue => `<li>${escape(issue)}</li>`).join('')}</ul><h2>Connection measurements</h2>
<p>Receive gaps and unique simulation-clock update gaps are separate observations. Polling can repeat one game frame. Percentiles use nearest rank; no threshold is selected automatically.</p>
<table><thead><tr><th>Connection</th><th>Messages</th><th>Duplicates</th><th>Max receive gap ms</th><th>Max unique-update gap ms</th></tr></thead><tbody>${rows}</tbody></table>
${finishes}<h2>Diagnostics</h2><p>Queue high-water bytes: ${escape(report.diagnostics.queueHighWaterBytes)}; recorded loss count: ${escape(report.diagnostics.recordedLossCount)}.</p>
</body></html>\n`;
}
