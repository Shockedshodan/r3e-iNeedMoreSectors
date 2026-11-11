import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseCapture } from '../src/diagnostics/capture-format.ts';
import { replayCapture } from '../src/diagnostics/replay.ts';
import { createRaceRoomAdapter } from '../src/telemetry/raceroom-adapter.ts';
import { previousResult, rawFrame } from './fixtures/browser-bridge.ts';

test('real capture excerpts explain why a reported finish cannot become a complete lap record', async () => {
  const bytes = await readFile(new URL('./fixtures/lap-count-windows/capture.jsonl', import.meta.url));
  const provenance = JSON.parse(await readFile(
    new URL('./fixtures/lap-count-windows/provenance.json', import.meta.url), 'utf8'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.fixtureSha256);
  assert.deepEqual(provenance.independentValidityLabels, []);
  // This existing real excerpt intentionally retains loss markers. It can
  // verify a rejection explanation, never full-lap acceptance or final validity.
  const document = parseCapture(bytes.toString('utf8'), { allowIncomplete: true });
  const before = structuredClone(document);
  assert.ok(document.events.some(event => event.type === 'loss'));
  const report = replayCapture(document);
  assert.equal(report.complete, false);
  assert.equal(report.infrastructureEligible, false);
  const crossing = document.events.find(event => event.seq === 9);
  assert.ok(crossing?.data, 'The verified raw receipt supplies the lap-3 reported finish');
  assert.equal(crossing.data.CompletedLaps, 3);
  assert.equal(crossing.data.LapTimePreviousSelf, 149.494965);
  assert.equal(provenance.observations.find((row: { fixtureSeq: number }) => row.fixtureSeq === crossing.seq).sourceSeq, 28104);
  const associated = report.shadowResults.filter(row => row.completedLap === 3);
  assert.ok(associated.length <= 1, 'Conservative rejection may authorize no result');
  for (const result of associated) {
    const emittedAt = document.events.find(event => event.seq === result.seq);
    assert.ok(emittedAt?.data, 'An emitted result must identify an actual retained message receipt');
    assert.equal(emittedAt.type, 'message');
    assert.ok(result.seq >= crossing.seq, 'Association may be delayed, but must not precede the raw crossing');
    assert.equal(document.events.filter(event => event.seq > crossing.seq && event.seq <= result.seq
      && ['loss', 'open', 'close', 'error', 'malformed'].includes(event.type)).length, 0,
    'A delayed association must not cross an interruption');
    assert.equal(result.atMs, emittedAt.tMs);
    assert.equal(result.connectionId, emittedAt.connectionId);
    assert.equal(result.connectionId, crossing.connectionId);
    assert.equal(emittedAt.data.CompletedLaps, result.completedLap);
    assert.equal(result.layoutId, 13256);
    assert.equal(result.modelId, 13398);
    assert.equal(emittedAt.data.LayoutId, result.layoutId);
    assert.deepEqual(emittedAt.data.VehicleInfo, { ModelId: result.modelId });
    assert.equal(result.totalUs, 149_494_965);
    assert.equal(Math.round(Number(emittedAt.data.LapTimePreviousSelf) * 1_000_000), result.totalUs);
    assert.equal(emittedAt.data.PrevLapValid, 1);
    assert.deepEqual(emittedAt.data.SectorTimesPreviousSelf, crossing.data.SectorTimesPreviousSelf);
    const context: (typeof report.observedCrossings)[number] | undefined = report.observedCrossings.find(row =>
      row.seq === crossing.seq && row.completedLap === result.completedLap && row.connectionId === result.connectionId);
    assert.ok(context, 'Tie the associated result to its observed crossing context');
    assert.equal(result.sessionId, context.sessionId);
    assert.equal(result.engineAccepted, false);
  }
  assert.deepEqual(report.acceptedLaps, []);
  assert.deepEqual(report.shadowProposals, []);
  assert.ok(report.records.every(record => record.best === null && record.opt === null));
  assert.equal(report.liveWritesEnabled, false);
  assert.equal(report.profileValidated, false);
  assert.deepEqual(document, before);
  const diagnostic = report.unresolved.find(row => row.annotation.completedLap === 3);
  assert.ok(diagnostic, 'The rejected candidate must remain visible to the operator');
  assert.match(diagnostic.reason,
    /incomplete|partial|interrupt|continuity|loss|missing.*capture|capture.*missing|no.*capture/i,
    'Explain the absent complete capture, rather than only saying there is no independent label');
});

test('an unchanged native finish signature is diagnosed as stale or ambiguous after repeated observations', () => {
  let now = 0;
  const adapter = createRaceRoomAdapter({ enableRecordWrites: true,
    nowMs: () => now, finishTimeoutMs: 500 });
  const old = previousResult(1);
  const before = adapter.adapt(rawFrame({ ...old,
    LapDistanceFraction: 0.75, LapTimeCurrentSelf: 0.675 }));
  assert.ok(before);
  for (let index = 0; index < 12; index += 1) {
    now = 25 + index * 25;
    const observation = adapter.adapt(rawFrame({ ...old, CompletedLaps: 1,
      LapDistanceFraction: index * 0.01, LapTimeCurrentSelf: index * 0.01 }));
    assert.ok(observation, 'Ambiguous results must not stop current-lap display telemetry');
    assert.equal(observation.frame.sessionId, before.frame.sessionId);
    assert.equal(observation.frame.completedLaps, 1);
    assert.equal(observation.frame.finishResult, null,
      'Stable samples and count progression must not manufacture result freshness');
  }
  assert.match(adapter.status(), /unchanged|stale|ambiguous/i,
    'Expose why the pending finish cannot be associated, even while recording is enabled for a fixture');
});
