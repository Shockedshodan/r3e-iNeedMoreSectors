import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createHudApplication } from '../src/application.ts';
import { analyzeCapture } from '../src/diagnostics/analyze.ts';
import type { GapStatistics } from '../src/diagnostics/analyze.ts';
import { DEFAULT_CAPTURE_LIMITS, parseCapture, projectRawTelemetry } from '../src/diagnostics/capture-format.ts';
import { replayCapture } from '../src/diagnostics/replay.ts';
import { createRaceRoomAdapter } from '../src/telemetry/raceroom-adapter.ts';
import { createRaceRoomBridge } from '../src/telemetry/websocket-bridge.ts';
import type { RaceRoomSocket } from '../src/telemetry/websocket-bridge.ts';
import type { FinishResult, TelemetryBridge, TimingFrame } from '../src/contracts.ts';
import { rawFrame } from './fixtures/browser-bridge.ts';
import { definition, frame, MemoryStorage, result } from './helpers.ts';

interface MeasuredMargin {
  observations: { statistic: string; value: number }[];
  calculation: string;
  selectedLimit: number;
  justification: string;
}

// A public diagnostic-report contract, not an import of a proposed settings
// module. Operators need to see which limits were applied and why. Synthetic
// boundary probes below do not establish live finality or authorize live saves.
interface ContinuitySettings {
  maxFrameGapMs: number;
  maxDistanceStep: number;
  finishTimeoutMs: number;
  evidence: {
    captureId: string;
    sha256: string;
    receiveGaps: GapStatistics;
    uniqueSimulationUpdateGaps: GapStatistics;
    movement: {
      sampleCount: number;
      maxDistanceStep: number;
      maxDistanceM: number;
      p50DistanceStep: number;
      p95DistanceStep: number;
      p99DistanceStep: number;
      p50DistanceM: number;
      p95DistanceM: number;
      p99DistanceM: number;
      maxDistanceSeq: number;
      filtering: string;
      excludedPairCounts: Record<string, number>;
    };
  };
  margins: {
    maxFrameGapMs: MeasuredMargin;
    maxDistanceStep: MeasuredMargin;
    finishTimeoutMs: { kind: 'provisional'; fallbackMs: number; justification: string };
  };
  rounding: { secondsToMicroseconds: string; additionalToleranceUs: number; nativePrecision: string };
  evidenceGaps: string[];
}

function settings(report: unknown): ContinuitySettings {
  const value = (report as { continuitySettings?: ContinuitySettings }).continuitySettings;
  assert.ok(value, 'The report must expose effective continuity settings with measured evidence and margins');
  assert.ok(Number.isFinite(value.maxFrameGapMs) && value.maxFrameGapMs > 0);
  assert.ok(Number.isFinite(value.maxDistanceStep) && value.maxDistanceStep > 0 && value.maxDistanceStep < 1);
  assert.ok(Number.isFinite(value.finishTimeoutMs) && value.finishTimeoutMs >= 0);
  return value;
}

function near(actual: number, expected: number, epsilon: number, message: string): void {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon,
    `${message}: expected ${expected}, got ${actual}`);
}

function assertMeasuredMargin(effective: number, margin: MeasuredMargin, measurements: Record<string, number>): void {
  assert.ok(Array.isArray(margin.observations) && margin.observations.length > 0,
    'Cite measured inputs for the chosen limit');
  for (const observation of margin.observations) {
    assert.ok(Object.hasOwn(measurements, observation.statistic), 'Cite an independently established trace statistic');
    near(observation.value, measurements[observation.statistic], 1e-12,
      'The calculation must cite the actual measured input, whichever statistic it uses');
    assert.ok(margin.calculation.includes(observation.statistic), 'Document how the cited measurement enters the calculation');
  }
  assert.equal(margin.selectedLimit, effective, 'The documented calculation must select the limit actually applied');
  assert.match(margin.calculation, /\d/, 'Document the numeric margin or tuning parameters');
  // Quantiles, physical bounds and other justified calculations are allowed.
  // Their chosen arithmetic and qualitative rationale need evidence review;
  // these tests verify input provenance and the selected limit's behavior,
  // without imposing a maximum-based or multiply/add/ceiling algorithm.
  assert.match(margin.justification, /observ|measur|trace|captur/i);
  assert.match(margin.justification, /margin|headroom|jitter|quantiz|round|precision/i);
}

interface Receipt { tMs: number; data: Record<string, unknown> }

function lap(version = [2, 8], fractions = Array.from({ length: 10001 }, (_, index) => index / 10000)): Receipt[] {
  return fractions.map((fraction, index) => ({
    tMs: index * 16,
    data: {
      ...rawFrame(), VersionMajor: version[0], VersionMinor: version[1],
      CarSpeed: 25, Player: { GameSimulationTime: 10 + fraction * 120 },
      CompletedLaps: fraction === 1 ? 1 : 0,
      LapDistanceFraction: fraction === 1 ? 0 : fraction,
      LapTimeCurrentSelf: fraction === 1 ? 0 : fraction * 120,
      ...(fraction === 1 ? { LapTimePreviousSelf: 120,
        SectorTimesPreviousSelf: { Sector1: 36, Sector2: 72, Sector3: 120 }, PrevLapValid: 1 } : {}),
    },
  }));
}

function capture(receipts: Receipt[], bridgeVersion = 'unidentified diagnostic build') {
  const events = [
    { kind: 'event', type: 'open', seq: 1, tMs: 0, connectionId: 1 },
    ...receipts.map((receipt, index) => ({ kind: 'event', type: 'message',
      seq: index + 2, tMs: receipt.tMs, connectionId: 1, data: projectRawTelemetry(receipt.data) })),
  ];
  return parseCapture([
    { kind: 'header', version: 1, captureId: 'synthetic-continuity-boundary',
      startedAt: '2026-11-11T00:00:00.000Z', source: 'synthetic', hudVersion: 'test',
      gameVersion: 'unspecified', bridgeVersion, browser: 'test', pollMs: 16,
      limits: { ...DEFAULT_CAPTURE_LIMITS } },
    ...events,
    { kind: 'footer', complete: true, reason: 'stopped', eventCount: events.length,
      lastSeq: events.length, durationMs: receipts.at(-1)!.tMs, queueHighWaterBytes: 0, lossCount: 0 },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
}

function withFirstGap(receipts: Receipt[], gap: number): Receipt[] {
  return receipts.map((receipt, index) => ({ ...receipt, tMs: index === 0 ? 0 : gap + (index - 1) * 16 }));
}

function delayedFinish(control: Receipt[], delay: number): Receipt[] {
  assert.ok(Number.isFinite(delay) && delay >= 0 && Math.ceil(delay / 16) < 100_000,
    'The timeout probe must use a finite, bounded number of simulated polls');
  const receipts = structuredClone(control);
  const crossing = receipts.at(-1)!;
  const finalResult = structuredClone(crossing.data);
  crossing.data.LapTimePreviousSelf = -1;
  crossing.data.SectorTimesPreviousSelf = { Sector1: -1, Sector2: -1, Sector3: -1 };
  crossing.data.PrevLapValid = -1;
  // Duplicate polls keep observation continuity while either isolated
  // component waits. All clocks are simulated; there is no wall-clock sleep.
  for (let elapsed = 16; elapsed < delay; elapsed += 16) {
    receipts.push({ tMs: crossing.tMs + elapsed, data: structuredClone(crossing.data) });
  }
  receipts.push({ tMs: crossing.tMs + delay, data: finalResult });
  return receipts;
}

function distanceProbe(firstStep: number, limit: number): Receipt[] {
  const count = Math.ceil((1 - firstStep) / Math.min(limit / 2, 0.001));
  assert.ok(count > 0 && count < 100_000, 'A usable measured distance limit must permit a bounded synthetic probe');
  return lap([2, 8], [0, ...Array.from({ length: count + 1 }, (_, index) =>
    index === count ? 1 : firstStep + index * (1 - firstStep) / count)]);
}

// Deliver JSON through the same bridge and application API as the browser.
// Only this explicitly synthetic fixture opts into writes; all storage is local.
function hudBest(receipts: Receipt[], finishTimeoutMs?: number): number | null {
  let now = 0;
  const socket: RaceRoomSocket = { readyState: 1, onopen: null, onmessage: null,
    onclose: null, onerror: null, send() {}, close() {} };
  const bridge = createRaceRoomBridge({
    adapter: createRaceRoomAdapter({ enableRecordWrites: true, nowMs: () => now, finishTimeoutMs }),
    clock: () => now, socketFactory: () => socket, schedule: () => 1, cancel() {},
  });
  const application = createHudApplication({ bridge, storage: new MemoryStorage(),
    resolveDefinition: () => definition, discoverModules: ({ timing }) => [timing] });
  try {
    for (const receipt of receipts) {
      now = receipt.tMs;
      socket.onmessage!({ data: JSON.stringify(receipt.data) });
      assert.ok(bridge.latest(), `Synthetic receipt must adapt: ${bridge.status()}`);
    }
    return application.getSnapshot().records?.best?.totalUs ?? null;
  } finally { application.dispose(); }
}

function adapterFinish(receipts: Receipt[]): FinishResult | null {
  let now = 0;
  // No timeout override: this tests the adapter's own default, without an
  // engine downstream that could conceal an adapter timeout that is too long.
  const adapter = createRaceRoomAdapter({ enableRecordWrites: true, nowMs: () => now });
  let finish: FinishResult | null = null;
  try {
    for (const receipt of receipts) {
      now = receipt.tMs;
      const observation = adapter.adapt(receipt.data);
      assert.ok(observation, `Synthetic timeout probe must adapt: ${adapter.status()}`);
      if (receipt.data.CompletedLaps === 1 && receipt.data.PrevLapValid === -1) {
        assert.equal(observation.frame.finishResult, null, 'The crossing must establish an unresolved finish before delayed result delivery');
      }
      if (observation.frame.finishResult) {
        assert.equal(finish, null, 'Associate this synthetic finish only once');
        finish = observation.frame.finishResult;
      }
    }
    return finish;
  } finally { adapter.reset(); }
}

function engineBest(receipts: Receipt[]): number | null {
  let receive!: ((sample: TimingFrame) => void) | undefined;
  const bridge: TelemetryBridge = { connect(listener) { receive = listener; return () => { receive = undefined; }; } };
  // The application owns the default engine settings. Supply normalized
  // fixture frames directly, so no adapter timeout can mask an engine timeout
  // that is too long. No continuity/finish option is supplied to the app.
  const application = createHudApplication({ bridge, storage: new MemoryStorage(),
    resolveDefinition: () => definition, discoverModules: ({ timing }) => [timing] });
  const sessionId = 'synthetic-timeout-probe';
  try {
    assert.ok(receive, 'The default application must subscribe to normalized telemetry');
    for (const receipt of receipts) {
      const data = receipt.data;
      const finishResult = data.CompletedLaps === 1 && data.PrevLapValid === 1
        ? result({ sessionId, totalUs: 120_000_000, officialSectorDurationsUs: [36_000_000, 36_000_000, 48_000_000] }) : null;
      receive(frame({ sessionId, observedAtMs: receipt.tMs,
        completedLaps: Number(data.CompletedLaps), distanceFraction: Number(data.LapDistanceFraction),
        lapElapsedUs: Math.round(Number(data.LapTimeCurrentSelf) * 1_000_000), finishResult }));
      if (data.CompletedLaps === 1 && data.PrevLapValid === -1) {
        assert.equal(application.getSnapshot().records?.best, null, 'A pending capture must not be saved before its associated result');
      }
    }
    return application.getSnapshot().records?.best?.totalUs ?? null;
  } finally { application.dispose(); }
}

function assertOutcome(receipts: Receipt[], accepted: boolean, message: string, expectedTotalUs = 120_000_000): void {
  const report = replayCapture(capture(receipts));
  assert.deepEqual(report.acceptedLaps.map(row => row.totalUs), accepted ? [expectedTotalUs] : [], `Replay: ${message}`);
  assert.equal(hudBest(receipts), accepted ? expectedTotalUs : null, `HUD: ${message}`);
  assert.deepEqual(report.controlProposals, []);
  assert.equal(report.liveWritesEnabled, false);
}

test('diagnostic settings cite distinct measured receipt and source-update distributions with explicit margins', async () => {
  const provenance = JSON.parse(await readFile(new URL('./fixtures/lap-count-windows/provenance.json', import.meta.url), 'utf8'));
  const document = capture(lap());
  const before = structuredClone(document);
  const policy = settings(replayCapture(document));
  assert.equal(policy.evidence.captureId, provenance.sourceCaptureId);
  assert.equal(policy.evidence.sha256, provenance.sourceSha256);
  for (const [actual, expected] of [
    [policy.evidence.receiveGaps, { count: 56938, maxMs: 42.1, p50Ms: 16.6, p95Ms: 17.8, p99Ms: 18.3 }],
    [policy.evidence.uniqueSimulationUpdateGaps, { count: 56929, maxMs: 49.7, p50Ms: 16.6, p95Ms: 17.8, p99Ms: 18.3 }],
  ] as const) {
    assert.equal(actual.count, expected.count);
    for (const key of ['maxMs', 'p50Ms', 'p95Ms', 'p99Ms'] as const) {
      assert.ok(actual[key] !== null && Math.abs(actual[key] - expected[key]) < 0.001, `Cite the original ${key}, not synthetic probe measurements`);
    }
  }
  // Golden movement measurements independently recomputed by a streaming
  // Python reader of the original 45,541,348-byte capture, after verifying its
  // SHA-256 against the provenance above. These are not analyzeCapture output
  // and are never recomputed from the synthetic boundary probes.
  //
  // Filtering is ordered: compare adjacent original message receipts only;
  // reset adjacency on every non-message event. Require the same connection,
  // LayoutId, ModelId, SessionType, SessionIteration and EventIndex. Both ends
  // must be active player practice with LapValidState=0, finite nonnegative
  // current clocks, integral lap counts, fractions in [0,1], positive finite
  // LayoutLength and finite GameSimulationTime. Exclude count changes (wraps),
  // non-advancing source clocks, then backwards current clocks/distance.
  // Retain zero distance steps and every positive outlier; no speed-derived or
  // candidate-limit filter is allowed. DistanceM = step * latter LayoutLength.
  // Percentiles use nearest rank. Exclusions plus retained pairs = 56,938.
  const movement = policy.evidence.movement;
  assert.equal(movement.sampleCount, 29_476);
  assert.deepEqual(movement.excludedPairCounts, {
    identity: 0, inactiveInvalidUnavailable: 27_446, countBoundary: 2,
    nonAdvancingSimulation: 6, backwardClockOrDistance: 8,
  });
  assert.equal(movement.sampleCount + Object.values(movement.excludedPairCounts).reduce((sum, count) => sum + count, 0), 56_938);
  for (const [key, expected] of Object.entries({
    maxDistanceStep: 0.0010256099999999962,
    p50DistanceStep: 0.0001315000000000066,
    p95DistanceStep: 0.00022481399999998986,
    p99DistanceStep: 0.00023236900000001004,
    maxDistanceM: 7.158431286800374,
    p50DistanceM: 0.9178281356600462,
    p95DistanceM: 1.5691301482148892,
    p99DistanceM: 1.62186164300523,
  })) {
    near(movement[key as keyof typeof movement] as number, expected, 1e-12, `Independent movement ${key}`);
  }
  assert.equal(movement.maxDistanceSeq, 10_972, 'Retain receipt provenance for the largest observed movement');
  for (const criterion of [/adjacent.*message/i, /identity/i, /active.*player.*practice/i,
    /LapValidState.*0/i, /count|wrap/i, /advanc.*(?:simulation|source)/i,
    /(?:backward|nondecreas)/i, /(?:outlier|no.*(?:speed|threshold).*filter)/i]) {
    assert.match(movement.filtering, criterion, 'Document which raw pairs the distribution includes and excludes');
  }
  assertMeasuredMargin(policy.maxFrameGapMs, policy.margins.maxFrameGapMs, {
    'receiveGaps.maxMs': 42.10000014305115,
    'receiveGaps.p50Ms': 16.59999990463257,
    'receiveGaps.p95Ms': 17.800000190734863,
    'receiveGaps.p99Ms': 18.299999952316284,
    'uniqueSimulationUpdateGaps.maxMs': 49.700000047683716,
    'uniqueSimulationUpdateGaps.p50Ms': 16.59999990463257,
    'uniqueSimulationUpdateGaps.p95Ms': 17.800000190734863,
    'uniqueSimulationUpdateGaps.p99Ms': 18.299999952316284,
  });
  assertMeasuredMargin(policy.maxDistanceStep, policy.margins.maxDistanceStep, {
    'movement.maxDistanceStep': 0.0010256099999999962,
    'movement.p50DistanceStep': 0.0001315000000000066,
    'movement.p95DistanceStep': 0.00022481399999998986,
    'movement.p99DistanceStep': 0.00023236900000001004,
    'movement.maxDistanceM': 7.158431286800374,
    'movement.p50DistanceM': 0.9178281356600462,
    'movement.p95DistanceM': 1.5691301482148892,
    'movement.p99DistanceM': 1.62186164300523,
  });
  assert.equal(policy.margins.finishTimeoutMs.kind, 'provisional');
  assert.equal(policy.finishTimeoutMs, policy.margins.finishTimeoutMs.fallbackMs, 'The applied finish timeout must equal its documented numeric fallback');
  assert.match(policy.margins.finishTimeoutMs.justification, /(?:unmeasured|missing|unestablished|not.established|unavailable).*(?:finality|authoritative)|(?:finality|authoritative).*(?:unmeasured|missing|unestablished|not.established|unavailable)/i);
  assert.deepEqual(settings(analyzeCapture(document)), policy, 'Analysis and replay must describe the same effective policy');
  assert.deepEqual(document, before, 'Tuning must preserve received diagnostic metadata');
});

test('HUD and replay apply inclusive measured gap and distance limits across compatible version metadata', () => {
  // Prove this exact raw, complete-lap fixture works before testing its limits.
  assertOutcome(lap(), true, 'uninterrupted synthetic control');
  const policy = settings(replayCapture(capture(lap())));
  for (const version of [[2, 8], [3, 77], [99, 99]]) {
    const receipts = lap(version);
    assertOutcome(receipts, true, `normal observations with API ${version.join('.')}`);
    assertOutcome(withFirstGap(receipts, 18.299999952316284), true, 'the independently observed 99th-percentile receipt gap');
    assertOutcome(withFirstGap(receipts, policy.maxFrameGapMs), true, 'gap exactly at the inclusive bound');
    assertOutcome(withFirstGap(receipts, policy.maxFrameGapMs + 1), false, 'one millisecond beyond the gap bound');
  }
  assertOutcome(distanceProbe(0.00023236900000001004, policy.maxDistanceStep), true,
    'the independently observed 99th-percentile movement');
  assertOutcome(distanceProbe(policy.maxDistanceStep, policy.maxDistanceStep), true, 'distance exactly at the inclusive bound');
  const beyond = Math.min(0.000001, (1 - policy.maxDistanceStep) / 2);
  assertOutcome(distanceProbe(policy.maxDistanceStep + beyond, policy.maxDistanceStep), false, 'movement beyond the distance bound');
});

test('finish settings disclose missing finality evidence and enforce the same timeout in adapter and replay', () => {
  const control = lap();
  assertOutcome(control, true, 'a fresh coherent finish in the uninterrupted fixture');
  const policy = settings(replayCapture(capture(control)));
  const gaps = policy.evidenceGaps.join('\n');
  assert.match(gaps, /finish|finality/i, 'Observed result latency is not an authoritative finality bound');
  assert.match(gaps, /load/i, 'The one continuous trace does not measure worst-case load');
  assert.match(gaps, /reconnect|disconnect|reset/i, 'Missing interruption scenarios must be named specifically');
  assert.equal(policy.margins.finishTimeoutMs.kind, 'provisional');
  assert.equal(policy.finishTimeoutMs, policy.margins.finishTimeoutMs.fallbackMs);
  assert.match(policy.margins.finishTimeoutMs.justification, /provisional|unmeasured|not.established|fallback/i);
  for (const [delay, expected] of [[policy.finishTimeoutMs, [120_000_000]], [policy.finishTimeoutMs + 1, []]] as const) {
    const receipts = delayedFinish(control, delay);
    assert.deepEqual(replayCapture(capture(receipts)).acceptedLaps.map(row => row.totalUs), expected);
    assert.equal(hudBest(receipts), expected[0] ?? null, 'The default adapter and HUD must share the reported finish timeout');
    assert.equal(hudBest(receipts, policy.finishTimeoutMs), expected[0] ?? null, 'An explicit adapter override must agree with the reported default');
  }
});

test('the default adapter independently accepts the reported finish-timeout boundary and rejects later native results', () => {
  const control = lap();
  assert.equal(adapterFinish(control)?.totalUs, 120_000_000,
    'The authorized synthetic native-result control must succeed without any engine');
  const policy = settings(replayCapture(capture(control)));
  const atBoundary = adapterFinish(delayedFinish(control, policy.finishTimeoutMs));
  assert.ok(atBoundary, 'The adapter itself must retain the pending association through the inclusive timeout');
  assert.equal(atBoundary.completedLap, 1);
  assert.equal(atBoundary.totalUs, 120_000_000);
  assert.deepEqual(atBoundary.officialSectorDurationsUs, [36_000_000, 36_000_000, 48_000_000]);
  assert.equal(adapterFinish(delayedFinish(control, policy.finishTimeoutMs + 1)), null,
    'A shorter downstream engine timeout must not conceal an adapter that still associates a late native result');
});

test('the default HUD timing engine independently accepts the reported finish-timeout boundary and rejects later associated results', () => {
  const control = lap();
  assert.equal(engineBest(control), 120_000_000,
    'The normalized complete-lap control must succeed without an adapter');
  const policy = settings(replayCapture(capture(control)));
  assert.equal(engineBest(delayedFinish(control, policy.finishTimeoutMs)), 120_000_000,
    'The engine itself must retain the pending capture through the inclusive timeout');
  assert.equal(engineBest(delayedFinish(control, policy.finishTimeoutMs + 1)), null,
    'A shorter upstream adapter timeout must not conceal an engine that still saves a late associated result');
});

test('rounding settings preserve native clocks and reject inconsistent invalid incomplete and ambiguous results for data reasons', async () => {
  const control = lap();
  assertOutcome(control, true, 'complete valid control');
  const quantized = structuredClone(control);
  Object.assign(quantized.at(-1)!.data, { LapTimePreviousSelf: 120.0000002,
    SectorTimesPreviousSelf: { Sector1: 36, Sector2: 72, Sector3: 120.0000004 } });
  assertOutcome(quantized, true, 'distinct raw values that round to the same microsecond');
  for (const [totalSeconds, thirdSeconds, firstSeconds, secondSeconds, expectedTotalUs, expectedSectorsUs] of [
    [120.0000006, 120.0000008, 36.0000006, 72.0000006, 120_000_001, [36_000_001, 36_000_000, 48_000_000]],
    [120.0000016, 120.0000018, 36.0000016, 72.0000016, 120_000_002, [36_000_002, 36_000_000, 48_000_000]],
  ] as const) {
    const roundedUp = structuredClone(control);
    Object.assign(roundedUp.at(-1)!.data, { LapTimePreviousSelf: totalSeconds,
      SectorTimesPreviousSelf: { Sector1: firstSeconds, Sector2: secondSeconds, Sector3: thirdSeconds } });
    assertOutcome(roundedUp, true, `finish clocks above a half-microsecond boundary produce ${expectedTotalUs} us`, expectedTotalUs);
    const associated = adapterFinish(roundedUp);
    assert.ok(associated, 'A fresh coherent fractional-microsecond result must be associated');
    assert.equal(associated.totalUs, expectedTotalUs, 'Round the native total upward across the half-microsecond boundary');
    assert.deepEqual(associated.officialSectorDurationsUs, expectedSectorsUs,
      'Round the cumulative native clocks before taking sector differences');
  }
  const mutations: [string, (receipts: Receipt[]) => void, RegExp][] = [
    ['inconsistent native clocks', receipts => { receipts.at(-1)!.data.SectorTimesPreviousSelf = { Sector1: 36, Sector2: 72, Sector3: 120.000001 }; }, /inconsistent|clock/i],
    ['native total below and final sector above a half-microsecond boundary', receipts => {
      Object.assign(receipts.at(-1)!.data, { LapTimePreviousSelf: 120.0000004,
        SectorTimesPreviousSelf: { Sector1: 36, Sector2: 72, Sector3: 120.0000006 } });
    }, /inconsistent|clock/i],
    ['native total above and final sector below a half-microsecond boundary', receipts => {
      Object.assign(receipts.at(-1)!.data, { LapTimePreviousSelf: 120.0000006,
        SectorTimesPreviousSelf: { Sector1: 36, Sector2: 72, Sector3: 120.0000004 } });
    }, /inconsistent|clock/i],
    ['invalid native result', receipts => { receipts.at(-1)!.data.PrevLapValid = 0; }, /invalid/i],
    ['incomplete lap start', receipts => { receipts.shift(); }, /incomplete|nonzero/i],
    ['unchanged ambiguous result', receipts => {
      for (const receipt of receipts) Object.assign(receipt.data, { LapTimePreviousSelf: 120,
        SectorTimesPreviousSelf: { Sector1: 36, Sector2: 72, Sector3: 120 }, PrevLapValid: 1 });
    }, /stale|unchanged|ambiguous/i],
    ['malformed timing', receipts => { receipts[100].data.LapTimeCurrentSelf = -1; }, /unavailable|malformed|incomplete|interrupt/i],
    ['paused driving', receipts => { receipts[100].data.GamePaused = 1; }, /inactive|interrupt|incomplete/i],
    ['changed identity', receipts => { receipts[100].data.VehicleInfo = { ModelId: 21 }; }, /identity|session|incomplete|interrupt/i],
  ];
  for (const [name, mutate, reason] of mutations) {
    const receipts = structuredClone(control);
    mutate(receipts);
    const report = replayCapture(capture(receipts));
    assert.deepEqual(report.acceptedLaps, [], name);
    assert.deepEqual(report.shadowProposals, [], name);
    assert.match(report.unresolved.map(row => row.reason).join('\n'), reason, name);
    assert.doesNotMatch(report.issues.join('\n'), /unsupported.*version|unapproved.*build/i);
    if (name.includes('half-microsecond')) {
      assert.equal(adapterFinish(receipts), null, 'The adapter must reject clocks that round to different microseconds');
      assert.equal(hudBest(receipts), null, 'Inconsistent rounded native clocks must not create a saved HUD reference');
    }
  }
  const recorded = parseCapture(await readFile(new URL('./fixtures/lap-count-windows/capture.jsonl', import.meta.url), 'utf8'),
    { allowIncomplete: true });
  const native = analyzeCapture(recorded);
  assert.deepEqual(native.reportedLaps.filter(row => row.totalUs !== null).map(row => row.totalUs), [149_494_965, 149_835_876],
    'Keep the actual capture-derived microseconds rather than rounding to screen milliseconds');
  const policy = settings(replayCapture(capture(control)));
  assert.equal(policy.rounding.secondsToMicroseconds, 'nearest');
  assert.equal(policy.rounding.additionalToleranceUs, 0, 'Display precision must not become native finish-clock tolerance');
  assert.ok(typeof policy.rounding.nativePrecision === 'string' && policy.rounding.nativePrecision.length > 0,
    'Describe observed precision or explicitly disclose that it is unmeasured');
  const alternate = capture(lap([99, 99]), 'a different unapproved bridge build');
  const alternateReport = replayCapture(alternate);
  assert.deepEqual(alternateReport.acceptedLaps.map(row => row.totalUs), [120_000_000]);
  assert.deepEqual(settings(alternateReport), policy, 'Build/version provenance must not select an admission profile');
});
