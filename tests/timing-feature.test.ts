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
