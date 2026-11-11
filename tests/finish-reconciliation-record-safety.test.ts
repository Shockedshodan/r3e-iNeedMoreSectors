import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CAPTURE_LIMITS, parseCapture, projectRawTelemetry } from '../src/diagnostics/capture-format.ts';
import { replayCapture } from '../src/diagnostics/replay.ts';
import { lapFrames, previousResult, rawFrame } from './fixtures/browser-bridge.ts';
import type { RawRaceRoomFrame } from './fixtures/browser-bridge.ts';

// These are explicitly synthetic offline shadow traces, not independent game
// labels or authorization to save live records. The first lap establishes saved
// Best/Opt references before the disputed second finish arrives.
function replaySecondFinish(results: readonly Partial<RawRaceRoomFrame>[], previousSeconds = 1) {
  const first = lapFrames(0);
  const second = lapFrames(1, 0.9, previousSeconds).slice(1, -1);
  const finish = rawFrame({
    ...previousResult(0.9), CompletedLaps: 2,
    Player: { GameSimulationTime: 14 },
  });
  const packets = [...first, ...second, ...results.map((result, index) => ({
    ...finish, ...result,
    LapDistanceFraction: index * 0.01,
    LapTimeCurrentSelf: index * 0.01,
    Player: { GameSimulationTime: 14 + index * 0.01 },
  }))];
  const events = [
    { kind: 'event', type: 'open', seq: 1, tMs: 0, connectionId: 1 },
    ...packets.map((data, index) => ({
      kind: 'event', type: 'message', seq: index + 2,
      tMs: index * 25, connectionId: 1, data: projectRawTelemetry(data),
    })),
  ];
  return replayCapture(parseCapture([
    { kind: 'header', version: 1, captureId: 'synthetic-finish-record-safety',
      startedAt: '2026-11-11T00:00:00.000Z', source: 'synthetic',
      hudVersion: 'test', gameVersion: 'synthetic', bridgeVersion: 'synthetic',
      browser: 'synthetic', pollMs: 25, limits: { ...DEFAULT_CAPTURE_LIMITS } },
    ...events,
    { kind: 'footer', complete: true, reason: 'stopped',
      eventCount: events.length, lastSeq: events.length,
      durationMs: (packets.length - 1) * 25, queueHighWaterBytes: 0, lossCount: 0 },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'));
}

function assertUninterruptedFixtureAcceptsOnce() {
  const report = replaySecondFinish([previousResult(0.9), previousResult(0.9)]);
  assert.equal(report.complete, true);
  assert.deepEqual(report.observedCrossings.map(row => row.completedLap), [1, 2]);
  assert.deepEqual(report.acceptedLaps.map(row => [row.completedLap, row.totalUs]),
    [[1, 1_000_000], [2, 900_000]]);
  assert.deepEqual(report.shadowProposals.map(row => row.completedLap), [1, 2]);
  assert.equal(report.records[0].best!.totalUs, 900_000);
  assert.equal(report.records[0].opt!.totalUs, 900_000);
  assert.deepEqual(report.controlProposals, []);
  assert.equal(report.liveWritesEnabled, false);
  assert.equal(report.profileValidated, false);
}

function assertOnlySeedLapImproves(report: ReturnType<typeof replayCapture>, rejectionPatterns: readonly RegExp[]) {
  assert.equal(report.complete, true);
  assert.deepEqual(report.observedCrossings.map(row => row.completedLap), [1, 2]);
  assert.deepEqual(report.acceptedLaps.filter(row => row.completedLap === 1)
    .map(row => row.totalUs), [1_000_000], 'The trace must establish a complete seed lap');
  const diagnostic = report.unresolved.find(row => row.annotation.completedLap === 2);
  assert.ok(diagnostic, 'Keep the disputed second finish visible in the replay report');
  for (const pattern of rejectionPatterns) {
    assert.match(diagnostic.reason, pattern,
      'Explain the disputed fields; a generic recording status or missing-label message is insufficient');
  }
  assert.deepEqual(report.shadowProposals.map(row => row.completedLap), [1],
    'An ambiguous or invalid second finish must not improve Best or Opt');
  assert.deepEqual(report.acceptedLaps.map(row => row.completedLap), [1]);
  assert.equal(report.records[0].best!.totalUs, 1_000_000);
  assert.equal(report.records[0].opt!.totalUs, 1_000_000);
  assert.deepEqual(report.controlProposals, []);
  assert.equal(report.liveWritesEnabled, false);
  assert.equal(report.profileValidated, false);
}

test('repeated new totals mixed with stale native sector clocks cannot improve saved references', () => {
  assertUninterruptedFixtureAcceptsOnce();
  // The previous lap's first and second cumulative clocks remain unchanged;
  // only the total and third clock have arrived for the next result. Repeating
  // that mathematically consistent mixture is not evidence of atomic finality.
  const mixed = { ...previousResult(0.9),
    SectorTimesPreviousSelf: { Sector1: 0.3, Sector2: 0.6, Sector3: 0.9 } };
  assertOnlySeedLapImproves(replaySecondFinish(Array.from({ length: 12 }, () => mixed)),
    [/mixed|stale|unchanged/i, /sector/i]);
});

test('zeroed previous-result clocks followed by unchanged restoration cannot improve saved references', () => {
  assertUninterruptedFixtureAcceptsOnce();
  // Keep the accepted seed result in history while the next lap reports zeros.
  // Restoring that same result at the next crossing is not a fresh finish.
  const report = replaySecondFinish(Array.from({ length: 12 }, () => previousResult(1)), 0);
  assert.deepEqual(report.shadowResults.map(row => row.completedLap), [1],
    'Restoring unchanged clocks must not authorize a second result');
  assertOnlySeedLapImproves(report, [/unchanged|stale|ambiguous/i]);
});

test('invalidity received with partially updated finish clocks cannot be undone by a later valid flag', () => {
  assertUninterruptedFixtureAcceptsOnce();
  // The new total and invalid flag arrive before the third cumulative clock.
  // Once that clock catches up, a valid flag must not resurrect the disputed
  // finish. Both receipts are only 25 ms apart, inside the 500 ms timeout.
  assertOnlySeedLapImproves(replaySecondFinish([
    { ...previousResult(0.9), PrevLapValid: 0,
      SectorTimesPreviousSelf: { Sector1: 0.27, Sector2: 0.54, Sector3: 1 } },
    previousResult(0.9),
    previousResult(0.9),
  ]), [/invalid/i, /inconsistent|partial|clock|sector/i]);
});
