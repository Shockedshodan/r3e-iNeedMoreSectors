import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readCaptureFile } from '../../scripts/replay-capture.ts';
import { replayCapture } from '../../src/diagnostics/replay.ts';
import type { ReplayReport } from '../../src/diagnostics/replay.ts';

// Like the existing full-capture acceptance check, this requires the original
// recording, not the sparse excerpt. Every original preceding receipt reaches
// the public replay API and therefore the adapter and engine with default limits.
async function loadContinuousReplay() {
  const input = process.env.R3E_FULL_CAPTURE;
  assert.ok(input, 'Set R3E_FULL_CAPTURE to the original full capture directory');
  const provenance = JSON.parse(await readFile(
    new URL('../fixtures/finish-reconciliation-provenance.json', import.meta.url), 'utf8'));
  const bytes = await readFile(join(input, 'capture.jsonl'));
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest, '67e59c0b3f83e05e4d0d1989fef1507bc83342788799cc40ea87ea3ba32cb88b');
  assert.equal(digest, provenance.sourceSha256);
  assert.equal(bytes.length, provenance.sourceByteCount);
  const { document, manifestVerified } = await readCaptureFile(input);
  assert.equal(manifestVerified, true);
  assert.equal(document.complete, true);
  assert.equal(document.header.captureId, provenance.sourceCaptureId);
  assert.equal(document.events.length, provenance.sourceEventCount);
  assert.deepEqual(provenance.independentValidityLabels, []);
  assert.equal(document.events[0].type, 'open');
  assert.equal(document.events.filter(row => row.type === 'loss' || row.type === 'annotation').length, 0);
  document.events.forEach((event, index) => {
    assert.equal(event.seq, index + 1, 'Retain every original event, without sequence compaction');
  });
  const before = createHash('sha256').update(JSON.stringify(document)).digest('hex');
  const report = replayCapture(document);
  assert.equal(createHash('sha256').update(JSON.stringify(document)).digest('hex'), before);
  assert.equal(createHash('sha256').update(await readFile(join(input, 'capture.jsonl'))).digest('hex'), digest);
  assert.equal(report.complete, true);
  assert.equal(report.infrastructureEligible, true);
  assert.deepEqual(report.controlProposals, []);
  assert.equal(report.liveWritesEnabled, false);
  assert.equal(report.profileValidated, false);
  assert.doesNotMatch(report.issues.join('\n'), /unsupported.*version|expected 3\.6/i);
  function receipt(seq: number) {
    const event = document.events[seq - 1];
    assert.ok(event, 'Reported receipt must exist in the verified original capture');
    assert.equal(event.seq, seq);
    assert.equal(event.type, 'message');
    assert.equal(event.connectionId, 1);
    assert.ok(event.data);
    assert.equal(event.data.VersionMajor, 2);
    assert.equal(event.data.VersionMinor, 8);
    return event as typeof event & { data: NonNullable<typeof event.data> };
  }
  function assertResultReceipt(result: ReplayReport['acceptedLaps'][number], crossingSeq: number, totalUs: number) {
    const crossing = receipt(crossingSeq);
    const emittedAt = receipt(result.seq);
    assert.ok(result.seq >= crossingSeq, 'Association may be delayed, but must not precede the raw crossing');
    assert.equal(result.atMs, emittedAt.tMs, 'Use the actual emission receipt timestamp');
    assert.equal(result.connectionId, emittedAt.connectionId);
    assert.equal(result.completedLap, crossing.data.CompletedLaps);
    assert.equal(emittedAt.data.CompletedLaps, result.completedLap, 'Do not borrow a later lap receipt');
    assert.equal(result.layoutId, 13256);
    assert.equal(result.modelId, 13398);
    assert.equal(emittedAt.data.LayoutId, result.layoutId);
    assert.deepEqual(emittedAt.data.VehicleInfo, { ModelId: result.modelId });
    assert.equal(result.totalUs, totalUs);
    assert.equal(Math.round(Number(emittedAt.data.LapTimePreviousSelf) * 1_000_000), result.totalUs);
    assert.equal(emittedAt.data.PrevLapValid, 1);
    assert.deepEqual(emittedAt.data.SectorTimesPreviousSelf, crossing.data.SectorTimesPreviousSelf);
    const context = report.observedCrossings.find(row => row.seq === crossingSeq
      && row.completedLap === result.completedLap && row.connectionId === result.connectionId);
    assert.ok(context, 'Tie the emitted result to its observed crossing context');
    assert.equal(result.sessionId, context.sessionId);
  }
  return { provenance, report, receipt, assertResultReceipt };
}

let continuousReplay: ReturnType<typeof loadContinuousReplay> | undefined;
function replayOriginal() {
  return continuousReplay ??= loadContinuousReplay();
}

test('a real distance wrap leading count and clock by 33.3 ms associates once or explains the unsupported ordering', async () => {
  const { provenance, report, receipt, assertResultReceipt } = await replayOriginal();
  const evidence = provenance.leadingDistanceWrap;
  assert.match(evidence.blocker, /staggered.*wrap/i);
  const before = receipt(evidence.beforeSeq);
  const leading = receipt(evidence.distanceWrapSeq);
  const crossing = receipt(evidence.countAndClockSeq);
  assert.equal(before.data.CompletedLaps, 3);
  assert.equal(leading.data.CompletedLaps, 3);
  assert.equal(crossing.data.CompletedLaps, 4);
  assert.ok(Number(before.data.LapDistanceFraction) > 0.99);
  assert.equal(leading.data.LapDistanceFraction, 0.00000153906547);
  assert.ok(Number(leading.data.LapTimeCurrentSelf) > 149);
  assert.equal(crossing.data.LapTimeCurrentSelf, 0.0127563477);
  assert.ok(Math.abs(crossing.tMs - leading.tMs - evidence.leadMs) < 0.001);
  assert.equal(crossing.data.PrevLapValid, 1);
  assert.equal(crossing.data.LapTimePreviousSelf, 149.835876);
  assert.deepEqual(crossing.data.SectorTimesPreviousSelf,
    { Sector1: 41.4022827, Sector2: 111.804688, Sector3: 149.835876 });
  const accepted = report.acceptedLaps.filter(row => row.completedLap === 4);
  const associated = report.shadowResults.filter(row => row.completedLap === 4);
  assert.ok(accepted.length <= 1 && associated.length <= 1, 'Never duplicate the staggered finish');
  assert.ok(report.shadowProposals.filter(row => row.completedLap === 4).length <= 1);
  for (const result of [...accepted, ...associated]) {
    assertResultReceipt(result, evidence.countAndClockSeq, evidence.totalUs);
  }
  if (accepted.length === 0) {
    assert.equal(report.shadowProposals.filter(row => row.completedLap === 4).length, 0);
    const rejection = report.unresolved.find(row => row.annotation.completedLap === 4);
    assert.ok(rejection, 'Keep the rejected raw crossing visible');
    assert.match(rejection.reason, /stagger|leading|distance.*(?:count|clock)|(?:count|clock).*distance/i,
      evidence.blocker);
    assert.match(rejection.reason, /unsupported|unverified|unresolved|cannot|reject|block|not.*establish/i);
  } else {
    assert.equal(associated.length, 1, 'An accepted candidate must have one matching associated result');
  }
});

test('a real resumed nonzero lap clock yields one correctly associated candidate or an explicit incomplete-start rejection', async () => {
  const { provenance, report, receipt, assertResultReceipt } = await replayOriginal();
  const evidence = provenance.recoveringClock;
  assert.match(evidence.blocker, /nonzero.*incomplete/i);
  const unavailable = receipt(evidence.unavailableSeq);
  const resumed = receipt(evidence.resumedSeq);
  const crossing = receipt(evidence.crossingSeq);
  assert.equal(unavailable.data.LapTimeCurrentSelf, -1);
  assert.equal(unavailable.data.LapValidState, 1);
  assert.equal(resumed.data.CompletedLaps, 2);
  assert.equal(resumed.data.LapValidState, 0);
  assert.equal(resumed.data.LapTimeCurrentSelf, 0.00778198242);
  assert.equal(resumed.data.LapDistanceFraction, 0.000210991886);
  assert.equal(crossing.data.CompletedLaps, 3);
  assert.equal(crossing.data.LapTimePreviousSelf, 149.494965);
  assert.equal(crossing.data.PrevLapValid, 1);
  const associated = report.shadowResults.filter(row => row.completedLap === 3);
  assert.ok(associated.length <= 1, 'At most one result may be associated; conservative rejection may authorize none');
  const accepted = report.acceptedLaps.filter(row => row.completedLap === 3);
  assert.ok(accepted.length <= 1);
  assert.ok(report.shadowProposals.filter(row => row.completedLap === 3).length <= 1);
  for (const result of [...associated, ...accepted]) {
    assertResultReceipt(result, evidence.crossingSeq, evidence.totalUs);
  }
  if (accepted.length === 0) {
    assert.equal(report.shadowProposals.filter(row => row.completedLap === 3).length, 0);
    const rejection = report.unresolved.find(row => row.annotation.completedLap === 3);
    assert.ok(rejection);
    assert.match(rejection.reason, /nonzero|non.zero|incomplete.*(?:start|capture)|(?:start|capture).*incomplete/i,
      evidence.blocker);
  } else {
    assert.equal(associated.length, 1, 'An accepted candidate must have one matching associated result');
  }
});

for (const [completedLap, behavior] of [
  [5, 'a real invalid lap stays rejected when the next crossing restores current validity and the lap clock'],
  [6, 'a real current-and-next invalid lap stays rejected through count progression with unavailable clocks'],
] as const) {
  test(behavior, async () => {
    const { provenance, report, receipt } = await replayOriginal();
    const evidence = provenance.invalidClockTransitions.find(
      (transition: { completedLap: number }) => transition.completedLap === completedLap);
    assert.ok(evidence);
    assert.match(evidence.blocker, /invalid.*unavailable.clock/i);
    const before = receipt(evidence.beforeSeq);
    const unavailable = receipt(evidence.unavailableSeq);
    const crossing = receipt(evidence.crossingSeq);
    assert.equal(before.data.LapValidState, 0);
    assert.ok(Number(before.data.LapTimeCurrentSelf) > 0);
    assert.equal(unavailable.data.LapValidState, 1);
    assert.equal(unavailable.data.LapTimeCurrentSelf, -1);
    assert.equal(crossing.data.CompletedLaps, evidence.completedLap);
    assert.equal(crossing.data.PrevLapValid, 0);
    assert.equal(crossing.data.LapTimePreviousSelf, -1);
    assert.deepEqual(crossing.data.SectorTimesPreviousSelf, { Sector1: -1, Sector2: -1, Sector3: -1 });
    if (evidence.completedLap === 5) {
      assert.equal(unavailable.data.PrevLapValid, 1);
      assert.equal(Math.round(Number(unavailable.data.LapTimePreviousSelf) * 1_000_000), evidence.priorValidResultTotalUs);
      assert.equal(crossing.data.LapValidState, 0);
      assert.ok(Number(crossing.data.LapTimeCurrentSelf) > 0);
    } else {
      assert.equal(receipt(evidence.invalidNextSeq).data.LapValidState, 2);
      assert.equal(crossing.data.LapValidState, 1);
      assert.equal(crossing.data.LapTimeCurrentSelf, -1);
    }
    assert.equal(report.acceptedLaps.filter(row => row.completedLap === evidence.completedLap).length, 0);
    assert.equal(report.shadowProposals.filter(row => row.completedLap === evidence.completedLap).length, 0);
    const rejection = report.unresolved.find(row => row.annotation.completedLap === evidence.completedLap);
    assert.ok(rejection, `Retain the raw lap-${evidence.completedLap} crossing despite unavailable clocks: ${evidence.blocker}`);
    assert.equal(rejection.annotation.connectionId, 1);
    assert.equal(rejection.annotation.layoutId, 13256);
    assert.equal(rejection.annotation.modelId, 13398);
    assert.match(rejection.reason, /invalid/i, evidence.blocker);
    assert.match(rejection.reason, /(?:unavailable|missing|interrupted).*(?:clock|timing)|(?:clock|timing).*(?:unavailable|missing|interrupted)/i,
      evidence.blocker);
  });
}
