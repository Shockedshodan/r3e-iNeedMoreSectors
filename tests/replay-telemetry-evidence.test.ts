import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeCapture } from '../src/diagnostics/analyze.ts';
import type { ReportedLap } from '../src/diagnostics/analyze.ts';
import { DEFAULT_CAPTURE_LIMITS, parseCapture, projectRawTelemetry } from '../src/diagnostics/capture-format.ts';
import type { CaptureDocument } from '../src/diagnostics/capture-format.ts';
import { replayCapture } from '../src/diagnostics/replay.ts';
import type { ReplayAnnotation } from '../src/diagnostics/replay.ts';
import { lapFrames } from './fixtures/browser-bridge.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = new URL('./fixtures/lap-count-windows/', import.meta.url);

async function retainedCapture(): Promise<CaptureDocument> {
  const bytes = await readFile(new URL('capture.jsonl', fixture));
  const provenance = JSON.parse(await readFile(new URL('provenance.json', fixture), 'utf8'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.fixtureSha256);
  assert.equal(provenance.sourceSha256,
    '67e59c0b3f83e05e4d0d1989fef1507bc83342788799cc40ea87ea3ba32cb88b');
  assert.equal(provenance.sourceByteCount, 45_541_348);
  assert.equal(provenance.sourceEventCount, 56_940);
  assert.deepEqual(provenance.independentValidityLabels, []);
  assert.deepEqual(provenance.observations.map((row: { fixtureSeq: number; sourceSeq: number }) =>
    [row.fixtureSeq, row.sourceSeq]), [
    [2, 10141], [3, 10142], [5, 19158], [6, 19159], [8, 28103], [9, 28104],
    [11, 37067], [12, 37068], [14, 46014], [15, 46015], [17, 54985], [18, 54986],
  ]);
  const document = parseCapture(bytes.toString('utf8'), { allowIncomplete: true });
  assert.equal(document.header.captureId, `${provenance.sourceCaptureId}-count-windows`);
  assert.equal(document.complete, false);
  assert.equal(document.events.filter(event => event.type === 'loss').length, 5);
  assert.ok(document.events.filter(event => event.type === 'message').every(event =>
    event.data?.VersionMajor === 2 && event.data.VersionMinor === 8));
  assert.deepEqual(analyzeCapture(document).reportedLaps.map(row =>
    [row.seq, row.completedLap, row.association, row.totalUs]), [
    [3, 1, 'unavailable', null], [6, 2, 'unavailable', null],
    [9, 3, 'reported', 149_494_965], [12, 4, 'reported', 149_835_876],
    [15, 5, 'unavailable', null], [18, 6, 'unavailable', null],
  ]);
  return document;
}

// These variants exercise evidence handling, never real-game semantics. Keep
// the original fixture untouched, explicitly change source, and retain loss
// markers so an adjacent pair cannot become a complete engine-captured lap.
function syntheticAssociation(document: CaptureDocument, association: 'stale' | 'ambiguous'): CaptureDocument {
  const variant = structuredClone(document);
  variant.header.source = 'synthetic';
  variant.header.captureId = `synthetic-${association}-native-evidence`;
  const before = variant.events.find(event => event.seq === 8)!;
  const crossing = variant.events.find(event => event.seq === 9)!;
  assert.ok(before.data && crossing.data);
  if (association === 'stale') {
    for (const field of ['LapTimePreviousSelf', 'SectorTimesPreviousSelf', 'PrevLapValid']) {
      before.data[field] = structuredClone(crossing.data[field]);
    }
  } else {
    // A fresh total with conflicting cumulative sectors has no single result.
    crossing.data.SectorTimesPreviousSelf = {
      ...(crossing.data.SectorTimesPreviousSelf as Record<string, number>), Sector3: 150,
    };
  }
  return variant;
}

function nativeLabel(row: ReportedLap, outcome: ReplayAnnotation['outcome']) {
  assert.equal(row.source, 'telemetry');
  assert.equal(row.finality, 'not-established');
  assert.ok(row.layoutId !== null && row.modelId !== null);
  // Use the analysis report's own provenance vocabulary. Do not turn a native
  // flag or total into a fictitious independent game-screen observation.
  return {
    source: row.source, completedLap: row.completedLap, connectionId: row.connectionId,
    layoutId: row.layoutId, modelId: row.modelId, outcome,
    ...(row.totalUs === null ? {} : { totalUs: row.totalUs }),
  };
}

async function replayFromSourceOnlyCheckout(t: TestContext, document: CaptureDocument,
  label: ReturnType<typeof nativeLabel>) {
  const directory = await mkdtemp(join(tmpdir(), 'r3e-native-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // No .git, AI metadata, reports, R3E_FULL_CAPTURE, or ignored capture is
  // available in this checkout. Only HUD source and this verified input travel.
  await cp(join(root, 'src'), join(directory, 'src'), { recursive: true });
  await mkdir(join(directory, 'scripts'));
  await cp(join(root, 'scripts/replay-capture.ts'), join(directory, 'scripts/replay-capture.ts'));
  await cp(join(root, 'package.json'), join(directory, 'package.json'));
  const input = join(directory, 'capture.jsonl');
  const text = [document.header, ...document.events, document.footer]
    .map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(input, text);
  await writeFile(join(directory, 'labels.json'), JSON.stringify([label]));
  const env = { ...process.env };
  delete env.R3E_FULL_CAPTURE;
  // Use the installed loader, but run the copied public CLI and source tree.
  // Bound every child even if replay regresses into a hang.
  let exitCode = 0;
  try {
    execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'),
      'scripts/replay-capture.ts', input, '--out', 'output', '--allow-incomplete',
      '--annotations', 'labels.json'], { cwd: directory, env, timeout: 10_000, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    assert.ok(error && typeof error === 'object' && 'status' in error);
    // A missing dependency/fixture or CLI error must never count as the red
    // baseline: only the existing comparison-mismatch exit is admissible.
    assert.equal(error.status, 2, 'The public CLI must successfully read and replay the retained input');
    exitCode = 2;
  }
  assert.equal(await readFile(input, 'utf8'), text);
  const report = JSON.parse(await readFile(join(directory, 'output/replay.json'), 'utf8'));
  assert.equal(report.captureId, document.header.captureId);
  assert.equal(report.complete, false);
  assert.equal(report.infrastructureEligible, false);
  assert.equal(report.liveWritesEnabled, false);
  assert.equal(report.profileValidated, false);
  assert.deepEqual(report.controlProposals, []);
  assert.deepEqual(report.shadowProposals, []);
  assert.deepEqual(report.acceptedLaps, []);
  assert.ok(report.records.every((record: { best: unknown; opt: unknown }) => record.best === null && record.opt === null));
  assert.doesNotMatch(report.issues.join('\n'), /unsupported.*version|expected 3\.6/i);
  assert.equal(report.comparisons.length, 1, 'Keep the supplied label visible with its evidence source');
  return { report, exitCode };
}

for (const scenario of [
  { name: 'native valid flags and totals remain unresolved on an interrupted real lap', lap: 3, outcome: 'valid', totalUs: 149_494_965 },
  { name: 'native invalidity cannot pass as an independent rejection check', lap: 5, outcome: 'invalid', totalUs: null },
  { name: 'unavailable native clocks cannot confirm an independent incomplete-lap verdict', lap: 2, outcome: 'incomplete', totalUs: null },
] as const) {
  test(scenario.name, async t => {
    const document = await retainedCapture();
    const before = structuredClone(document);
    const row = analyzeCapture(document).reportedLaps.find(value => value.completedLap === scenario.lap);
    assert.ok(row);
    assert.equal(row.totalUs, scenario.totalUs);
    const receipt = document.events.find(event => event.seq === row.seq);
    assert.ok(receipt?.data);
    assert.equal(receipt.data.PrevLapValid, scenario.outcome === 'valid' ? 1 : 0);
    // Preserve existing optional independent-label comparison semantics in an
    // explicitly synthetic control; these are not new labels for real driving.
    const control = structuredClone(document);
    control.header.source = 'synthetic';
    const independent = { completedLap: scenario.lap, connectionId: 1, outcome: 'incomplete' as const };
    assert.equal(replayCapture(control, { annotations: [independent] }).comparisons[0].status, 'pass');
    assert.equal(replayCapture(control, { annotations: [{ ...independent, outcome: 'valid', totalUs: 1 }] })
      .comparisons[0].status, 'fail', 'A genuine comparison mismatch must still fail');
    const { report, exitCode } = await replayFromSourceOnlyCheckout(t, document, nativeLabel(row, scenario.outcome));
    assert.deepEqual(document, before, 'Preserve received API versions, receipts, loss markers and metadata');
    assert.equal(report.comparisons[0].status, 'unresolved',
      'Telemetry-derived evidence must not become an independently confirmed pass or failure');
    assert.equal(report.comparisons[0].annotation.source, 'telemetry', 'Retain the declared evidence source');
    assert.equal(exitCode, 0, 'Unresolved native evidence is distinct from a detected independent mismatch');
  });
}

for (const association of ['stale', 'ambiguous'] as const) {
  test(`${association} native results retain telemetry provenance without confirming a lap`, async t => {
    const document = syntheticAssociation(await retainedCapture(), association);
    const row = analyzeCapture(document).reportedLaps.find(value => value.completedLap === 3);
    assert.ok(row);
    assert.equal(row.association, association);
    assert.equal(row.totalUs, null, 'Do not select a confirmed total from unresolved evidence');
    assert.ok(row.observations.length >= 2, 'Retain the receipts explaining the association');
    const { report, exitCode } = await replayFromSourceOnlyCheckout(t, document, nativeLabel(row, 'unknown'));
    assert.equal(report.comparisons[0].status, 'unresolved');
    assert.equal(report.comparisons[0].annotation.source, 'telemetry',
      'An unresolved association must not erase the native evidence source');
    assert.equal(exitCode, 0);
  });
}

test('an accepted complete lap keeps telemetry labels unresolved while independent totals still compare', () => {
  // Explicit synthetic authorization exercises complete-lap tooling only; it
  // supplies neither real-game validity nor permission to save live records.
  const events = [
    { kind: 'event', type: 'open', seq: 1, tMs: 0, connectionId: 1 },
    ...lapFrames(0).map((packet, index) => ({
      kind: 'event', type: 'message', seq: index + 2, tMs: index * 100,
      connectionId: 1, data: projectRawTelemetry({ ...packet, VersionMajor: 2, VersionMinor: 8 }),
    })),
  ];
  const document = parseCapture([
    { kind: 'header', version: 1, captureId: 'synthetic-complete-lap-evidence',
      startedAt: '2026-11-11T00:00:00.000Z', source: 'synthetic', hudVersion: 'test',
      gameVersion: 'synthetic', bridgeVersion: 'synthetic', browser: 'synthetic',
      pollMs: 16, limits: { ...DEFAULT_CAPTURE_LIMITS } },
    ...events,
    { kind: 'footer', complete: true, reason: 'stopped', eventCount: events.length,
      lastSeq: events.length, durationMs: 400, queueHighWaterBytes: 0, lossCount: 0 },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const before = structuredClone(document);
  const baseline = replayCapture(document);
  assert.equal(document.complete, true);
  assert.equal(baseline.complete, true);
  assert.equal(baseline.infrastructureEligible, true);
  assert.deepEqual(baseline.acceptedLaps.map(row => [row.completedLap, row.totalUs]), [[1, 1_000_000]],
    'First prove the complete fixture actually produces one engine-accepted lap');
  assert.deepEqual(baseline.shadowProposals.map(row => row.totalUs), [1_000_000]);
  const rows = analyzeCapture(document).reportedLaps;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].association, 'reported');
  assert.equal(rows[0].totalUs, 1_000_000);
  const telemetry = nativeLabel(rows[0], 'valid');
  const { source, ...independent } = telemetry;
  assert.equal(source, 'telemetry');
  // These independent labels are synthetic comparison controls, not invented
  // screen annotations for any retained real-game receipt.
  const matching = replayCapture(document, { annotations: [independent] });
  const mismatching = replayCapture(document, { annotations: [{ ...independent, totalUs: 1_000_001 }] });
  assert.equal(matching.comparisons[0].status, 'pass');
  assert.equal(mismatching.comparisons[0].status, 'fail');
  const derived = replayCapture(document, { annotations: [telemetry] });
  for (const report of [matching, mismatching, derived]) {
    assert.equal(report.complete, true);
    assert.equal(report.infrastructureEligible, true);
    assert.deepEqual(report.acceptedLaps, baseline.acceptedLaps, 'Evidence source must not suppress engine acceptance');
    assert.deepEqual(report.shadowProposals, baseline.shadowProposals);
    assert.deepEqual(report.controlProposals, []);
    assert.equal(report.liveWritesEnabled, false);
    assert.equal(report.profileValidated, false);
  }
  assert.deepEqual(document, before, 'All label comparisons preserve the complete source capture');
  assert.equal(derived.comparisons.length, 1);
  assert.equal(derived.comparisons[0].status, 'unresolved',
    'Engine acceptance and complete capture cannot make telemetry an independent confirmation');
  assert.deepEqual(derived.comparisons[0].annotation, telemetry, 'Retain telemetry provenance on the complete lap');
});
