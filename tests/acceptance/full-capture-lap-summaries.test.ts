import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaptureAnalysisReport } from '../../src/diagnostics/analyze.ts';
import { assertGeneratedLapSummaries } from '../fixtures/lap-summary-output-assertions.ts';

// Opt-in acceptance check: the full real recording is intentionally untracked.
// Supply its directory through R3E_FULL_CAPTURE; never substitute the excerpt.
test('full native capture produces six lap summaries without inserted loss resets or independent labels', async t => {
  const input = process.env.R3E_FULL_CAPTURE;
  assert.ok(input, 'Set R3E_FULL_CAPTURE to the original full capture directory');
  const sourceBytes = await readFile(join(input, 'capture.jsonl'));
  const digest = createHash('sha256').update(sourceBytes).digest('hex');
  assert.equal(digest, '67e59c0b3f83e05e4d0d1989fef1507bc83342788799cc40ea87ea3ba32cb88b');
  const sourceRows = sourceBytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(sourceRows.filter(row => row.type === 'loss').length, 0);
  assert.equal(sourceRows.filter(row => row.type === 'annotation').length, 0);
  assert.equal(sourceRows.filter(row => row.kind === 'event').length, 56940);
  // Audit the existing sanitized windows against their original receipts. The
  // excerpt deliberately changes only sequence numbers and inserts loss gaps;
  // it is not a substitute for the full preceding engine state.
  const fixtureUrl = new URL('../fixtures/lap-count-windows/', import.meta.url);
  const fixtureBytes = await readFile(new URL('capture.jsonl', fixtureUrl));
  const provenance = JSON.parse(await readFile(new URL('provenance.json', fixtureUrl), 'utf8'));
  assert.equal(provenance.sourceSha256, digest);
  assert.equal(provenance.sourceByteCount, sourceBytes.length);
  assert.equal(provenance.sourceEventCount, sourceRows.filter(row => row.kind === 'event').length);
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), provenance.fixtureSha256);
  const fixtureRows = fixtureBytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(provenance.independentValidityLabels, []);
  for (const observation of provenance.observations) {
    const original = sourceRows[observation.sourceLine - 1];
    assert.equal(original.seq, observation.sourceSeq);
    const retained = fixtureRows.find(row => row.kind === 'event' && row.seq === observation.fixtureSeq);
    assert.ok(retained, 'Every provenance mapping must identify a retained receipt');
    assert.deepEqual({ ...retained, seq: original.seq }, original);
  }
  const originalOpen = sourceRows.find(row => row.kind === 'event' && row.seq === provenance.sourceOpenSeq);
  const fixtureOpen = fixtureRows.find(row => row.type === 'open');
  assert.ok(originalOpen && fixtureOpen);
  assert.deepEqual({ ...fixtureOpen, seq: originalOpen.seq }, originalOpen);
  const directory = await mkdtemp(join(tmpdir(), 'r3e-full-lap-summaries-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'analysis');
  execFileSync('npm', ['run', 'analyze:capture', '--', input, '--out', output], {
    encoding: 'utf8', timeout: 60_000, cwd: fileURLToPath(new URL('../../', import.meta.url)),
  });
  const json = JSON.parse(await readFile(join(output, 'analysis.json'), 'utf8')) as CaptureAnalysisReport & {
    integrity: { manifestVerified: boolean; sha256: string };
  };
  assert.equal(json.complete, true);
  assert.equal(json.integrity.manifestVerified, true);
  assert.equal(json.integrity.sha256, digest);
  assert.equal(json.captureId, 'f489307d-60e5-4188-9e9b-fce95b169b88');
  assert.equal(json.summary.annotationCount, 0);
  assert.equal(json.summary.lossEventCount, 0);
  assert.equal(json.liveValidated, false);
  assert.equal(json.recordingEnabled, false);
  assert.deepEqual(json.reportedLaps.map(row => [row.completedLap, row.seq, row.totalUs]), [
    [1, 10142, null], [2, 19159, null], [3, 28104, 149_494_965],
    [4, 37068, 149_835_876], [5, 46015, null], [6, 54986, null],
  ]);
  for (const lap of json.reportedLaps) {
    assert.equal(lap.source, 'telemetry');
    assert.equal(lap.finality, 'not-established');
    const observation = lap.observations.find(row => row.seq === lap.seq);
    assert.ok(observation, 'Retain the original crossing receipt');
    assert.deepEqual(observation.fields.PrevLapValid,
      { present: true, value: [3, 4].includes(lap.completedLap) ? 1 : 0 });
  }
  assert.equal(createHash('sha256').update(await readFile(join(input, 'capture.jsonl'))).digest('hex'), digest);
  assertGeneratedLapSummaries(
    await readFile(join(output, 'analysis.html'), 'utf8'),
    await readFile(join(output, 'analysis.csv'), 'utf8'), json.reportedLaps);
});
