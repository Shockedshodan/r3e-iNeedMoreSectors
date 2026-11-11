import assert from 'node:assert/strict';
import test from 'node:test';
import type { TelemetryBridge, TimingFrame } from '../src/contracts.ts';
import { createHudHost } from '../src/module-host.ts';
import { createTimingFeature } from '../src/timing-feature.ts';
import { completeLapFrames, definition, frame, MemoryStorage, result } from './helpers.ts';

// Headless acceptance checks over normalized synthetic telemetry. These compose
// the real timing feature with the host; they do not stand in for a live bridge,
// rendered React widgets, or RaceRoom's embedded browser.
class SyntheticBridge implements TelemetryBridge {
  listeners = new Set<(value: TimingFrame) => void>();
  connect(listener: (value: TimingFrame) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(value: TimingFrame): void {
    for (const listener of this.listeners) listener(value);
  }
  emitAll(values: readonly TimingFrame[]): void {
    for (const value of values) this.emit(value);
  }
}

function feature() {
  return createTimingFeature({
    definition, maxFrameGapMs: 300, maxDistanceStep: 0.3, finishTimeoutMs: 500,
  });
}

for (const [mode, cycles] of [['off', 0], ['opt', 1], ['best', 2]] as const) {
  test(`actual timing collection and record improvement continue in ${mode} mode`, () => {
    const timing = feature();
    const bridge = new SyntheticBridge();
    const storage = new MemoryStorage();
    const host = createHudHost([timing], bridge, storage);
    for (let index = 0; index < cycles; index += 1) {
      assert.equal(host.dispatch('timing.cycleReference'), true);
    }
    assert.equal(timing.mode(), mode);
    bridge.emitAll(completeLapFrames());
    const records = timing.records();
    assert.ok(records);
    assert.equal(records.best?.totalUs, 1_000_000);
    assert.equal(records.opt?.totalUs, 1_000_000);
    assert.deepEqual(records.best?.sectors.map(sector => sector.durationUs), [500_000, 500_000]);
    assert.deepEqual(records.opt?.sectors.map(sector => sector.durationUs), [500_000, 500_000]);
    if (mode === 'off') {
      assert.equal(timing.view().panel.visible, false);
      assert.equal(timing.view().delta.visible, false);
      assert.equal(timing.view().delta.valueUs, null);
    }
    host.dispose();
  });
}

test('disabling both actual timing widgets leaves capture and saved records active', () => {
  const timing = feature();
  const bridge = new SyntheticBridge();
  const host = createHudHost([timing], bridge, new MemoryStorage());
  host.dispatch('timing.cycleReference');
  timing.setWidgetEnabled('panel', false);
  timing.setWidgetEnabled('delta', false);
  bridge.emitAll(completeLapFrames());
  assert.equal(timing.mode(), 'opt');
  assert.equal(timing.view().panel.visible, false);
  assert.equal(timing.view().delta.visible, false);
  assert.equal(timing.records()?.best?.totalUs, 1_000_000);
  assert.equal(timing.records()?.opt?.totalUs, 1_000_000);
  host.dispose();
});

test('completed timing references survive disposal and recreation through host storage', () => {
  const storage = new MemoryStorage();
  const first = feature();
  const firstBridge = new SyntheticBridge();
  const firstHost = createHudHost([first], firstBridge, storage);
  firstBridge.emitAll(completeLapFrames());
  const saved = structuredClone(first.records());
  assert.ok(saved?.best);
  assert.ok(saved.opt);
  firstHost.dispose();

  const restored = feature();
  const restoredBridge = new SyntheticBridge();
  const restoredHost = createHudHost([restored], restoredBridge, storage);
  // The initial player frame identifies the car/layout whose references load.
  restoredBridge.emit(frame());
  assert.deepEqual(restored.records(), saved);
  restoredHost.dispose();
});

test('disposed host no longer feeds the actual timing feature or persists faster laps', () => {
  const storage = new MemoryStorage();
  const timing = feature();
  const bridge = new SyntheticBridge();
  const host = createHudHost([timing], bridge, storage);
  bridge.emitAll(completeLapFrames());
  const saved = structuredClone(timing.records());
  assert.ok(saved?.best);
  host.dispose();
  const writesAfterDispose = storage.writes.length;

  const fasterSecondLap = completeLapFrames(result({
    completedLap: 2, totalUs: 800_000,
    officialSectorDurationsUs: [200_000, 300_000, 300_000],
  })).map(value => ({
    ...value,
    completedLaps: value.completedLaps + 1,
    observedAtMs: value.observedAtMs + 1000,
    lapElapsedUs: value.lapElapsedUs * 0.8,
  }));
  bridge.emitAll(fasterSecondLap);
  assert.deepEqual(timing.records(), saved);
  assert.equal(storage.writes.length, writesAfterDispose);
});

test('an Opt-only improvement persists the captured lap without manufacturing a faster Best', () => {
  const storage = new MemoryStorage();
  const timing = feature();
  const bridge = new SyntheticBridge();
  const host = createHudHost([timing], bridge, storage);
  bridge.emitAll(completeLapFrames());
  bridge.emitAll([
    frame({ observedAtMs: 1225, completedLaps: 1, distanceFraction: 0.25, lapElapsedUs: 225_000 }),
    frame({ observedAtMs: 1450, completedLaps: 1, distanceFraction: 0.5, lapElapsedUs: 450_000 }),
    frame({ observedAtMs: 1612.5, completedLaps: 1, distanceFraction: 0.625, lapElapsedUs: 612_500 }),
    frame({ observedAtMs: 1775, completedLaps: 1, distanceFraction: 0.75, lapElapsedUs: 775_000 }),
    frame({ observedAtMs: 1937.5, completedLaps: 1, distanceFraction: 0.875, lapElapsedUs: 937_500 }),
    frame({ observedAtMs: 2100, completedLaps: 2, finishResult: result({
      completedLap: 2, totalUs: 1_100_000,
      officialSectorDurationsUs: [300_000, 400_000, 400_000],
    }) }),
  ]);
  assert.equal(timing.records()?.best?.totalUs, 1_000_000);
  assert.equal(timing.records()?.opt?.totalUs, 950_000);
  host.dispose();

  const restored = feature();
  const restoredBridge = new SyntheticBridge();
  const restoredHost = createHudHost([restored], restoredBridge, storage);
  restoredBridge.emit(frame());
  assert.equal(restored.records()?.best?.totalUs, 1_000_000);
  assert.equal(restored.records()?.opt?.totalUs, 950_000);
  restoredHost.dispose();
});

test('changing car models keeps their records separate and restores the original combination', () => {
  const timing = feature();
  const bridge = new SyntheticBridge();
  const host = createHudHost([timing], bridge, new MemoryStorage());
  bridge.emitAll(completeLapFrames());
  bridge.emitAll(completeLapFrames(result({
    modelId: 21, totalUs: 1_200_000,
    officialSectorDurationsUs: [400_000, 400_000, 400_000],
  })).map(value => ({
    ...value, modelId: 21,
    observedAtMs: 1000 + value.observedAtMs * 1.2,
    lapElapsedUs: value.lapElapsedUs * 1.2,
  })));
  assert.equal(timing.records()?.modelId, 21);
  assert.equal(timing.records()?.best?.totalUs, 1_200_000);
  bridge.emit(frame({ observedAtMs: 2200, completedLaps: 1 }));
  assert.equal(timing.records()?.modelId, 20);
  assert.equal(timing.records()?.best?.totalUs, 1_000_000);
  host.dispose();
});

test('debug or opponent data cannot initialize a player record combination', () => {
  const timing = feature();
  const bridge = new SyntheticBridge();
  const host = createHudHost([timing], bridge, new MemoryStorage());
  bridge.emit(frame({ source: 'debug' }));
  assert.equal(timing.records(), null);
  bridge.emit(frame({ control: 'remote' }));
  assert.equal(timing.records(), null);
  bridge.emitAll(completeLapFrames());
  assert.equal(timing.records()?.best?.totalUs, 1_000_000);
  host.dispose();
});

test('the same module can be recreated after disposal without duplicating subscriptions', () => {
  const timing = feature();
  const storage = new MemoryStorage();
  const firstBridge = new SyntheticBridge();
  const firstHost = createHudHost([timing], firstBridge, storage);
  firstBridge.emitAll(completeLapFrames());
  firstHost.dispose();

  const secondBridge = new SyntheticBridge();
  const secondHost = createHudHost([timing], secondBridge, storage);
  assert.equal(firstBridge.listeners.size, 0);
  assert.equal(secondBridge.listeners.size, 1);
  secondBridge.emit(frame());
  assert.equal(timing.records()?.best?.totalUs, 1_000_000);
  secondHost.dispose();
  assert.equal(secondBridge.listeners.size, 0);
});

test('a later player frame retries unsaved improvements without requiring another record lap', () => {
  const storage = new MemoryStorage();
  storage.failWrites = true;
  const timing = feature();
  const bridge = new SyntheticBridge();
  const host = createHudHost([timing], bridge, storage);
  bridge.emitAll(completeLapFrames());
  assert.equal(timing.records()?.best?.totalUs, 1_000_000);
  assert.equal(storage.writes.length, 0);

  storage.failWrites = false;
  bridge.emit(frame({
    observedAtMs: 1250, completedLaps: 1,
    distanceFraction: 0.25, lapElapsedUs: 250_000,
  }));
  assert.equal(storage.writes.length, 1, 'the already validated improvement is retried');
  assert.equal(JSON.parse(storage.writes[0].value).best.totalUs, 1_000_000);
  host.dispose();

  const restored = feature();
  const restoredBridge = new SyntheticBridge();
  const restoredHost = createHudHost([restored], restoredBridge, storage);
  restoredBridge.emit(frame());
  assert.equal(restored.records()?.best?.totalUs, 1_000_000);
  restoredHost.dispose();
});

test('recovered faster stored references synchronize records without changing the active-lap snapshot', () => {
  const storage = new MemoryStorage();
  const seed = feature();
  const seedBridge = new SyntheticBridge();
  const seedHost = createHudHost([seed], seedBridge, storage);
  seedBridge.emitAll(completeLapFrames(result({
    totalUs: 800_000, officialSectorDurationsUs: [200_000, 300_000, 300_000],
  })).map(value => ({
    ...value, observedAtMs: value.observedAtMs * 0.8,
    lapElapsedUs: value.lapElapsedUs * 0.8,
  })));
  assert.equal(seed.records()?.best?.totalUs, 800_000);
  seedHost.dispose();
  const recordKey = [...storage.values.keys()].find(key => JSON.parse(storage.values.get(key)!).schemaVersion === 1)!;
  const fasterSaved = storage.values.get(recordKey);

  storage.failReads = true;
  const timing = feature();
  const bridge = new SyntheticBridge();
  const host = createHudHost([timing], bridge, storage);
  host.dispatch('timing.cycleReference');
  host.dispatch('timing.cycleReference');
  bridge.emitAll(completeLapFrames());
  assert.equal(timing.records()?.best?.totalUs, 1_000_000, 'new improvements remain usable in memory');
  assert.ok(storage.values.get(recordKey) === fasterSaved, 'unread saved references cannot be overwritten');
  assert.equal(timing.view().panel.reference, null);

  storage.failReads = false;
  bridge.emit(frame({
    observedAtMs: 1250, completedLaps: 1, distanceFraction: 0.25, lapElapsedUs: 250_000,
  }));
  assert.equal(timing.records()?.best?.totalUs, 800_000);
  assert.equal(timing.records()?.opt?.totalUs, 800_000);
  assert.equal(JSON.parse(storage.values.get(recordKey)!).best.totalUs, 800_000);
  assert.equal(timing.view().panel.reference, null, 'current lap still compares its original snapshot');
  assert.equal(timing.view().delta.reference, null);
  for (const observedAtMs of [1500, 1750]) {
    bridge.emit(frame({
      observedAtMs, completedLaps: 1,
      distanceFraction: (observedAtMs - 1000) / 1000,
      lapElapsedUs: (observedAtMs - 1000) * 1000,
    }));
  }
  bridge.emit(frame({ observedAtMs: 2000, completedLaps: 2 }));
  assert.equal(timing.view().panel.reference?.totalUs, 800_000, 'next lap sees recovered references');
  assert.equal(timing.view().delta.reference?.totalUs, 800_000);
  host.dispose();
});

test('mutating a bridge frame after delivery cannot change the displayed saved-reference delta', () => {
  const storage = new MemoryStorage();
  const seed = feature();
  const seedBridge = new SyntheticBridge();
  const seedHost = createHudHost([seed], seedBridge, storage);
  seedBridge.emitAll(completeLapFrames());
  seedHost.dispose();

  const timing = feature();
  const bridge = new SyntheticBridge();
  const host = createHudHost([timing], bridge, storage);
  host.dispatch('timing.cycleReference');
  host.dispatch('timing.cycleReference');
  bridge.emit(frame());
  const progress = frame({ observedAtMs: 250, distanceFraction: 0.25, lapElapsedUs: 250_000 });
  bridge.emit(progress);
  assert.equal(timing.view().delta.valueUs, 0);

  progress.lapElapsedUs = 900_000;
  assert.equal(timing.view().delta.valueUs, 0, 'only a new delivered observation may change the delta');
  host.dispose();
});
