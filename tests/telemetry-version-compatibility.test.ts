import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { TimingFrame } from '../src/contracts.ts';
import { analyzeCapture } from '../src/diagnostics/analyze.ts';
import { parseCapture } from '../src/diagnostics/capture-format.ts';
import { replayCapture } from '../src/diagnostics/replay.ts';
import { createRaceRoomAdapter } from '../src/telemetry/raceroom-adapter.ts';
import { createRaceRoomBridge } from '../src/telemetry/websocket-bridge.ts';
import type { BridgeIngressEvent, RaceRoomSocket } from '../src/telemetry/websocket-bridge.ts';

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    VersionMajor: 3, VersionMinor: 6, LayoutId: 10, LayoutLength: 3000,
    TrackName: 'Test circuit', LayoutName: 'Grand prix', VehicleInfo: { ModelId: 20 },
    SessionType: 0, SessionIteration: 1, EventIndex: 0,
    Player: { GameSimulationTime: 10 }, CompletedLaps: 0,
    LapDistanceFraction: 0.9, LapTimeCurrentSelf: 9, LapValidState: 0,
    LapTimePreviousSelf: -1, SectorTimesPreviousSelf: { Sector1: -1, Sector2: -1, Sector3: -1 },
    PrevLapValid: -1, ControlType: 0, GameInReplay: 0, GamePaused: 0, GameInMenus: 0,
    ...overrides,
  };
}

const versions: [string, Record<string, unknown>][] = [
  ['2.8', { VersionMajor: 2, VersionMinor: 8 }],
  ['3.7', { VersionMajor: 3, VersionMinor: 7 }],
  ['4.0', { VersionMajor: 4, VersionMinor: 0 }],
  ['99.99', { VersionMajor: 99, VersionMinor: 99 }],
  ['absent', {}],
  ['major only', { VersionMajor: 2 }],
  ['minor only', { VersionMinor: 8 }],
  ['non-numeric diagnostic values', { VersionMajor: '2', VersionMinor: null }],
];

function withVersion(metadata: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const value = raw(overrides);
  delete value.VersionMajor;
  delete value.VersionMinor;
  return { ...value, ...metadata };
}

for (const [name, metadata] of versions) {
  test(`compatible telemetry normalizes identically with ${name} version metadata`, () => {
    const baseline = createRaceRoomAdapter({ nowMs: () => 100 }).adapt(raw());
    assert.ok(baseline, 'The existing 3.6 practice path must remain usable');
    assert.equal(baseline.frame.lapElapsedUs, 9_000_000);
    const adapter = createRaceRoomAdapter({ nowMs: () => 100 });
    const input = withVersion(metadata);
    const original = structuredClone(input);
    const observation = adapter.adapt(input);
    assert.ok(observation, `Required player fields must be admitted: ${adapter.status()}`);
    assert.deepEqual(observation, baseline);
    assert.doesNotMatch(adapter.status(), /unsupported.*version|expected 3\.6/i);
    assert.deepEqual(input, original, 'Normalization must preserve the original version provenance');
  });
}

async function capturedPractice() {
  return parseCapture(await readFile(new URL('./fixtures/lap-count-windows/capture.jsonl', import.meta.url), 'utf8'),
    { allowIncomplete: true });
}

test('captured practice observations with available timing normalize using their original 2.8 metadata', async () => {
  const document = await capturedPractice();
  const messages = document.events.filter(event => event.type === 'message'
    && typeof event.data?.LapTimeCurrentSelf === 'number' && event.data.LapTimeCurrentSelf >= 0);
  assert.equal(messages.length, 7, 'Use the committed real observations, without filling unavailable clocks');
  for (const event of messages) {
    const data = event.data!;
    assert.deepEqual([data.VersionMajor, data.VersionMinor], [2, 8]);
    const original = structuredClone(data);
    const adapter = createRaceRoomAdapter({ nowMs: () => event.tMs });
    const observation = adapter.adapt(data);
    assert.ok(observation, `Receipt ${event.seq} has usable fields: ${adapter.status()}`);
    assert.equal(observation.frame.layoutId, 13256);
    assert.equal(observation.frame.modelId, 13398);
    assert.equal(observation.frame.lapElapsedUs, Math.round(Number(data.LapTimeCurrentSelf) * 1_000_000));
    assert.equal(observation.frame.distanceFraction, data.LapDistanceFraction);
    assert.equal(observation.frame.finishResult, null);
    assert.deepEqual(data, original);
  }
});

test('captured practice replay observes compatible crossings while preserving provenance and live-write isolation', async () => {
  const document = await capturedPractice();
  const original = structuredClone(document);
  const report = replayCapture(document);
  assert.deepEqual(report.observedCrossings.map(row => [row.seq, row.completedLap]), [[9, 3], [12, 4]]);
  assert.doesNotMatch(report.issues.join('\n'), /unsupported.*version|expected 3\.6/i);
  assert.ok(report.issues.some(reason => /malformed player timing/i.test(reason)), 'Unavailable clocks still reject');
  assert.equal(report.liveWritesEnabled, false);
  assert.equal(report.profileValidated, false);
  assert.deepEqual(report.controlProposals, []);
  assert.deepEqual(report.shadowProposals, [], 'Extracted windows are not complete laps');
  assert.deepEqual(report.acceptedLaps, []);
  const analysis = analyzeCapture(document);
  const observation = analysis.reportedLaps.find(row => row.seq === 9)!.observations.find(row => row.seq === 9)!;
  assert.deepEqual(observation.fields.VersionMajor, { present: true, value: 2 });
  assert.deepEqual(observation.fields.VersionMinor, { present: true, value: 8 });
  assert.deepEqual(document, original);
});

const crossing = { CompletedLaps: 1, LapDistanceFraction: 0.01, LapTimeCurrentSelf: 0.1 };
const delayed = { ...crossing, LapDistanceFraction: 0.02, LapTimeCurrentSelf: 0.2,
  LapTimePreviousSelf: 10, SectorTimesPreviousSelf: { Sector1: 3, Sector2: 6, Sector3: 10 }, PrevLapValid: 1 };

// Only this synthetic fixture opts into candidate writes. A fixed clock keeps
// every observation inside the existing finish timeout; it proves no live finality.
function pendingFinish() {
  const adapter = createRaceRoomAdapter({ enableRecordWrites: true, nowMs: () => 100 });
  const first = adapter.adapt(raw());
  assert.ok(first);
  const pending = adapter.adapt(raw(crossing));
  assert.ok(pending);
  assert.equal(pending.frame.finishResult, null);
  assert.equal(pending.frame.sessionId, first.frame.sessionId);
  return { adapter, pending };
}

test('version metadata changes preserve an eligible pending synthetic finish without enabling default live writes', () => {
  const { adapter, pending } = pendingFinish();
  const result = adapter.adapt(withVersion({ VersionMajor: 2, VersionMinor: 8 }, delayed));
  assert.ok(result, adapter.status());
  assert.equal(result.frame.sessionId, pending.frame.sessionId);
  assert.deepEqual(result.frame.finishResult, {
    sessionId: pending.frame.sessionId, layoutId: 10, modelId: 20, completedLap: 1,
    valid: true, totalUs: 10_000_000, officialSectorDurationsUs: [3_000_000, 3_000_000, 4_000_000],
  });
  const live = createRaceRoomAdapter({ nowMs: () => 100 });
  assert.ok(live.adapt(raw()));
  assert.ok(live.adapt(withVersion({}, crossing)));
  const disabled = live.adapt(withVersion({ VersionMajor: 2, VersionMinor: 8 }, delayed));
  assert.ok(disabled);
  assert.equal(disabled.frame.finishResult, null);
  assert.match(live.status(), /disabled|unverified/i);
});

for (const [name, change, reason] of [
  ['missing layout identity', { LayoutId: undefined }, /malformed player timing/i],
  ['unavailable layout length', { LayoutLength: 0 }, /malformed player timing/i],
  ['missing vehicle identity', { VehicleInfo: null }, /malformed player timing/i],
  ['nonfinite distance', { LapDistanceFraction: Number.NaN }, /malformed player timing/i],
  ['unavailable lap clock', { LapTimeCurrentSelf: -1 }, /malformed player timing/i],
  ['unavailable lap count', { CompletedLaps: -1 }, /malformed player timing/i],
  ['unsupported session', { SessionType: 2 }, /practice sessions/i],
] as const) {
  test(`compatible telemetry reports ${name} by its field reason and severs pending association`, () => {
    const uninterrupted = pendingFinish();
    assert.equal(uninterrupted.adapter.adapt(raw(delayed))?.frame.finishResult?.totalUs, 10_000_000,
      'The same pending fixture must associate when uninterrupted');
    const { adapter, pending } = pendingFinish();
    assert.equal(adapter.adapt(withVersion({ VersionMajor: 2, VersionMinor: 8 }, { ...delayed, ...change })), null);
    const rejection = adapter.status();
    const resumed = adapter.adapt(raw(delayed));
    assert.ok(resumed);
    assert.equal(resumed.frame.finishResult, null);
    assert.notEqual(resumed.frame.sessionId, pending.frame.sessionId);
    assert.match(rejection, reason, 'Version diagnostics must not hide the actual incompatible field');
  });
}

test('compatible telemetry retains player-control and validity restrictions on synthetic record candidates', () => {
  for (const interruption of [
    { ControlType: 1 }, { ControlType: 2 }, { GameInReplay: 1 }, { GamePaused: 1 },
    { GameInMenus: 1 }, { Debug: true }, { PrevLapValid: 0 }, { PrevLapValid: -1 },
    { SectorTimesPreviousSelf: { Sector1: 3, Sector2: 2, Sector3: 10 } },
  ]) {
    const { adapter } = pendingFinish();
    const value = adapter.adapt(withVersion({ VersionMajor: 2, VersionMinor: 8 }, { ...delayed, ...interruption }));
    assert.ok(value, adapter.status());
    assert.equal(value.frame.finishResult, null, JSON.stringify(interruption));
  }
});

class Socket implements RaceRoomSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(_data: string) {}
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

test('live bridge delivers compatible version variants and clears session continuity on reconnect', () => {
  const sockets: Socket[] = [];
  const tasks = new Map<number, () => void>();
  let nextTask = 0;
  const frames: TimingFrame[] = [];
  const ingress: BridgeIngressEvent[] = [];
  const bridge = createRaceRoomBridge({
    socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    schedule: callback => { tasks.set(++nextTask, callback); return nextTask; },
    cancel: handle => { tasks.delete(handle as number); },
    onIngress: event => ingress.push(event),
  });
  const disconnect = bridge.connect(frame => frames.push(frame));
  try {
    sockets[0].open();
    for (const [, metadata] of versions) sockets[0].message(withVersion(metadata));
    assert.equal(frames.length, versions.length, bridge.status());
    assert.ok(bridge.latest());
    assert.equal(bridge.latest()!.frame, frames.at(-1));
    assert.ok(frames.every(frame => frame.lapElapsedUs === 9_000_000 && frame.finishResult === null));
    assert.equal(new Set(frames.map(frame => frame.sessionId)).size, 1);
    const messages = ingress.filter(event => event.type === 'message');
    assert.equal(messages.length, versions.length);
    for (const [index, event] of messages.entries()) {
      const data = event.data as Record<string, unknown>;
      const metadata = versions[index][1];
      assert.equal(data.LayoutId, 10);
      assert.deepEqual(data.VehicleInfo, { ModelId: 20 });
      for (const key of ['VersionMajor', 'VersionMinor']) {
        assert.equal(Object.hasOwn(data, key), Object.hasOwn(metadata, key));
        assert.equal(data[key], metadata[key], 'Ingress must retain version diagnostics without rewriting them');
      }
    }
    sockets[0].close();
    assert.equal(bridge.latest(), null);
    assert.equal(tasks.size, 1);
    const [id, reconnect] = [...tasks][0];
    tasks.delete(id);
    reconnect();
    sockets[1].open();
    sockets[1].message(withVersion({ VersionMajor: 2, VersionMinor: 8 }));
    assert.equal(frames.length, versions.length + 1);
    assert.notEqual(frames.at(-1)!.sessionId, frames[0].sessionId);
    assert.equal(frames.at(-1)!.finishResult, null);
  } finally {
    disconnect();
  }
});
