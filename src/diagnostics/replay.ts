import type { FinishResult, RecordBook, SectorDefinition, StorageLike, TimingEngine, TimingFrame } from '../contracts.ts';
import type { CaptureAnnotation, CaptureDocument, CaptureEvent } from './capture-format.ts';
import { parseCapture, parseCaptureRow } from './capture-format.ts';
import { createRaceRoomAdapter } from '../telemetry/raceroom-adapter.ts';
import { createTimingEngine } from '../timing-engine.ts';
import { createRecordRepository } from '../records.ts';
import { createLayoutDefinitionRegistry } from '../layout-definitions.ts';
import { analyzeCapture } from './analyze.ts';
import type { ReportedLap } from './analyze.ts';
import { describeContinuitySettings } from '../telemetry/continuity-settings.ts';
import type { ContinuityLimits, ContinuitySettings } from '../telemetry/continuity-settings.ts';

export interface ReplayProposal {
  seq: number;
  atMs: number;
  connectionId: number;
  sessionId: string;
  completedLap: number;
  layoutId: number;
  modelId: number;
  totalUs: number;
  bestChanged: boolean;
  optChanged: boolean;
}
export interface ReplayResult extends Omit<ReplayProposal, 'bestChanged' | 'optChanged'> {
  engineAccepted: boolean;
  engineImprovement: boolean;
}
export interface ReplayComparison {
  annotation: ReplayAnnotation;
  status: 'pass' | 'fail' | 'unresolved';
  reason: string;
  proposalCount: number;
  authorizedResultCount: number;
  acceptedCount: number;
  origin?: 'event' | 'sidecar' | 'unlabeled-result';
}
export interface ReplayAnnotation extends CaptureAnnotation {
  connectionId?: number;
  sessionId?: string;
  atMs?: number;
}
export interface ReplayOptions {
  annotations?: readonly ReplayAnnotation[];
  maxFrameGapMs?: number;
  maxDistanceStep?: number;
  finishTimeoutMs?: number;
}
export interface ReplayReport {
  version: 1;
  captureId: string;
  source: 'live' | 'synthetic';
  complete: boolean;
  infrastructureEligible: boolean;
  liveWritesEnabled: false;
  profileValidated: false;
  continuitySettings: ContinuitySettings;
  controlProposals: ReplayProposal[];
  shadowProposals: ReplayProposal[];
  shadowResults: ReplayResult[];
  acceptedLaps: Omit<ReplayProposal, 'bestChanged' | 'optChanged'>[];
  observedCrossings: Omit<ReplayProposal, 'bestChanged' | 'optChanged'>[];
  comparisons: ReplayComparison[];
  unresolved: ReplayComparison[];
  issues: string[];
  records: RecordBook[];
}

export function replayCapture(document: CaptureDocument, options: ReplayOptions = {}): ReplayReport {
  // Revalidate callers' objects too: never trust a stale `complete` boolean or
  // silently sort captures into an ordering the operator did not observe.
  const validated = parseCapture([document.header, ...document.events,
    ...(document.footer ? [document.footer] : [])].map(row => JSON.stringify(row)).join('\n') + '\n',
  { allowIncomplete: true });
  const issues = [...new Set([...validated.problems, ...document.problems])];
  const complete = validated.complete && document.complete && document.problems.length === 0;
  // Raw count crossings survive unavailable lap clocks; they are diagnostic
  // observations, never authorization to manufacture a normalized timing frame.
  const rawCrossings = new Map(analyzeCapture(validated).reportedLaps.map(lap => [lap.seq, lap]));
  const continuitySettings = describeContinuitySettings(options);
  const shadow = run(validated, true, continuitySettings, rawCrossings);
  const control = run(validated, false, continuitySettings, rawCrossings);
  issues.push(...shadow.issues);
  const labels: { value: ReplayAnnotation; origin: 'event' | 'sidecar' }[] = [
    ...validated.events.filter(event => event.type === 'annotation' && event.annotation)
      .map(event => ({ value: {
        ...event.annotation!, connectionId: event.connectionId || undefined,
        sessionId: shadow.contexts.get(event.seq)?.sessionId, atMs: event.tMs,
      }, origin: 'event' as const })),
    ...(options.annotations ?? []).map(value => ({ value, origin: 'sidecar' as const })),
  ];
  for (const label of labels) {
    parseCaptureRow({ kind: 'event', seq: 1, tMs: 0, connectionId: 0,
      type: 'annotation', annotation: annotationFields(label.value) });
    if (label.value.connectionId !== undefined && (!Number.isSafeInteger(label.value.connectionId) || label.value.connectionId < 0)) {
      throw new RangeError('Annotation connection identity must be a nonnegative integer');
    }
    if (label.value.sessionId !== undefined && typeof label.value.sessionId !== 'string') throw new TypeError('Invalid annotation session identity');
  }
  const comparisons: ReplayComparison[] = labels.map(({ value, origin }) => {
    const authorized = shadow.results.filter(result => matches(value, result));
    const accepted = shadow.accepted.filter(result => matches(value, result));
    const proposals = shadow.proposals.filter(result => matches(value, result));
    const crossings = [...shadow.crossings, ...shadow.rejectedCrossings].filter(result => matches(value, result));
    const observed = crossings.length > 0;
    const sessions = new Set([...authorized, ...accepted, ...crossings].map(result => `${result.connectionId}:${result.sessionId}`));
    const base = { annotation: scopedAnnotation(value), proposalCount: proposals.length,
      authorizedResultCount: authorized.length, acceptedCount: accepted.length, origin };
    if (value.source === 'telemetry') return { ...base, status: 'unresolved', reason: 'Telemetry-derived evidence is not independent confirmation' };
    if (value.outcome === 'unknown') return { ...base, status: 'unresolved', reason: 'Annotation outcome is unknown' };
    if (sessions.size > 1) return { ...base, status: 'unresolved', reason: 'Annotation matches multiple sessions; add connection/session identity' };
    if (value.outcome === 'invalid') return authorized.length > 0 || accepted.length > 0
      ? { ...base, status: 'fail', reason: 'Independently invalid lap was authorized or accepted' }
      : observed ? { ...base, status: 'pass', reason: 'Observed invalid lap was not authorized or accepted' }
        : { ...base, status: 'unresolved', reason: 'No matching crossing was observed' };
    if (value.outcome === 'incomplete') return accepted.length > 0
      ? { ...base, status: 'fail', reason: 'Independently incomplete capture was accepted' }
      : observed ? { ...base, status: 'pass', reason: 'Observed incomplete lap was not accepted' }
        : { ...base, status: 'unresolved', reason: 'No matching crossing was observed' };
    if (!observed && authorized.length === 0) return { ...base, status: 'unresolved', reason: 'No matching result or crossing was observed' };
    if (accepted.length !== 1) return { ...base, status: 'fail', reason: accepted.length > 1 ? 'Duplicate engine acceptance' : 'Annotated valid complete capture was not accepted' };
    if (value.totalUs === undefined) return { ...base, status: 'unresolved', reason: 'Official total was not supplied independently' };
    const tolerance = value.totalToleranceUs ?? 0;
    if (Math.abs(accepted[0].totalUs - value.totalUs) > tolerance) return { ...base, status: 'fail', reason: 'Accepted total disagrees with independently annotated official total at its declared precision' };
    return { ...base, status: 'pass', reason: tolerance === 0
      ? 'One engine-accepted complete lap exactly matches the independent total'
      : `One engine-accepted complete lap matches within the declared ${tolerance} us display tolerance` };
  });
  const unresolved = comparisons.filter(comparison => comparison.status === 'unresolved');
  const observed = new Map<string, ResultIdentity>();
  for (const result of [...shadow.crossings, ...shadow.rejectedCrossings, ...shadow.results]) {
    observed.set(resultKey(result), result);
  }
  for (const result of observed.values()) {
    if (labels.some(({ value }) => matches(value, result))) continue;
    const authorized = shadow.results.filter(value => value.connectionId === result.connectionId
      && value.sessionId === result.sessionId && value.completedLap === result.completedLap);
    const acceptedCount = shadow.accepted.filter(value => value.connectionId === result.connectionId
      && value.sessionId === result.sessionId && value.completedLap === result.completedLap).length;
    const proposalCount = shadow.proposals.filter(value => value.connectionId === result.connectionId
      && value.sessionId === result.sessionId && value.completedLap === result.completedLap).length;
    const rejection = shadow.rejections.get(resultKey(result));
    unresolved.push({ annotation: { completedLap: result.completedLap, outcome: 'unknown',
      layoutId: result.layoutId, modelId: result.modelId, connectionId: result.connectionId,
      sessionId: result.sessionId, atMs: result.atMs }, status: 'unresolved',
    reason: acceptedCount > 0 ? 'Unlabeled adapter result has no independent ground truth'
      : rejection ? [rejection.invalid ? 'Native invalidity observed' : null, rejection.adapter, rejection.capture]
        .filter(Boolean).join('; ') : 'Unlabeled observed crossing has an unresolved or ambiguous result',
    proposalCount, authorizedResultCount: authorized.length,
    acceptedCount, origin: 'unlabeled-result' });
  }
  return {
    version: 1, captureId: validated.header.captureId, source: validated.header.source,
    complete, infrastructureEligible: complete && !validated.events.some(event => event.type === 'loss'),
    liveWritesEnabled: false, profileValidated: false, continuitySettings,
    controlProposals: control.proposals, shadowProposals: shadow.proposals,
    shadowResults: shadow.results, acceptedLaps: shadow.accepted, observedCrossings: shadow.crossings,
    comparisons, unresolved, issues: [...new Set(issues)], records: shadow.records,
  };
}

type ResultIdentity = Omit<ReplayProposal, 'bestChanged' | 'optChanged'>;

function resultKey(result: Pick<ResultIdentity, 'connectionId' | 'sessionId' | 'completedLap'>): string {
  return JSON.stringify([result.connectionId, result.sessionId, result.completedLap]);
}

function annotationFields(value: CaptureAnnotation): CaptureAnnotation {
  return { completedLap: value.completedLap, outcome: value.outcome,
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(value.totalUs === undefined ? {} : { totalUs: value.totalUs }),
    ...(value.totalToleranceUs === undefined ? {} : { totalToleranceUs: value.totalToleranceUs }),
    ...(value.layoutId === undefined ? {} : { layoutId: value.layoutId }),
    ...(value.modelId === undefined ? {} : { modelId: value.modelId }),
    ...(value.notes === undefined ? {} : { notes: value.notes }) };
}

function scopedAnnotation(value: ReplayAnnotation): ReplayAnnotation {
  return { ...annotationFields(value),
    ...(value.connectionId === undefined ? {} : { connectionId: value.connectionId }),
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.atMs === undefined ? {} : { atMs: value.atMs }) };
}

function matches(label: ReplayAnnotation, result: ResultIdentity): boolean {
  return result.completedLap === label.completedLap
    && (label.layoutId === undefined || result.layoutId === label.layoutId)
    && (label.modelId === undefined || result.modelId === label.modelId)
    && (label.connectionId === undefined || label.connectionId === result.connectionId)
    && (label.sessionId === undefined || label.sessionId === result.sessionId);
}

/** Each run owns all its storage and clock state; browser stores are unreachable. */
function run(document: CaptureDocument, shadow: boolean, options: ContinuityLimits, rawCrossings: ReadonlyMap<number, ReportedLap>) {
  const values = new Map<string, string>();
  const storage: StorageLike = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
  const definitions = createLayoutDefinitionRegistry(storage);
  const repository = createRecordRepository(storage);
  const combinations = new Map<string, { layoutId: number; modelId: number; definition: SectorDefinition }>();
  const proposals: ReplayProposal[] = [];
  const results: ReplayResult[] = [];
  const accepted: ResultIdentity[] = [];
  const crossings: ResultIdentity[] = [];
  const rejectedCrossings: ResultIdentity[] = [];
  const rejections = new Map<string, { invalid: boolean; adapter: string; capture: string | null }>();
  const contexts = new Map<number, TimingFrame>();
  const issues: string[] = [];
  let now = 0;
  let connectionId: number | null = null;
  let engine: TimingEngine | null = null;
  let identity: string | null = null;
  let lastFrame: TimingFrame | null = null;
  let event: CaptureEvent;
  let activeResult: ReplayResult | null = null;
  const adapter = createRaceRoomAdapter({ nowMs: () => now, enableRecordWrites: shadow,
    finishTimeoutMs: options.finishTimeoutMs });

  function interrupt(): void {
    adapter.reset(); engine?.dispose(); engine = null; identity = null; lastFrame = null;
  }
  function describe(result: FinishResult): ResultIdentity {
    return { seq: event.seq, atMs: event.tMs, connectionId: event.connectionId,
      sessionId: result.sessionId, completedLap: result.completedLap,
      layoutId: result.layoutId, modelId: result.modelId, totalUs: result.totalUs };
  }
  for (event of document.events) {
    now = event.tMs;
    activeResult = null;
    if (event.type === 'open') {
      if (connectionId !== null) interrupt();
      connectionId = event.connectionId;
    } else if (event.type === 'close' || event.type === 'error') {
      if (connectionId === event.connectionId) { interrupt(); connectionId = null; }
    } else if (event.type === 'malformed' || event.type === 'loss') {
      interrupt();
      issues.push(`Event ${event.seq}: ${event.type} observation interrupted capture`);
    } else if (event.type === 'message') {
      if (connectionId !== event.connectionId) throw new RangeError(`Message ${event.seq} arrived outside its open connection`);
      const observation = adapter.adapt(event.data);
      const rawCrossing = rawCrossings.get(event.seq);
      if (rawCrossing && rawCrossing.layoutId !== null && rawCrossing.modelId !== null
        && Number.isSafeInteger(rawCrossing.layoutId) && Number.isSafeInteger(rawCrossing.modelId)) {
        const crossing = { seq: event.seq, atMs: now, connectionId: event.connectionId,
          sessionId: observation?.frame.sessionId ?? rawCrossing.sessionId,
          completedLap: rawCrossing.completedLap, layoutId: rawCrossing.layoutId,
          modelId: rawCrossing.modelId, totalUs: observation?.frame.finishResult?.totalUs ?? 0 };
        const usable = observation && lastFrame?.sessionId === observation.frame.sessionId
          && observation.frame.completedLaps === lastFrame.completedLaps + 1;
        if (usable) crossings.push(crossing);
        else rejectedCrossings.push(crossing);
        const invalid = event.data?.PrevLapValid === 0 || event.data?.LapValidState === 1 || event.data?.LapValidState === 2;
        rejections.set(resultKey(crossing), { invalid, adapter: adapter.status(),
          capture: usable ? null : 'Unavailable or interrupted timing clocks prevent complete capture' });
      }
      if (observation === null) {
        engine?.dispose(); engine = null; identity = null; lastFrame = null;
        issues.push(`Event ${event.seq}: ${adapter.status()}`);
        continue;
      }
      const frame = observation.frame;
      const nextIdentity = JSON.stringify([frame.sessionId, frame.layoutId, frame.modelId]);
      if (frame.finishResult) {
        activeResult = { ...describe(frame.finishResult), engineAccepted: false, engineImprovement: false };
        results.push(activeResult);
      }
      if (identity !== nextIdentity) {
        engine?.dispose();
        const definition = definitions.resolve(frame.layoutId, observation.layoutLengthM);
        const combination = { layoutId: frame.layoutId, modelId: frame.modelId };
        combinations.set(JSON.stringify(combination), { ...combination, definition });
        engine = createTimingEngine({ definition, initialRecords: repository.load(combination, definition),
          maxFrameGapMs: options.maxFrameGapMs, maxDistanceStep: options.maxDistanceStep,
          finishTimeoutMs: options.finishTimeoutMs,
          onLapAccepted(_candidate, result) {
            accepted.push(describe(result));
            if (activeResult) activeResult.engineAccepted = true;
          },
          onImprovement(update, candidate) {
            repository.consider(candidate, definition);
            // The engine may outlive the frame which constructed it. Use the
            // currently delivered associated result, not that first-frame closure.
            if (activeResult) {
              const { engineAccepted: _accepted, engineImprovement: _improved, ...details } = activeResult;
              proposals.push({ ...details, bestChanged: update.bestChanged, optChanged: update.optChanged });
              activeResult.engineImprovement = true;
            }
          },
        });
        identity = nextIdentity;
      }
      engine!.consume(frame);
      const key = resultKey({ ...frame, connectionId: event.connectionId, completedLap: frame.completedLaps });
      const rejection = rejections.get(key);
      if (rejection) {
        rejection.adapter = adapter.status();
        if (rawCrossing || frame.finishResult) rejection.capture =
          [rejection.capture, engine!.finishRejectionReason()].filter(Boolean).join('; ');
      }
      lastFrame = frame;
    }
    if (lastFrame) contexts.set(event.seq, lastFrame);
  }
  engine?.dispose();
  return { proposals, results, accepted, crossings, rejectedCrossings, contexts, issues, rejections,
    records: [...combinations.values()].map(combination => repository.load(combination, combination.definition)) };
}
