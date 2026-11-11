import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CaptureDocument, CaptureEvent, CaptureHeader, CaptureManifest } from '../src/diagnostics/capture-format.ts';
import { DEFAULT_CAPTURE_LIMITS } from '../src/diagnostics/capture-format.ts';
import { replayCapture } from '../src/diagnostics/replay.ts';
import { readCaptureFile } from '../scripts/replay-capture.ts';

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    VersionMajor: 3, VersionMinor: 6, LayoutId: 10, LayoutLength: 3000,
    VehicleInfo: { ModelId: 20 }, SessionType: 0, SessionIteration: 1, EventIndex: 0,
    Player: { GameSimulationTime: 10 }, CompletedLaps: 0, LapDistanceFraction: 0,
    LapTimeCurrentSelf: 0, LapValidState: 0, LapTimePreviousSelf: -1,
    SectorTimesPreviousSelf: { Sector1: -1, Sector2: -1, Sector3: -1 },
    PrevLapValid: -1, ControlType: 0, GameInReplay: 0, GamePaused: 0, GameInMenus: 0,
    ...overrides,
  };
}

function fixture(overrides: Partial<CaptureHeader> = {}): CaptureDocument {
  const values: [number, Record<string, unknown>][] = [
    [0, raw()],
    [250, raw({ LapDistanceFraction: 0.25, LapTimeCurrentSelf: 0.25 })],
    [500, raw({ LapDistanceFraction: 0.5, LapTimeCurrentSelf: 0.5 })],
    [750, raw({ LapDistanceFraction: 0.75, LapTimeCurrentSelf: 0.75 })],
    [1000, raw({ CompletedLaps: 1, LapTimePreviousSelf: 1,
      SectorTimesPreviousSelf: { Sector1: 0.3, Sector2: 0.6, Sector3: 1 }, PrevLapValid: 1 })],
  ];
  const events: CaptureEvent[] = [{ kind: 'event', seq: 1, tMs: 0, connectionId: 1, type: 'open' }];
  for (const [tMs, data] of values) events.push({ kind: 'event', seq: events.length + 1, tMs, connectionId: 1, type: 'message', data });
  return {
    header: { kind: 'header', version: 1, captureId: 'synthetic-replay', startedAt: '2026-11-11T00:00:00.000Z',
      source: 'synthetic', hudVersion: 'test', gameVersion: 'synthetic', bridgeVersion: 'synthetic',
      browser: 'synthetic', pollMs: 16, limits: { ...DEFAULT_CAPTURE_LIMITS }, ...overrides },
    events,
    footer: { kind: 'footer', complete: true, reason: 'stopped', eventCount: events.length, lastSeq: events.length,
      durationMs: 1000, queueHighWaterBytes: 1024, lossCount: 0 },
    complete: true, problems: [],
  };
}

function serialize(document: CaptureDocument): string {
  return [document.header, ...document.events, ...(document.footer ? [document.footer] : [])]
    .map(row => JSON.stringify(row)).join('\n') + '\n';
}

test('replay is deterministic and shadow proposals never authorize the control/live path', () => {
  const capture = fixture();
  const report = replayCapture(capture);
  assert.deepEqual(report, replayCapture(capture));
  assert.equal(report.complete, true);
  assert.equal(report.infrastructureEligible, true);
  assert.equal(report.liveWritesEnabled, false);
  assert.equal(report.profileValidated, false);
  assert.deepEqual(report.controlProposals, []);
  assert.equal(report.shadowProposals.length, 1);
  assert.deepEqual(report.shadowProposals.map(({ completedLap, totalUs, bestChanged, optChanged }) =>
    ({ completedLap, totalUs, bestChanged, optChanged })),
  [{ completedLap: 1, totalUs: 1_000_000, bestChanged: true, optChanged: true }]);
  assert.equal(report.records[0].best!.totalUs, 1_000_000);
  assert.ok(report.unresolved.some(item => /unlabeled/i.test(item.reason)));
});

test('independent valid annotations compare actual captured improvement total and identity', () => {
  const report = replayCapture(fixture(), { annotations: [{ completedLap: 1, layoutId: 10, modelId: 20, outcome: 'valid', totalUs: 1_000_000 }] });
  assert.equal(report.comparisons[0].status, 'pass');
  assert.equal(report.comparisons[0].proposalCount, 1);
  assert.equal(report.profileValidated, false);
});

test('a result accepted before later independently known invalidity is reported as a failure', () => {
  const report = replayCapture(fixture(), { annotations: [{ completedLap: 1, outcome: 'invalid' }] });
  assert.equal(report.comparisons[0].status, 'fail');
  assert.match(report.comparisons[0].reason, /invalid/i);
});

test('mismatched independently annotated totals fail rather than becoming expected output', () => {
  const report = replayCapture(fixture(), { annotations: [{ completedLap: 1, outcome: 'valid', totalUs: 900_000 }] });
  assert.equal(report.comparisons[0].status, 'fail');
  assert.match(report.comparisons[0].reason, /total/i);
});

test('independently declared display precision is explicit while omitted tolerance remains exact', () => {
  const capture = fixture();
  capture.events.at(-1)!.data = raw({ CompletedLaps: 1, LapTimePreviousSelf: 1.0005,
    SectorTimesPreviousSelf: { Sector1: 0.30015, Sector2: 0.6003, Sector3: 1.0005 }, PrevLapValid: 1 });
  const label = { completedLap: 1, outcome: 'valid' as const, totalUs: 1_000_000 };
  const withTolerance = replayCapture(capture, { annotations: [{ ...label, totalToleranceUs: 1000 }] });
  assert.equal(withTolerance.comparisons[0].status, 'pass');
  assert.equal(withTolerance.comparisons[0].annotation.totalToleranceUs, 1000);
  assert.match(withTolerance.comparisons[0].reason, /tolerance|precision/i);
  assert.equal(replayCapture(capture, { annotations: [{ ...label, totalToleranceUs: 499 }] }).comparisons[0].status, 'fail');
  assert.equal(replayCapture(capture, { annotations: [label] }).comparisons[0].status, 'fail');
});

test('invalid or incomplete captures do not yield shadow improvements', () => {
  for (const change of ['invalid', 'mid-lap'] as const) {
    const capture = fixture();
    if (change === 'invalid') capture.events[3].data!.LapValidState = 1;
    else capture.events.splice(1, 1);
    capture.events.forEach((event, index) => { event.seq = index + 1; });
    capture.footer!.eventCount = capture.footer!.lastSeq = capture.events.length;
    const report = replayCapture(capture);
    assert.deepEqual(report.shadowProposals, [], change);
  }
});

test('recorded disconnect/reopen prevents stitching across connection epochs', () => {
  const capture = fixture();
  capture.events.splice(4, 0,
    { kind: 'event', seq: 0, tMs: 600, connectionId: 1, type: 'close' },
    { kind: 'event', seq: 0, tMs: 700, connectionId: 2, type: 'open' });
  capture.events.forEach((event, index) => {
    event.seq = index + 1;
    if (index >= 6) event.connectionId = 2;
  });
  capture.footer!.eventCount = capture.footer!.lastSeq = capture.events.length;
  assert.deepEqual(replayCapture(capture).shadowProposals, []);
});

test('malformed-message resets survive capture replay', () => {
  const capture = fixture();
  capture.events.splice(4, 0, { kind: 'event', seq: 0, tMs: 600, connectionId: 1,
    type: 'malformed', reason: 'invalid-json', byteLength: 1, messageType: 'string' });
  capture.events.forEach((event, index) => { event.seq = index + 1; });
  capture.footer!.eventCount = capture.footer!.lastSeq = capture.events.length;
  const report = replayCapture(capture);
  assert.deepEqual(report.shadowProposals, []);
  assert.ok(report.issues.some(issue => /malformed/i.test(issue)));
});

test('equal timestamps and repeated messages preserve sequence and do not duplicate proposals', () => {
  const capture = fixture();
  capture.events.push({ ...capture.events.at(-1)!, seq: capture.events.length + 1 });
  capture.footer!.eventCount = capture.footer!.lastSeq = capture.events.length;
  const report = replayCapture(capture);
  assert.equal(report.shadowProposals.length, 1);
  assert.equal(report.shadowResults.length, 1);
});

test('changed previous totals without a crossing cannot produce an accepted shadow proposal', () => {
  const capture = fixture();
  capture.events.at(-1)!.data!.CompletedLaps = 0;
  capture.events.at(-1)!.data!.LapDistanceFraction = 0.9;
  capture.events.at(-1)!.data!.LapTimeCurrentSelf = 0.9;
  assert.deepEqual(replayCapture(capture).shadowProposals, []);
});

test('corrupt or backwards event order is rejected rather than sorted', () => {
  const capture = fixture();
  capture.events[3].tMs = 1;
  assert.throws(() => replayCapture(capture), /time|order|monotonic/i);
});

test('partial files remain explicitly incomplete and ineligible even when replay is allowed', () => {
  const capture = fixture();
  capture.footer = null;
  capture.complete = false;
  capture.problems = ['Missing footer'];
  const report = replayCapture(capture);
  assert.equal(report.complete, false);
  assert.equal(report.infrastructureEligible, false);
  assert.equal(report.profileValidated, false);
});

test('a loader-marked incomplete manifest cannot be erased by a superficially complete footer', () => {
  const capture = fixture();
  capture.complete = false;
  capture.problems = ['Capture manifest marks this session incomplete'];
  const report = replayCapture(capture);
  assert.equal(report.complete, false);
  assert.equal(report.infrastructureEligible, false);
});

test('unknown labels and valid non-improvements are unresolved rather than fabricated passes', () => {
  const report = replayCapture(fixture(), { annotations: [{ completedLap: 1, outcome: 'unknown' }, { completedLap: 2, outcome: 'valid', totalUs: 1_000_000 }] });
  assert.deepEqual(report.comparisons.map(value => value.status), ['unresolved', 'unresolved']);
});

test('a fully captured tied lap is engine-accepted without being promoted to another record write', () => {
  const capture = fixture();
  for (const [tMs, distance, elapsed] of [[1250, 0.25, 0.25], [1500, 0.5, 0.5], [1750, 0.75, 0.75], [2000, 0, 0]]) {
    capture.events.push({ kind: 'event', seq: capture.events.length + 1, tMs, connectionId: 1, type: 'message',
      data: raw({ CompletedLaps: tMs === 2000 ? 2 : 1, LapDistanceFraction: distance, LapTimeCurrentSelf: elapsed,
        LapTimePreviousSelf: 1, SectorTimesPreviousSelf: { Sector1: tMs === 2000 ? 0.2 : 0.3, Sector2: 0.6, Sector3: 1 }, PrevLapValid: 1 }) });
  }
  capture.footer!.eventCount = capture.footer!.lastSeq = capture.events.length;
  capture.footer!.durationMs = 2000;
  const report = replayCapture(capture, { annotations: [{ completedLap: 2, outcome: 'valid', totalUs: 1_000_000 }] });
  assert.equal(report.acceptedLaps.length, 2);
  assert.equal(report.shadowProposals.length, 1);
  assert.equal(report.shadowResults[1].engineAccepted, true);
  assert.equal(report.shadowResults[1].engineImprovement, false);
  assert.equal(report.comparisons[0].status, 'pass');
  assert.equal(report.comparisons[0].acceptedCount, 1);
  assert.equal(report.comparisons[0].proposalCount, 0);
});

test('an unlabeled crossing with an ambiguous unchanged result remains unresolved in the report', () => {
  const capture = fixture();
  for (const [tMs, distance, elapsed] of [[1250, 0.25, 0.25], [1500, 0.5, 0.5], [1750, 0.75, 0.75], [2000, 0, 0]]) {
    capture.events.push({ kind: 'event', seq: capture.events.length + 1, tMs, connectionId: 1, type: 'message',
      data: raw({ CompletedLaps: tMs === 2000 ? 2 : 1, LapDistanceFraction: distance, LapTimeCurrentSelf: elapsed,
        LapTimePreviousSelf: 1, SectorTimesPreviousSelf: { Sector1: 0.3, Sector2: 0.6, Sector3: 1 }, PrevLapValid: 1 }) });
  }
  capture.footer!.eventCount = capture.footer!.lastSeq = capture.events.length;
  capture.footer!.durationMs = 2000;
  const report = replayCapture(capture);
  assert.equal(report.shadowResults.length, 1);
  assert.equal(report.unresolved.length, 2);
  const ambiguous = report.unresolved.find(value => value.annotation.completedLap === 2)!;
  assert.equal(ambiguous.authorizedResultCount, 0);
  assert.match(ambiguous.reason, /unlabeled|ambiguous/i);
});

test('annotation events use their observed connection/session context without deriving a label', () => {
  const capture = fixture();
  capture.events.push({ kind: 'event', seq: capture.events.length + 1, tMs: 1100, connectionId: 1,
    type: 'annotation', annotation: { completedLap: 1, outcome: 'valid', totalUs: 1_000_000 } });
  capture.footer!.eventCount = capture.footer!.lastSeq = capture.events.length;
  capture.footer!.durationMs = 1100;
  const report = replayCapture(capture);
  assert.equal(report.comparisons[0].origin, 'event');
  assert.equal(report.comparisons[0].status, 'pass');
  assert.deepEqual(report.unresolved, []);
});

test('rejected crossings in repeated sessions require explicit label identity and expose that context', () => {
  const capture = fixture();
  for (const event of capture.events) {
    if (!event.data) continue;
    event.data.LapValidState = 1;
    if (event.data.CompletedLaps === 1) event.data.PrevLapValid = 0;
  }
  for (const original of fixture().events.filter(event => event.type === 'message')) {
    const data: Record<string, unknown> = { ...original.data!, SessionIteration: 2, LapValidState: 1 };
    if (data.CompletedLaps === 1) data.PrevLapValid = 0;
    capture.events.push({ ...original, data, seq: capture.events.length + 1, tMs: original.tMs + 1250 });
  }
  capture.footer!.eventCount = capture.footer!.lastSeq = capture.events.length;
  capture.footer!.durationMs = 2250;
  const ambiguous = replayCapture(capture, { annotations: [{ completedLap: 1, outcome: 'invalid' }] });
  assert.equal(ambiguous.comparisons[0].status, 'unresolved');
  assert.match(ambiguous.comparisons[0].reason, /multiple sessions/i);
  assert.equal(ambiguous.observedCrossings.length, 2);
  const sessionId = ambiguous.observedCrossings[1].sessionId;
  const explicit = replayCapture(capture, { annotations: [{ completedLap: 1, outcome: 'invalid', connectionId: 1, sessionId }] });
  assert.equal(explicit.comparisons[0].status, 'pass');
  assert.equal(explicit.comparisons[0].annotation.sessionId, sessionId);
  assert.equal(explicit.comparisons[0].annotation.connectionId, 1);
  const unlabeled = replayCapture(capture);
  assert.equal(unlabeled.unresolved.length, 2);
  assert.ok(unlabeled.unresolved.every(value => value.annotation.connectionId === 1 && value.annotation.sessionId));
});

test('layout/session changes retain independent captured records within the isolated replay store', () => {
  const capture = fixture();
  for (const [offset, distance] of [[0, 0], [250, 0.25], [500, 0.5], [750, 0.75], [1000, 0]]) {
    capture.events.push({ kind: 'event', seq: capture.events.length + 1, tMs: 1250 + offset, connectionId: 1,
      type: 'message', data: raw({ LayoutId: 11, CompletedLaps: offset === 1000 ? 1 : 0,
        LapDistanceFraction: distance, LapTimeCurrentSelf: distance * 2,
        ...(offset === 1000 ? { LapTimePreviousSelf: 2, SectorTimesPreviousSelf: { Sector1: 0.6, Sector2: 1.2, Sector3: 2 }, PrevLapValid: 1 } : {}) }) });
  }
  capture.events.push({ kind: 'event', seq: capture.events.length + 1, tMs: 2500, connectionId: 1,
    type: 'message', data: raw() });
  capture.footer!.eventCount = capture.footer!.lastSeq = capture.events.length;
  capture.footer!.durationMs = 2500;
  const report = replayCapture(capture);
  assert.deepEqual(report.records.map(value => [value.layoutId, value.best?.totalUs]), [[10, 1_000_000], [11, 2_000_000]]);
  assert.equal(report.acceptedLaps.length, 2);
  assert.equal(report.controlProposals.length, 0);
});

test('file loader verifies complete directory manifests and rejects modified capture bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r3e-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const text = serialize(fixture());
  const manifest: CaptureManifest = { version: 1, captureId: 'synthetic-replay', complete: true,
    source: 'synthetic', byteCount: Buffer.byteLength(text), eventCount: fixture().events.length,
    sha256: createHash('sha256').update(text).digest('hex'), outputPath: directory, problems: [] };
  await writeFile(join(directory, 'capture.jsonl'), text);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  const loaded = await readCaptureFile(directory);
  assert.equal(loaded.manifestVerified, true);
  assert.equal(loaded.document.complete, true);
  await writeFile(join(directory, 'capture.jsonl'), (await readFile(join(directory, 'capture.jsonl'), 'utf8')) + '\n');
  await assert.rejects(() => readCaptureFile(directory), /checksum|byte|digest|integrity/i);
});

test('directory input requires a manifest and incomplete standalone input requires opt-in', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r3e-replay-partial-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const capture = fixture(); capture.footer = null;
  const path = join(directory, 'capture.jsonl');
  await writeFile(path, serialize(capture));
  await assert.rejects(() => readCaptureFile(directory), /manifest/i);
  await assert.rejects(() => readCaptureFile(path), /incomplete|footer/i);
  assert.equal((await readCaptureFile(path, { allowIncomplete: true })).document.complete, false);
});

test('a null or malformed present manifest never silently disables integrity verification', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r3e-replay-bad-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'capture.jsonl'), serialize(fixture()));
  for (const value of [null, {}, [], { version: 1, sha256: 'not-a-digest' }]) {
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(value));
    await assert.rejects(() => readCaptureFile(directory), /manifest|integrity/i);
  }
});

test('the actual CLI writes an isolated shadow report and refuses to overwrite existing output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r3e-replay-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const capturePath = join(directory, 'capture.jsonl');
  const reportDirectory = join(directory, 'report');
  await writeFile(capturePath, serialize(fixture()));
  const execute = promisify(execFile);
  const args = ['--import', 'tsx', 'scripts/replay-capture.ts', capturePath, '--out', reportDirectory];
  const result = await execute(process.execPath, args, { cwd: process.cwd() });
  assert.match(result.stdout, /live writes remain disabled/);
  const report = JSON.parse(await readFile(join(reportDirectory, 'replay.json'), 'utf8'));
  assert.equal(report.shadowProposals.length, 1);
  assert.deepEqual(report.controlProposals, []);
  assert.equal(report.liveWritesEnabled, false);
  assert.equal(report.profileValidated, false);
  await assert.rejects(() => execute(process.execPath, args, { cwd: process.cwd() }), /EEXIST|exist/i);
});

test('CLI labeled mismatches preserve the report and return a failing comparison exit code', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r3e-replay-cli-mismatch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'capture.jsonl'), serialize(fixture()));
  await writeFile(join(directory, 'labels.json'), JSON.stringify([{ completedLap: 1, outcome: 'invalid' }]));
  const execute = promisify(execFile);
  await assert.rejects(() => execute(process.execPath, ['--import', 'tsx', 'scripts/replay-capture.ts',
    join(directory, 'capture.jsonl'), '--out', join(directory, 'report'), '--annotations', join(directory, 'labels.json')],
  { cwd: process.cwd() }), error => typeof error === 'object' && error !== null && 'code' in error && error.code === 2);
  const report = JSON.parse(await readFile(join(directory, 'report', 'replay.json'), 'utf8'));
  assert.equal(report.comparisons[0].status, 'fail');
  assert.equal(report.liveWritesEnabled, false);
});
