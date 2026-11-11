import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimingEngine } from '../src/timing-engine.ts';
import type {
  FinishResult, RecordBook, RecordUpdate, TimingEngine, TimingEngineOptions,
  TimingFrame,
} from '../src/contracts.ts';
import { book, completeLapFrames, deepFreeze, definition, frame, result } from './helpers.ts';

// These limits and frames are synthetic engine contracts, not measured R3E limits.
// FinishResult already carries an association proven by a future bridge adapter.
function setup(initialRecords: RecordBook = book()) {
  const improvements: RecordUpdate[] = [];
  const options: TimingEngineOptions = {
    definition,
    initialRecords,
    maxFrameGapMs: 300,
    maxDistanceStep: 0.3,
    finishTimeoutMs: 500,
    onImprovement: update => improvements.push(update),
  };
  return { engine: createTimingEngine(options), improvements };
}

function consume(engine: TimingEngine, frames: readonly TimingFrame[]): void {
  for (const item of frames) engine.consume(item);
}

function nextLapFrame(observedAtMs: number, overrides: Partial<TimingFrame> = {}): TimingFrame {
  const elapsedMs = observedAtMs - 1000;
  return frame({
    observedAtMs,
    completedLaps: 1,
    distanceFraction: elapsedMs / 1000,
    lapElapsedUs: elapsedMs * 1000,
    ...overrides,
  });
}

test('a complete valid capture commits once and derives custom sectors independently of native sectors', () => {
  const { engine, improvements } = setup();
  consume(engine, completeLapFrames());

  assert.equal(improvements.length, 1);
  assert.equal(improvements[0].bestChanged, true);
  assert.equal(improvements[0].optChanged, true);
  const records = engine.records();
  assert.equal(records.best?.totalUs, 1_000_000);
  assert.equal(records.opt?.totalUs, 1_000_000);
  assert.deepEqual(records.best?.sectors.map(sector => sector.durationUs), [500_000, 500_000]);
  assert.deepEqual(records.opt?.sectors.map(sector => sector.durationUs), [500_000, 500_000]);
  for (const reference of [records.best, records.opt]) {
    assert.ok(reference);
    for (const sector of reference.sectors) {
      assert.equal(sector.curve.length, 129, 'capture stores the bounded 128-interval grid');
      assert.deepEqual(sector.curve[0], { fraction: 0, elapsedUs: 0 });
      assert.deepEqual(sector.curve.at(-1), { fraction: 1, elapsedUs: sector.durationUs });
    }
  }
  assert.equal(engine.pendingFinishCount(), 0);
});

test('a crossing without an associated finish result leaves records untouched until reconciliation', () => {
  const { engine, improvements } = setup();
  consume(engine, completeLapFrames(null));
  assert.deepEqual(engine.records(), book());
  assert.equal(improvements.length, 0);
  assert.equal(engine.pendingFinishCount(), 1);

  engine.consume(nextLapFrame(1250, { finishResult: result() }));
  assert.equal(improvements.length, 1);
  assert.equal(engine.records().best?.totalUs, 1_000_000);
  assert.equal(engine.pendingFinishCount(), 0);
});

test('a changed associated result without lap-count progression and wrap does not finish a capture', () => {
  const { engine, improvements } = setup();
  consume(engine, completeLapFrames(null).slice(0, -1));
  engine.consume(frame({
    observedAtMs: 800, distanceFraction: 0.8, lapElapsedUs: 800_000,
    finishResult: result({ totalUs: 999_000, officialSectorDurationsUs: [300_000, 300_000, 399_000] }),
  }));
  assert.equal(improvements.length, 0);
  assert.deepEqual(engine.records(), book());
  assert.equal(engine.pendingFinishCount(), 0);
});

test('equal consecutive totals still reconcile a real lap and may improve Opt while preserving Best', () => {
  const seed = deepFreeze(book([500_000, 500_000]));
  const { engine, improvements } = setup(seed);
  consume(engine, [
    frame(),
    frame({ observedAtMs: 200, distanceFraction: 0.25, lapElapsedUs: 200_000 }),
    frame({ observedAtMs: 400, distanceFraction: 0.5, lapElapsedUs: 400_000 }),
    frame({ observedAtMs: 700, distanceFraction: 0.75, lapElapsedUs: 700_000 }),
    frame({ observedAtMs: 1000, completedLaps: 1, finishResult: result() }),
  ]);
  assert.equal(improvements.length, 1);
  assert.equal(improvements[0].bestChanged, false);
  assert.equal(improvements[0].optChanged, true);
  assert.deepEqual(engine.records().best, seed.best);
  assert.deepEqual(engine.records().opt?.sectors.map(sector => sector.durationUs), [400_000, 500_000]);
  assert.equal(engine.records().opt?.totalUs, 900_000);
  assert.equal(engine.pendingFinishCount(), 0);
});

test('repeated frames and repeated finish results never duplicate improvement callbacks', () => {
  const { engine, improvements } = setup();
  const lapFrames = completeLapFrames();
  consume(engine, lapFrames);
  engine.consume(lapFrames.at(-1)!);
  engine.consume(nextLapFrame(1250, { finishResult: result() }));
  engine.consume(nextLapFrame(1500, { finishResult: result() }));
  assert.equal(improvements.length, 1);
  assert.equal(engine.pendingFinishCount(), 0);
});

test('joining telemetry mid-lap cannot produce a complete lap record', () => {
  const { engine, improvements } = setup();
  consume(engine, completeLapFrames().slice(1));
  assert.equal(improvements.length, 0);
  assert.deepEqual(engine.records(), book());
});

test('current-lap invalidity remains latched after valid telemetry resumes', () => {
  const { engine, improvements } = setup();
  const frames = completeLapFrames();
  frames[1] = { ...frames[1], currentLapValid: false };
  consume(engine, frames);
  assert.equal(improvements.length, 0);
  assert.deepEqual(engine.records(), book());
});

test('unavailable current-lap validity cannot silently become a valid capture', () => {
  const { engine, improvements } = setup();
  const frames = completeLapFrames();
  frames[2] = { ...frames[2], currentLapValid: null };
  consume(engine, frames);
  assert.equal(improvements.length, 0);
  assert.deepEqual(engine.records(), book());
});

for (const valid of [false, null] as const) {
  test(`final validity ${String(valid)} rejects an otherwise complete capture`, () => {
    const { engine, improvements } = setup();
    consume(engine, completeLapFrames(result({ valid })));
    assert.equal(improvements.length, 0);
    assert.deepEqual(engine.records(), book());
  });
}

test('a result with another session, layout, model or lap identity cannot reconcile the pending lap', () => {
  const mismatches: Partial<FinishResult>[] = [
    { sessionId: 'another-session' }, { layoutId: 11 }, { modelId: 21 }, { completedLap: 0 },
  ];
  for (const mismatch of mismatches) {
    const { engine, improvements } = setup();
    consume(engine, completeLapFrames(null));
    engine.consume(nextLapFrame(1250, { finishResult: result(mismatch) }));
    assert.equal(improvements.length, 0, JSON.stringify(mismatch));
    assert.deepEqual(engine.records(), book());
    assert.equal(engine.pendingFinishCount(), 1);
    engine.consume(nextLapFrame(1500, { finishResult: result() }));
    assert.equal(improvements.length, 1, 'a later matching result still reconciles before timeout');
  }
});

test('completion requires coherent lap-count, distance and clock progression', () => {
  const badCrossings: Partial<TimingFrame>[] = [
    { completedLaps: 0 },
    { completedLaps: 2 },
    { distanceFraction: 0.8 },
    { lapElapsedUs: 1_000_000 },
  ];
  for (const badCrossing of badCrossings) {
    const { engine, improvements } = setup();
    const frames = completeLapFrames();
    frames[4] = { ...frames[4], ...badCrossing };
    consume(engine, frames);
    assert.equal(improvements.length, 0, JSON.stringify(badCrossing));
    assert.deepEqual(engine.records(), book());
  }
});

test('a frame gap above the configured continuity limit discards the capture', () => {
  const { engine, improvements } = setup();
  const frames = completeLapFrames();
  frames[1] = { ...frames[1], observedAtMs: 301 };
  consume(engine, frames);
  assert.equal(improvements.length, 0);
  assert.deepEqual(engine.records(), book());
});

test('a distance step above the configured continuity limit discards the capture', () => {
  const { engine, improvements } = setup();
  const frames = completeLapFrames();
  frames[1] = { ...frames[1], distanceFraction: 0.301 };
  consume(engine, frames);
  assert.equal(improvements.length, 0);
  assert.deepEqual(engine.records(), book());
});

test('frame-gap and distance-step limits are inclusive', () => {
  const { engine, improvements } = setup();
  consume(engine, [
    frame(),
    frame({ observedAtMs: 300, distanceFraction: 0.3, lapElapsedUs: 300_000 }),
    frame({ observedAtMs: 600, distanceFraction: 0.6, lapElapsedUs: 600_000 }),
    frame({ observedAtMs: 900, distanceFraction: 0.9, lapElapsedUs: 900_000 }),
    frame({ observedAtMs: 1000, completedLaps: 1, finishResult: result() }),
  ]);
  assert.equal(improvements.length, 1);
  assert.equal(engine.records().best?.totalUs, 1_000_000);
});

test('debug, AI, remote, replay, paused and menu frames interrupt capture even when live play resumes', () => {
  const interruptions: Partial<TimingFrame>[] = [
    { source: 'debug' }, { control: 'ai' }, { control: 'remote' },
    { replay: true }, { paused: true }, { inMenus: true },
  ];
  for (const interruption of interruptions) {
    const { engine, improvements } = setup();
    const frames = completeLapFrames();
    frames[2] = { ...frames[2], ...interruption };
    consume(engine, frames);
    assert.equal(improvements.length, 0, JSON.stringify(interruption));
    assert.deepEqual(engine.records(), book());
  }
});

test('a matching finish result on prohibited telemetry cannot reconcile or resurrect a pending capture', () => {
  const interruptions: Partial<TimingFrame>[] = [
    { source: 'debug' }, { control: 'ai' }, { control: 'remote' },
    { replay: true }, { paused: true }, { inMenus: true },
  ];
  for (const interruption of interruptions) {
    const { engine, improvements } = setup();
    consume(engine, completeLapFrames(null));
    engine.consume(nextLapFrame(1250, { ...interruption, finishResult: result() }));
    assert.equal(improvements.length, 0, JSON.stringify(interruption));
    assert.equal(engine.pendingFinishCount(), 0, 'an interruption discards the pending capture');
    engine.consume(nextLapFrame(1500, { finishResult: result() }));
    assert.equal(improvements.length, 0, 'later valid data cannot resurrect it');
    assert.deepEqual(engine.records(), book());
  }
});

test('identity changes discard pending captures without writing records into the old combination', () => {
  const changes: Partial<TimingFrame>[] = [
    { sessionId: 'practice-2' }, { layoutId: 11 }, { modelId: 21 },
  ];
  for (const change of changes) {
    const seed = deepFreeze(book([600_000, 600_000]));
    const { engine, improvements } = setup(seed);
    consume(engine, completeLapFrames(null));
    engine.consume(nextLapFrame(1250, { ...change, finishResult: result() }));
    assert.equal(improvements.length, 0, JSON.stringify(change));
    assert.deepEqual(engine.records(), seed);
    assert.equal(engine.pendingFinishCount(), 0);
  }
});

test('the next capture continues while the previous lap awaits reconciliation', () => {
  const { engine, improvements } = setup();
  consume(engine, completeLapFrames(null));
  engine.consume(nextLapFrame(1250, { finishResult: result() }));
  engine.consume(nextLapFrame(1500));
  engine.consume(nextLapFrame(1750));
  engine.consume(frame({ observedAtMs: 2000, completedLaps: 2 }));
  assert.equal(improvements.length, 1);
  assert.equal(engine.pendingFinishCount(), 1, 'the second complete capture is awaiting its own result');
  engine.consume(frame({
    observedAtMs: 2250, completedLaps: 2, distanceFraction: 0.25, lapElapsedUs: 250_000,
    finishResult: result({ completedLap: 2 }),
  }));
  assert.equal(engine.pendingFinishCount(), 0);
  assert.equal(improvements.length, 1, 'a tied second lap has no record improvement');
});

test('reconciliation improves records without changing either reference in the active-lap snapshot', () => {
  const seed = deepFreeze(book([600_000, 600_000]));
  const { engine } = setup(seed);
  consume(engine, completeLapFrames(null));
  assert.deepEqual(engine.comparisonSnapshot(), seed);
  engine.consume(nextLapFrame(1250, { finishResult: result() }));
  assert.equal(engine.records().best?.totalUs, 1_000_000);
  assert.equal(engine.records().opt?.totalUs, 1_000_000);
  assert.deepEqual(engine.comparisonSnapshot(), seed);

  engine.consume(nextLapFrame(1500));
  engine.consume(nextLapFrame(1750));
  engine.consume(frame({ observedAtMs: 2000, completedLaps: 2 }));
  assert.equal(engine.comparisonSnapshot().best?.totalUs, 1_000_000);
  assert.equal(engine.comparisonSnapshot().opt?.totalUs, 1_000_000);
});

test('a matching result at the finish-timeout boundary is accepted', () => {
  const { engine, improvements } = setup();
  consume(engine, completeLapFrames(null));
  engine.consume(nextLapFrame(1250));
  engine.consume(nextLapFrame(1500, { finishResult: result() }));
  assert.equal(improvements.length, 1);
  assert.equal(engine.pendingFinishCount(), 0);
});

test('a result beyond the finish timeout cannot resurrect the discarded capture', () => {
  const { engine, improvements } = setup();
  consume(engine, completeLapFrames(null));
  engine.consume(nextLapFrame(1250));
  engine.consume(nextLapFrame(1500));
  engine.consume(nextLapFrame(1501, { finishResult: result() }));
  assert.equal(improvements.length, 0);
  assert.deepEqual(engine.records(), book());
  assert.equal(engine.pendingFinishCount(), 0);
});

test('pending finishes remain bounded while missing results time out across multiple laps', () => {
  const { engine, improvements } = setup();
  consume(engine, completeLapFrames(null));
  engine.consume(nextLapFrame(1250));
  engine.consume(nextLapFrame(1500));
  assert.equal(engine.pendingFinishCount(), 1, 'timeout boundary is inclusive');
  engine.consume(nextLapFrame(1750));
  assert.equal(engine.pendingFinishCount(), 0, 'expired finish is cleared before the next crossing');
  for (const item of [
    frame({ observedAtMs: 2000, completedLaps: 2 }),
    frame({ observedAtMs: 2250, completedLaps: 2, distanceFraction: 0.25, lapElapsedUs: 250_000 }),
  ]) {
    engine.consume(item);
    assert.ok(engine.pendingFinishCount() <= 1);
  }
  assert.equal(engine.pendingFinishCount(), 1);
  assert.equal(improvements.length, 0);
  assert.deepEqual(engine.records(), book());
});

test('malformed official timing data cannot authorize a record', () => {
  const malformed: Partial<FinishResult>[] = [
    { totalUs: Number.NaN },
    { totalUs: Number.POSITIVE_INFINITY },
    { totalUs: -1 },
    { officialSectorDurationsUs: [300_000, 300_000, 399_999] },
    { officialSectorDurationsUs: [300_000, -1, 700_001] },
    { officialSectorDurationsUs: [300_000, Number.NaN, 700_000] },
  ];
  for (const invalidTiming of malformed) {
    const { engine, improvements } = setup();
    consume(engine, completeLapFrames(result(invalidTiming)));
    assert.equal(improvements.length, 0, String(invalidTiming.totalUs));
    assert.deepEqual(engine.records(), book());
  }
});

test('backward clock or distance movement within a lap discards capture', () => {
  const regressions: Partial<TimingFrame>[] = [
    { distanceFraction: 0.2 }, { lapElapsedUs: 200_000 }, { observedAtMs: 200 },
  ];
  for (const regression of regressions) {
    const { engine, improvements } = setup();
    const frames = completeLapFrames();
    frames[2] = { ...frames[2], ...regression };
    if (regression.observedAtMs !== undefined) {
      // Keep later positive gaps within the limit: only the backward timestamp
      // should break continuity, rather than an incidental later oversized gap.
      frames[3] = { ...frames[3], observedAtMs: 450 };
      frames[4] = { ...frames[4], observedAtMs: 700 };
    }
    if (regression.distanceFraction !== undefined) {
      // Recover in small positive steps so no later distance jump obscures the
      // original backwards-distance violation.
      frames.splice(3, 1,
        frame({ observedAtMs: 750, distanceFraction: 0.45, lapElapsedUs: 750_000 }),
        frame({ observedAtMs: 875, distanceFraction: 0.7, lapElapsedUs: 875_000 }),
      );
    }
    consume(engine, frames);
    assert.equal(improvements.length, 0, JSON.stringify(regression));
    assert.deepEqual(engine.records(), book());
  }
});

test('disposing the engine stops capture and reconciliation callbacks', () => {
  const { engine, improvements } = setup();
  consume(engine, completeLapFrames(null));
  engine.dispose();
  engine.consume(nextLapFrame(1250, { finishResult: result() }));
  assert.equal(improvements.length, 0);
  assert.deepEqual(engine.records(), book());
  assert.equal(engine.pendingFinishCount(), 0);
});
