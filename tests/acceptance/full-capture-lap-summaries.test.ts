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
