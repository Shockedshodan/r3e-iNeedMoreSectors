import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { analyzeCapture } from '../src/diagnostics/analyze.ts';
import { DEFAULT_CAPTURE_LIMITS, parseCapture, projectRawTelemetry } from '../src/diagnostics/capture-format.ts';
import { replayCapture } from '../src/diagnostics/replay.ts';
import { lapFrames } from './fixtures/browser-bridge.ts';

test('replay processes a complete synthetic alternate-minor lap and retains received version metadata', () => {
  const packets = lapFrames(0).map(data => ({ ...data, VersionMinor: 77 }));
  const events = [
    { kind: 'event', type: 'open', seq: 1, tMs: 0, connectionId: 1 },
    ...packets.map((data, index) => ({ kind: 'event', type: 'message',
      seq: index + 2, tMs: index * 100, connectionId: 1, data: projectRawTelemetry(data) })),
  ];
  const document = parseCapture([
    { kind: 'header', version: 1, captureId: 'synthetic-alternate-minor',
      startedAt: '2026-11-11T00:00:00.000Z', source: 'synthetic', hudVersion: 'test',
      gameVersion: 'synthetic', bridgeVersion: 'synthetic', browser: 'synthetic',
      pollMs: 16, limits: { ...DEFAULT_CAPTURE_LIMITS } },
    ...events,
    { kind: 'footer', complete: true, reason: 'stopped', eventCount: events.length,
      lastSeq: events.length, durationMs: 400, queueHighWaterBytes: 0, lossCount: 0 },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const before = structuredClone(document);
  const report = replayCapture(document);
  assert.deepEqual(report.observedCrossings.map(row => row.completedLap), [1]);
  assert.deepEqual(report.acceptedLaps.map(row => row.totalUs), [1_000_000]);
  assert.deepEqual(report.shadowProposals.map(row => row.totalUs), [1_000_000]);
  assert.deepEqual(report.controlProposals, []);
  assert.equal(report.liveWritesEnabled, false);
  assert.equal(report.profileValidated, false);
  assert.doesNotMatch(report.issues.join('\n'), /version|expected 3\.6/i);
  const analysis = analyzeCapture(document);
  assert.equal(analysis.reportedLaps.length, 1);
  assert.equal(analysis.reportedLaps[0].totalUs, 1_000_000);
  const receipt = analysis.reportedLaps[0].observations.find(row => row.seq === 6);
  assert.ok(receipt, 'Keep the actual crossing receipt');
  assert.deepEqual(receipt.fields.VersionMajor, { present: true, value: 3 });
  assert.deepEqual(receipt.fields.VersionMinor, { present: true, value: 77 });
  assert.deepEqual(document, before, 'Replay and analysis must not rewrite source metadata');
});

test('captured 2.8 replay processes usable crossings while automatic analysis retains six crossings and two native totals', async () => {
  const text = await readFile(new URL('./fixtures/lap-count-windows/capture.jsonl', import.meta.url), 'utf8');
  const document = parseCapture(text, { allowIncomplete: true });
  const before = structuredClone(document);
  const report = replayCapture(document);
  assert.deepEqual(report.observedCrossings.map(row => [row.seq, row.completedLap]), [[9, 3], [12, 4]]);
  assert.doesNotMatch(report.issues.join('\n'), /unsupported.*version|expected 3\.6/i);
  assert.equal(report.liveWritesEnabled, false);
  assert.equal(report.profileValidated, false);
  assert.deepEqual(report.shadowProposals, [], 'The excerpt does not supply complete laps');
  const analysis = analyzeCapture(document);
  assert.deepEqual(analysis.reportedLaps.map(row => [row.completedLap, row.totalUs]),
    [[1, null], [2, null], [3, 149_494_965], [4, 149_835_876], [5, null], [6, null]]);
  for (const lap of analysis.reportedLaps) {
    const receipt = lap.observations.find(row => row.seq === lap.seq);
    assert.ok(receipt);
    assert.deepEqual(receipt.fields.VersionMajor, { present: true, value: 2 });
    assert.deepEqual(receipt.fields.VersionMinor, { present: true, value: 8 });
  }
  assert.deepEqual(document, before);
});
