import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRaceRoomAdapter } from '../src/telemetry/raceroom-adapter.ts';

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    VersionMajor: 3, VersionMinor: 6, LayoutId: 10, LayoutLength: 3000,
    TrackName: 'Test circuit', LayoutName: 'Grand prix', VehicleInfo: { ModelId: 20 },
    SessionType: 0, SessionIteration: 1, EventIndex: 0,
    Player: { GameSimulationTime: 10 }, CompletedLaps: 0,
    LapDistanceFraction: 0, LapTimeCurrentSelf: 0, LapValidState: 0,
    LapTimePreviousSelf: -1, SectorTimesPreviousSelf: { Sector1: -1, Sector2: -1, Sector3: -1 },
    PrevLapValid: -1, ControlType: 0, GameInReplay: 0, GamePaused: 0, GameInMenus: 0,
    ...overrides,
  };
}

// Synthetic API-shaped observations; authorization is only for this fixture.
// A fixed clock keeps the pending finish inside its timeout throughout the test.
function pendingFixtureFinish() {
  const adapter = createRaceRoomAdapter({ enableRecordWrites: true, nowMs: () => 100 });
  const initial = adapter.adapt(raw({ LapDistanceFraction: 0.9, LapTimeCurrentSelf: 9 }));
  assert.ok(initial);
  const crossing = adapter.adapt(raw({ CompletedLaps: 1, LapDistanceFraction: 0.01, LapTimeCurrentSelf: 0.1 }));
  assert.ok(crossing);
  assert.equal(crossing.frame.sessionId, initial.frame.sessionId);
  assert.equal(crossing.frame.finishResult, null);
  const delayed = raw({ CompletedLaps: 1, LapDistanceFraction: 0.02, LapTimeCurrentSelf: 0.2,
    LapTimePreviousSelf: 10, SectorTimesPreviousSelf: { Sector1: 3, Sector2: 6, Sector3: 10 }, PrevLapValid: 1 });
  return { adapter, crossing, delayed };
}

test('pending fixture finish accepts the delayed result without an interruption', () => {
  const { adapter, crossing, delayed } = pendingFixtureFinish();
  const resumed = adapter.adapt(delayed);
  assert.ok(resumed);
  assert.deepEqual(resumed.frame.finishResult, {
    sessionId: crossing.frame.sessionId, layoutId: 10, modelId: 20,
    completedLap: 1, valid: true, totalUs: 10_000_000,
    officialSectorDurationsUs: [3_000_000, 3_000_000, 4_000_000],
  });
});

test('normalizes practice player metadata, distance and seconds without using the game delta', () => {
  const adapter = createRaceRoomAdapter({ nowMs: () => 123 });
  const value = adapter.adapt(raw({ LapTimeCurrentSelf: 1.234567, LapDistanceFraction: 0.125, TimeDeltaBestSelf: -1000 }));
  assert.ok(value);
  assert.equal(value.frame.observedAtMs, 123);
  assert.equal(value.frame.lapElapsedUs, 1_234_567);
  assert.equal(value.frame.distanceFraction, 0.125);
  assert.equal(value.frame.layoutId, 10);
  assert.equal(value.frame.modelId, 20);
  assert.equal(value.layoutLengthM, 3000);
  assert.equal(value.trackName, 'Test circuit');
  assert.equal(value.frame.currentLapValid, true);
  assert.equal(value.frame.finishResult, null);
});

test('default adapter never authorizes record writes even at a coherent fresh finish', () => {
  const adapter = createRaceRoomAdapter();
  adapter.adapt(raw({ LapDistanceFraction: 0.9, LapTimeCurrentSelf: 9 }));
  const value = adapter.adapt(raw({
    CompletedLaps: 1, LapDistanceFraction: 0.01, LapTimeCurrentSelf: 0.1,
    LapTimePreviousSelf: 10, SectorTimesPreviousSelf: { Sector1: 3, Sector2: 6, Sector3: 10 }, PrevLapValid: 1,
  }));
  assert.equal(value?.frame.finishResult, null);
  assert.match(adapter.status(), /unverified|disabled/i);
});

test('opt-in fixture protocol associates a fresh cumulative official result with a coherent crossing', () => {
  const adapter = createRaceRoomAdapter({ enableRecordWrites: true });
  const initial = adapter.adapt(raw({ LapDistanceFraction: 0.9, LapTimeCurrentSelf: 9 }));
  const value = adapter.adapt(raw({
    CompletedLaps: 1, LapDistanceFraction: 0.01, LapTimeCurrentSelf: 0.1,
    LapTimePreviousSelf: 10, SectorTimesPreviousSelf: { Sector1: 3, Sector2: 6, Sector3: 10 }, PrevLapValid: 1,
  }));
  assert.ok(value?.frame.finishResult);
  assert.ok(initial);
  assert.equal(value.frame.finishResult.completedLap, 1);
  assert.equal(value.frame.finishResult.sessionId, initial.frame.sessionId);
  assert.equal(value.frame.finishResult.totalUs, 10_000_000);
  assert.deepEqual(value.frame.finishResult.officialSectorDurationsUs, [3_000_000, 3_000_000, 4_000_000]);
});

test('a delayed result can reconcile once while next-lap telemetry continues', () => {
  let now = 0;
  const adapter = createRaceRoomAdapter({ enableRecordWrites: true, nowMs: () => now });
  adapter.adapt(raw({ LapDistanceFraction: 0.9, LapTimeCurrentSelf: 9 }));
  now = 100;
  assert.equal(adapter.adapt(raw({ CompletedLaps: 1, LapDistanceFraction: 0.01, LapTimeCurrentSelf: 0.1 }))?.frame.finishResult, null);
  now = 200;
  const data = raw({ CompletedLaps: 1, LapDistanceFraction: 0.02, LapTimeCurrentSelf: 0.2,
    LapTimePreviousSelf: 10, SectorTimesPreviousSelf: { Sector1: 3, Sector2: 6, Sector3: 10 }, PrevLapValid: 1 });
  const next = adapter.adapt(data);
  assert.equal(next?.frame.lapElapsedUs, 200_000);
  assert.equal(next?.frame.finishResult?.totalUs, 10_000_000);
  assert.equal(adapter.adapt(data)?.frame.finishResult, null);
});

test('unchanged previous-result signatures cannot establish freshness, even with a lap-count wrap', () => {
  const adapter = createRaceRoomAdapter({ enableRecordWrites: true });
  const old = { LapTimePreviousSelf: 10, SectorTimesPreviousSelf: { Sector1: 3, Sector2: 6, Sector3: 10 }, PrevLapValid: 1 };
  adapter.adapt(raw({ ...old, LapDistanceFraction: 0.9, LapTimeCurrentSelf: 9 }));
  const value = adapter.adapt(raw({ ...old, CompletedLaps: 1, LapDistanceFraction: 0.01, LapTimeCurrentSelf: 0.1 }));
  assert.equal(value?.frame.finishResult, null);
});

test('a result change without a coherent crossing cannot create an association', () => {
  const adapter = createRaceRoomAdapter({ enableRecordWrites: true });
  adapter.adapt(raw({ LapDistanceFraction: 0.5, LapTimeCurrentSelf: 5 }));
  const value = adapter.adapt(raw({ LapDistanceFraction: 0.6, LapTimeCurrentSelf: 6,
    LapTimePreviousSelf: 10, SectorTimesPreviousSelf: { Sector1: 3, Sector2: 6, Sector3: 10 }, PrevLapValid: 1 }));
  assert.equal(value?.frame.finishResult, null);
});

test('unavailable final validity or inconsistent cumulative sectors cannot authorize a record', () => {
  for (const invalid of [
    { PrevLapValid: -1 }, { PrevLapValid: 0 },
    { SectorTimesPreviousSelf: { Sector1: 3, Sector2: 2, Sector3: 10 } },
    { SectorTimesPreviousSelf: { Sector1: 3, Sector2: 6, Sector3: 9 } },
  ]) {
    const adapter = createRaceRoomAdapter({ enableRecordWrites: true });
    adapter.adapt(raw({ LapDistanceFraction: 0.9, LapTimeCurrentSelf: 9 }));
    const value = adapter.adapt(raw({ CompletedLaps: 1, LapDistanceFraction: 0.01, LapTimeCurrentSelf: 0.1,
      LapTimePreviousSelf: 10, SectorTimesPreviousSelf: { Sector1: 3, Sector2: 6, Sector3: 10 }, PrevLapValid: 1, ...invalid }));
    assert.equal(value?.frame.finishResult, null);
  }
});

test('an explicitly invalid fresh finish remains rejected if a later validity flag flips to valid', () => {
  const adapter = createRaceRoomAdapter({ enableRecordWrites: true });
  adapter.adapt(raw({ LapDistanceFraction: 0.9, LapTimeCurrentSelf: 9 }));
  const finish = raw({ CompletedLaps: 1, LapDistanceFraction: 0.01, LapTimeCurrentSelf: 0.1,
    LapTimePreviousSelf: 10, SectorTimesPreviousSelf: { Sector1: 3, Sector2: 6, Sector3: 10 }, PrevLapValid: 0 });
  assert.equal(adapter.adapt(finish)?.frame.finishResult, null);
  assert.equal(adapter.adapt({ ...finish, LapDistanceFraction: 0.02, LapTimeCurrentSelf: 0.2, PrevLapValid: 1 })?.frame.finishResult, null);
});

test('equal total times with newly changed sector splits are fresh without relying on time inequality', () => {
  const adapter = createRaceRoomAdapter({ enableRecordWrites: true });
  adapter.adapt(raw({ LapDistanceFraction: 0.9, LapTimeCurrentSelf: 9,
    LapTimePreviousSelf: 10, SectorTimesPreviousSelf: { Sector1: 3, Sector2: 6, Sector3: 10 }, PrevLapValid: 1 }));
  const value = adapter.adapt(raw({ CompletedLaps: 1, LapDistanceFraction: 0.01, LapTimeCurrentSelf: 0.1,
    LapTimePreviousSelf: 10, SectorTimesPreviousSelf: { Sector1: 2.5, Sector2: 6, Sector3: 10 }, PrevLapValid: 1 }));
  assert.deepEqual(value?.frame.finishResult?.officialSectorDurationsUs, [2_500_000, 3_500_000, 4_000_000]);
});

test('LapValidState=2 latches invalidity for the following lap even if the raw flag later clears', () => {
  const adapter = createRaceRoomAdapter();
  assert.equal(adapter.adapt(raw({ LapValidState: 2 }))?.frame.currentLapValid, false);
  assert.equal(adapter.adapt(raw({ CompletedLaps: 1, LapValidState: 0 }))?.frame.currentLapValid, false);
  assert.equal(adapter.adapt(raw({ CompletedLaps: 2, LapValidState: 0 }))?.frame.currentLapValid, true);
});

test('unavailable validity remains unavailable rather than trusting undocumented CurrentLapValid', () => {
  const adapter = createRaceRoomAdapter();
  assert.equal(adapter.adapt(raw({ LapValidState: -1, CurrentLapValid: 1 }))?.frame.currentLapValid, null);
});

test('debug, replay, AI, remote, paused and menu observations cannot associate pending results', () => {
  for (const interrupt of [{ ControlType: 1 }, { ControlType: 2 }, { GameInReplay: 1 }, { GamePaused: 1 }, { GameInMenus: 1 }, { Debug: true }]) {
    const adapter = createRaceRoomAdapter({ enableRecordWrites: true });
    adapter.adapt(raw({ LapDistanceFraction: 0.9, LapTimeCurrentSelf: 9 }));
    const value = adapter.adapt(raw({ ...interrupt, CompletedLaps: 1, LapDistanceFraction: 0.01, LapTimeCurrentSelf: 0.1,
      LapTimePreviousSelf: 10, SectorTimesPreviousSelf: { Sector1: 3, Sector2: 6, Sector3: 10 }, PrevLapValid: 1 }));
    assert.equal(value?.frame.finishResult, null);
  }
});

test('a new identity, counter rollback or simulation-clock rollback produces a new session identity', () => {
  for (const change of [{ SessionIteration: 2 }, { VehicleInfo: { ModelId: 21 } }, { LayoutId: 11 },
    { CompletedLaps: 0 }, { Player: { GameSimulationTime: 1 } }]) {
    const adapter = createRaceRoomAdapter();
    const first = adapter.adapt(raw({ CompletedLaps: 2 }));
    const second = adapter.adapt(raw({ CompletedLaps: 2, ...change }));
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.frame.sessionId, second.frame.sessionId);
  }
});

for (const [name, change] of [
  ['unsupported session', { SessionType: 2 }], ['missing layout identity', { LayoutId: undefined }],
  ['zero layout length', { LayoutLength: 0 }], ['missing vehicle', { VehicleInfo: null }],
  ['nonfinite distance', { LapDistanceFraction: Number.NaN }], ['unavailable clock', { LapTimeCurrentSelf: -1 }],
  ['unavailable lap count', { CompletedLaps: -1 }],
] as const) {
  test(`rejected ${name} severs pending finish association`, () => {
    const { adapter, crossing, delayed } = pendingFixtureFinish();
    assert.equal(adapter.adapt({ ...delayed, ...change }), null);
    const resumed = adapter.adapt(delayed);
    assert.ok(resumed);
    assert.equal(resumed.frame.finishResult, null, 'delayed result must not resurrect the pending finish');
    assert.notEqual(resumed.frame.sessionId, crossing.frame.sessionId);
    const repeated = adapter.adapt({ ...delayed, LapDistanceFraction: 0.03, LapTimeCurrentSelf: 0.3 });
    assert.ok(repeated);
    assert.equal(repeated.frame.finishResult, null);
  });
}

test('pending result expires before a delayed result arrives', () => {
  let now = 0;
  const adapter = createRaceRoomAdapter({ enableRecordWrites: true, nowMs: () => now, finishTimeoutMs: 500 });
  adapter.adapt(raw({ LapDistanceFraction: 0.9, LapTimeCurrentSelf: 9 }));
  now = 100;
  adapter.adapt(raw({ CompletedLaps: 1, LapDistanceFraction: 0.01, LapTimeCurrentSelf: 0.1 }));
  now = 601;
  const expired = adapter.adapt(raw({ CompletedLaps: 1, LapDistanceFraction: 0.02, LapTimeCurrentSelf: 0.2,
    LapTimePreviousSelf: 10, SectorTimesPreviousSelf: { Sector1: 3, Sector2: 6, Sector3: 10 }, PrevLapValid: 1 }));
  assert.ok(expired);
  assert.equal(expired.frame.finishResult, null);
});

test('explicit reset severs a pending finish before its timeout', () => {
  const { adapter, crossing, delayed } = pendingFixtureFinish();
  adapter.reset();
  const resumed = adapter.adapt(delayed);
  assert.ok(resumed);
  assert.equal(resumed.frame.finishResult, null, 'reset must discard the pending finish');
  assert.notEqual(resumed.frame.sessionId, crossing.frame.sessionId);
});
