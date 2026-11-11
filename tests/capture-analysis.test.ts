import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeCapture, formatAnalysisCsv, formatAnalysisHtml } from '../src/diagnostics/analyze.ts';
import type { CaptureDocument, CaptureEvent, CaptureHeader } from '../src/diagnostics/capture-format.ts';
import { DEFAULT_CAPTURE_LIMITS } from '../src/diagnostics/capture-format.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { main as analyzeMain } from '../scripts/analyze-capture.ts';

function message(seq: number, tMs: number, data: Record<string, unknown>, connectionId = 1): CaptureEvent {
  return { kind: 'event', type: 'message', seq, tMs, connectionId, data };
}
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    VersionMajor: 3, VersionMinor: 6, LayoutId: 10, LayoutLength: 1000,
    VehicleInfo: { ModelId: 20 }, SessionType: 0, SessionIteration: 1, EventIndex: 0,
    CompletedLaps: 0, LapDistanceFraction: 0.9, LapTimeCurrentSelf: 9,
    LapTimePreviousSelf: 10, SectorTimesPreviousSelf: { Sector1: 3, Sector2: 6, Sector3: 10 },
    LapValidState: 0, PrevLapValid: 1, Player: { GameSimulationTime: 10 },
    ControlType: 0, GameInReplay: 0, GamePaused: 0, GameInMenus: 0, ...overrides,
  };
}
function capture(events: CaptureEvent[], complete = true): CaptureDocument {
  const header: CaptureHeader = {
    kind: 'header', version: 1, captureId: 'analysis-fixture', startedAt: '2026-11-11T12:00:00.000Z',
    source: 'synthetic', hudVersion: 'test', gameVersion: 'fixture', bridgeVersion: 'fixture', browser: 'fixture', pollMs: 16,
    limits: { ...DEFAULT_CAPTURE_LIMITS },
  };
  return {
    header, events, complete, problems: complete ? [] : ['Capture truncated'],
    footer: complete ? { kind: 'footer', complete: true, reason: 'stopped', eventCount: events.length,
      lastSeq: events.length, durationMs: events.at(-1)?.tMs ?? 0, queueHighWaterBytes: 42, lossCount: 0 } : null,
  };
}

function orderedFinish(): CaptureDocument {
  const old = raw();
  const fresh = { LapTimePreviousSelf: 11, SectorTimesPreviousSelf: { Sector1: 3.1, Sector2: 6.6, Sector3: 11 } };
  return capture([
    message(1, 0, old), message(2, 16, structuredClone(old)),
    message(3, 40, raw({ ...fresh, LapDistanceFraction: 0.95, LapTimeCurrentSelf: 9.5, Player: { GameSimulationTime: 10.04 } })),
    message(4, 60, raw({ ...fresh, CompletedLaps: 1, LapDistanceFraction: 0.01, LapTimeCurrentSelf: 0.1, Player: { GameSimulationTime: 10.06 } })),
    message(5, 80, raw({ ...fresh, CompletedLaps: 1, LapDistanceFraction: 0.02, LapTimeCurrentSelf: 0.2, PrevLapValid: 0, Player: { GameSimulationTime: 10.08 } })),
  ]);
}

test('arrival gaps and unique source-clock gaps differ when polls repeat a game frame', () => {
  const report = analyzeCapture(orderedFinish());
  const connection = report.connections[0];
  assert.equal(connection.messageCount, 5);
  assert.equal(connection.duplicateMessageCount, 1);
  assert.equal(connection.uniqueSimulationUpdates, 4);
  assert.deepEqual(connection.receiveGaps, { count: 4, minMs: 16, maxMs: 24, meanMs: 20, p50Ms: 20, p95Ms: 24, p99Ms: 24 });
  assert.equal(connection.uniqueSimulationUpdateGaps.count, 3);
  assert.equal(connection.uniqueSimulationUpdateGaps.maxMs, 40);
  assert.equal(connection.uniqueSimulationUpdateGaps.meanMs, 80 / 3);
});

test('finish windows expose results leading count progression and validity changing later', () => {
  const report = analyzeCapture(orderedFinish());
  assert.equal(report.finishes.length, 1);
  const finish = report.finishes[0];
  assert.equal(finish.atMs, 60);
  assert.equal(finish.completedLap, 1);
  assert.equal(finish.distanceWrapped, true);
  assert.equal(finish.clockWrapped, true);
  assert.equal(finish.firstChangedResultOffsetMs, -20);
  assert.equal(finish.lastObservedResultChangeOffsetMs, 20);
  assert.equal(finish.finality, 'not-established');
  assert.ok(finish.timeline.some(change => change.field === 'PrevLapValid' && change.offsetMs === 20 && change.after.value === 0));
  assert.equal(report.liveValidated, false);
  assert.equal(report.recordingEnabled, false);
});

test('transport epochs do not produce cross-connection receive or simulation gaps', () => {
  const report = analyzeCapture(capture([
    message(1, 0, raw()), message(2, 20, raw({ Player: { GameSimulationTime: 10.02 } })),
    { kind: 'event', seq: 3, tMs: 30, connectionId: 1, type: 'close' },
    { kind: 'event', seq: 4, tMs: 1000, connectionId: 2, type: 'open' },
    message(5, 1010, raw({ Player: { GameSimulationTime: 1 } }), 2),
  ]));
  assert.equal(report.connections.length, 2);
  assert.equal(report.connections[0].receiveGaps.maxMs, 20);
  assert.equal(report.connections[1].receiveGaps.count, 0);
  assert.equal(report.connections[1].uniqueSimulationUpdateGaps.count, 0);
  assert.equal(report.summary.transportResetEvents, 1);
});

test('overlapping finish windows do not present neighboring result changes as a settled lap latency', () => {
  const document = orderedFinish();
  document.events.push(message(6, 100, raw({ CompletedLaps: 2, LapDistanceFraction: 0, LapTimeCurrentSelf: 0,
    LapTimePreviousSelf: 12, SectorTimesPreviousSelf: { Sector1: 4, Sector2: 8, Sector3: 12 }, Player: { GameSimulationTime: 11 } })));
  const report = analyzeCapture(document);
  assert.equal(report.finishes.length, 2);
  assert.equal(report.finishes[0].overlappingCrossings, true);
  assert.equal(report.finishes[0].firstChangedResultOffsetMs, null);
  assert.equal(report.finishes[0].lastObservedResultChangeOffsetMs, null);
});

test('missing, null and unavailable values remain distinct and cannot become zero-speed evidence', () => {
  const first = raw({ LapTimePreviousSelf: null, Player: {} });
  delete first.CarSpeed;
  const second = raw({ LapTimePreviousSelf: -1, Player: { GameSimulationTime: null }, LapDistanceFraction: 0.91, LapTimeCurrentSelf: 9.1 });
  const report = analyzeCapture(capture([message(1, 0, first), message(2, 100, second)]));
  assert.equal(report.unknownValues.LapTimePreviousSelf.null, 1);
  assert.equal(report.unknownValues.LapTimePreviousSelf.unavailable, 1);
  assert.equal(report.unknownValues['Player.GameSimulationTime'].missing, 1);
  assert.equal(report.unknownValues['Player.GameSimulationTime'].null, 1);
  assert.equal(report.movements[0].rawCarSpeedMps, null);
  assert.equal(report.movements[0].speedTimesSimulationDeltaM, null);
});

test('nonfinite or unavailable timing is counted without inventing a finish', () => {
  const report = analyzeCapture(capture([
    message(1, 0, raw()), message(2, 20, raw({ CompletedLaps: null, LapDistanceFraction: -1, LapTimeCurrentSelf: Number.NaN })),
  ]));
  assert.equal(report.summary.invalidTimingCount, 1);
  assert.equal(report.finishes.length, 0);
  assert.equal(report.boundaryObservations.length, 0);
});

test('physical movement report uses source elapsed time and an observed speed rather than a guessed threshold', () => {
  const report = analyzeCapture(capture([
    message(1, 0, raw({ LapDistanceFraction: 0.1, LapTimeCurrentSelf: 1, CarSpeed: 100, Player: { GameSimulationTime: 10 } })),
    message(2, 100, raw({ LapDistanceFraction: 0.11, LapTimeCurrentSelf: 1.1, CarSpeed: 100, Player: { GameSimulationTime: 10.1 } })),
  ]));
  assert.ok(Math.abs(report.movements[0].distanceM - 10) < 1e-9);
  assert.ok(Math.abs(report.movements[0].speedTimesSimulationDeltaM! - 10) < 1e-9);
  assert.equal(report.recordingEnabled, false);
});

test('incomplete and lost captures remain non-qualifying even with plausible timing', () => {
  const document = capture([
    message(1, 0, raw()), { kind: 'event', seq: 2, tMs: 20, connectionId: 1, type: 'loss', reason: 'buffer-overflow' },
  ], false);
  const report = analyzeCapture(document);
  assert.equal(report.complete, false);
  assert.equal(report.summary.lossEventCount, 1);
  assert.deepEqual(report.losses, [{ seq: 2, tMs: 20, reason: 'buffer-overflow' }]);
  assert.ok(report.issues.some(issue => /incomplete/i.test(issue)));
  assert.ok(report.issues.some(issue => /synthetic/i.test(issue)));
});

test('malformed observations and reset events remain visible in reports', () => {
  const report = analyzeCapture(capture([
    { kind: 'event', seq: 1, tMs: 0, connectionId: 1, type: 'open' },
    { kind: 'event', seq: 2, tMs: 1, connectionId: 1, type: 'malformed', reason: 'json' },
    { kind: 'event', seq: 3, tMs: 2, connectionId: 1, type: 'error', reason: 'socket-error' },
  ]));
  assert.equal(report.summary.malformedCount, 1);
  assert.equal(report.summary.transportResetEvents, 1);
  assert.equal(report.diagnostics.queueHighWaterBytes, 42);
});

test('raw observations and report outputs are deterministic and never mutated', () => {
  const document = orderedFinish();
  const before = structuredClone(document);
  assert.deepEqual(analyzeCapture(document), analyzeCapture(document));
  assert.deepEqual(document, before);
});

test('debug/source transitions are visible field changes rather than duplicate polling', () => {
  const report = analyzeCapture(capture([
    message(1, 0, raw({ Source: 'live', Debug: false })),
    message(2, 10, raw({ Source: 'debug', Debug: true })),
    message(3, 20, raw({ Source: 'live', Debug: false, CompletedLaps: 1, LapDistanceFraction: 0, LapTimeCurrentSelf: 0 })),
  ]));
  assert.equal(report.summary.duplicateMessageCount, 0);
  assert.ok(report.finishes[0].timeline.some(change => change.field === 'Source' && change.offsetMs === -10 && change.after.value === 'debug'));
  assert.ok(report.finishes[0].timeline.some(change => change.field === 'Debug' && change.offsetMs === -10 && change.after.value === true));
  assert.equal(report.unknownValues.Source.malformed, 0);
  assert.equal(report.unknownValues.Debug.malformed, 0);
});

test('equal timestamps preserve sequence, while backwards or missing sequence input is rejected', () => {
  const equal = capture([message(1, 0, raw()), message(2, 0, raw({ CompletedLaps: 1, LapDistanceFraction: 0, LapTimeCurrentSelf: 0 }))]);
  assert.equal(analyzeCapture(equal).connections[0].receiveGaps.minMs, 0);
  assert.throws(() => analyzeCapture(capture([message(1, 10, raw()), message(2, 9, raw())])), /order|timestamp/i);
  assert.throws(() => analyzeCapture(capture([message(1, 0, raw()), message(3, 1, raw())])), /sequence/i);
});

test('HTML/CSV report raw timing safely without exposing unrelated driver data or executable markup', () => {
  const document = orderedFinish();
  document.header.bridgeVersion = '<script>steal()</script>';
  document.events[2].data!.DriverData = [{ Name: 'Private Driver' }];
  document.events[2].data!.LapValidState = '=HYPERLINK("https://invalid.test")';
  const report = analyzeCapture(document);
  const html = formatAnalysisHtml(report);
  const csv = formatAnalysisCsv(report);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('&lt;script&gt;steal()&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('Private Driver'));
  assert.ok(!csv.includes('Private Driver'));
  assert.ok(csv.includes('LapValidState'));
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.match(html, /not established|not validated|disabled/i);
});

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'r3e-capture-analysis-'));
  const document = orderedFinish();
  const text = [document.header, ...document.events, document.footer].map(row => JSON.stringify(row)).join('\n') + '\n';
  const bytes = Buffer.from(text);
  await writeFile(join(directory, 'capture.jsonl'), bytes);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    version: 1, captureId: document.header.captureId, complete: true, source: 'synthetic',
    byteCount: bytes.length, eventCount: document.events.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), outputPath: directory, problems: [],
  }));
  return directory;
}

test('analysis CLI verifies a durable capture and writes JSON, CSV and standalone HTML', async t => {
  const directory = await fixtureDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'reports');
  await analyzeMain([directory, '--out', output, '--window-ms', '1000']);
  const report = JSON.parse(await readFile(join(output, 'analysis.json'), 'utf8'));
  assert.equal(report.liveValidated, false);
  assert.equal(report.recordingEnabled, false);
  assert.equal(report.integrity.manifestVerified, true);
  assert.equal(report.connections[0].receiveGaps.meanMs, 20);
  assert.ok((await readFile(join(output, 'analysis.csv'), 'utf8')).includes('LapTimePreviousSelf'));
  assert.ok((await readFile(join(output, 'analysis.html'), 'utf8')).startsWith('<!doctype html>'));
  const before = await readFile(join(output, 'analysis.json'), 'utf8');
  await assert.rejects(analyzeMain([directory, '--out', output]), /exist|EEXIST/i);
  assert.equal(await readFile(join(output, 'analysis.json'), 'utf8'), before);
});

test('analysis CLI rejects checksum-corrupted input before producing a report', async t => {
  const directory = await fixtureDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'capture.jsonl'), ' ' + await readFile(join(directory, 'capture.jsonl'), 'utf8'));
  await assert.rejects(analyzeMain([directory, '--out', join(directory, 'reports')]), /checksum|integrity/i);
});

test('analysis CLI rejects missing output, unknown flags and invalid measurement windows', async () => {
  await assert.rejects(analyzeMain(['capture.jsonl']), /usage|out/i);
  await assert.rejects(analyzeMain(['capture.jsonl', '--out', 'reports', '--unknown']), /unknown option/i);
  await assert.rejects(analyzeMain(['capture.jsonl', '--out', 'reports', '--window-ms', '-1']), /window/i);
});
