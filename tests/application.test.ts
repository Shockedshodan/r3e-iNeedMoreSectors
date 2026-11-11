import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHudApplication } from '../src/application.ts';
import type { HudModule, KeyBinding, KeyInput, TelemetryBridge, TimingFrame } from '../src/contracts.ts';
import { completeLapFrames, definition, frame, MemoryStorage, result } from './helpers.ts';

class Bridge implements TelemetryBridge {
  connections = 0;
  disconnections = 0;
  listener: ((frame: TimingFrame) => void) | null = null;
  connect(listener: (frame: TimingFrame) => void) {
    this.connections++;
    this.listener = listener;
    return () => { this.disconnections++; this.listener = null; };
  }
  emit(frame: TimingFrame) { this.listener?.(frame); }
}

function setup() {
  const bridge = new Bridge();
  const storage = new MemoryStorage();
  const application = createHudApplication({
    storage, bridge,
    resolveDefinition: sample => sample.layoutId === 10 ? definition : sample.layoutId === 11 ? { ...definition, layoutId: 11 } : null,
    discoverModules: ({ timing }) => [timing],
  });
  return { application, bridge, storage };
}

test('application has stable external-store snapshots and owns one shared connection', () => {
  const { application, bridge } = setup();
  assert.equal(bridge.connections, 1);
  assert.equal(application.getSnapshot(), application.getSnapshot());
  let updates = 0;
  const unsubscribe = application.subscribe(() => { updates++; });
  application.cycleReference();
  assert.equal(application.getSnapshot().mode, 'opt');
  assert.equal(updates, 1);
  unsubscribe();
  application.cycleReference();
  assert.equal(updates, 1);
  application.dispose();
  assert.equal(bridge.disconnections, 1);
});

test('dynamic layout changes recreate timing internals without reconnecting the shared bridge', () => {
  const { application, bridge } = setup();
  application.cycleReference();
  for (const sample of completeLapFrames()) bridge.emit(sample);
  assert.equal(application.getSnapshot().records?.best?.totalUs, 1_000_000);
  bridge.emit(frame({ layoutId: 11, sessionId: 'layout-11' }));
  assert.equal(application.getSnapshot().mode, 'opt');
  assert.equal(application.getSnapshot().records?.layoutId, 11);
  assert.equal(application.getSnapshot().records?.best, null);
  bridge.emit(frame({ observedAtMs: 2000 }));
  assert.equal(application.getSnapshot().records?.layoutId, 10);
  assert.equal(application.getSnapshot().records?.best?.totalUs, 1_000_000);
  assert.equal(bridge.connections, 1);
  application.dispose();
});

test('keyboard rebinding, placement locking and editing previews flow through the active feature', () => {
  const { application } = setup();
  const binding: KeyBinding = { code: 'KeyR', altKey: false, ctrlKey: true, shiftKey: false, metaKey: false };
  application.setBinding(binding);
  const input: KeyInput = { ...binding, repeat: false, target: null };
  assert.equal(application.handleKey(input, true), true);
  assert.equal(application.getSnapshot().mode, 'opt');
  assert.deepEqual(application.getSnapshot().binding, binding);
  application.setWidgetEnabled('panel', false);
  assert.equal(application.getSnapshot().view.panel.visible, false);
  application.setEditing(true);
  assert.equal(application.getSnapshot().view.panel.preview, true);
  assert.equal(application.getSnapshot().view.delta.preview, true);
  application.dispose();
});

test('unknown or prohibited telemetry cannot initialize a player timing combination', () => {
  const { application, bridge } = setup();
  bridge.emit(frame({ layoutId: 99 }));
  assert.equal(application.getSnapshot().records, null);
  bridge.emit(frame({ source: 'debug' }));
  assert.equal(application.getSnapshot().records, null);
  application.dispose();
});

test('all discovered modules register through the host and receive the same frames', () => {
  const bridge = new Bridge();
  const seen: TimingFrame[] = [];
  const extra: HudModule = { id: 'extra', create(context) {
    const stop = context.subscribe(sample => seen.push(sample));
    return { widgets: [{ id: 'extra.panel', component: () => null, defaults: { x: 0, y: 0, scale: 1, enabled: true } }], dispose: stop };
  } };
  const application = createHudApplication({ storage: new MemoryStorage(), bridge, resolveDefinition: () => definition, discoverModules: ({ timing }) => [timing, extra] });
  bridge.emit(frame());
  assert.deepEqual(application.widgets().map(widget => widget.id), ['timing.sectors', 'timing.delta', 'extra.panel']);
  assert.equal(seen.length, 1);
  application.dispose();
  bridge.emit(frame({ observedAtMs: 250 }));
  assert.equal(seen.length, 1);
});

test('real rendering component descriptors replace the headless timing seams', () => {
  const panel = () => 'sector';
  const delta = () => 'delta';
  const application = createHudApplication({ storage: new MemoryStorage(), bridge: new Bridge(), resolveDefinition: () => definition, discoverModules: ({ timing }) => [timing], components: { panel, delta } });
  assert.equal(application.widgets()[0].component, panel);
  assert.equal(application.widgets()[1].component, delta);
  application.dispose();
});

test('hidden widgets continue collecting real timing references through the application runtime', () => {
  const { application, bridge } = setup();
  application.setWidgetEnabled('panel', false);
  application.setWidgetEnabled('delta', false);
  for (const sample of completeLapFrames(result())) bridge.emit(sample);
  assert.equal(application.getSnapshot().mode, 'off');
  assert.equal(application.getSnapshot().records?.best?.totalUs, 1_000_000);
  assert.equal(application.getSnapshot().view.panel.visible, false);
  assert.equal(application.getSnapshot().view.delta.visible, false);
  application.dispose();
});

test('an unavailable layout definition interrupts capture instead of silently using stale geometry', () => {
  const bridge = new Bridge();
  let available = true;
  const application = createHudApplication({ storage: new MemoryStorage(), bridge,
    resolveDefinition: () => available ? definition : null,
    discoverModules: ({ timing }) => [timing],
  });
  const samples = completeLapFrames();
  bridge.emit(samples[0]);
  available = false;
  bridge.emit(samples[1]);
  available = true;
  for (const sample of samples.slice(2)) bridge.emit(sample);
  assert.equal(application.getSnapshot().records?.best, null);
  application.dispose();
});

test('definition storage failure does not crash transport delivery or authorize a partial capture', () => {
  const bridge = new Bridge();
  let denied = true;
  const application = createHudApplication({ storage: new MemoryStorage(), bridge,
    resolveDefinition: () => { if (denied) throw new Error('Storage unavailable'); return definition; },
    discoverModules: ({ timing }) => [timing],
  });
  assert.doesNotThrow(() => bridge.emit(frame()));
  assert.equal(application.getSnapshot().records, null);
  denied = false;
  for (const sample of completeLapFrames().slice(1)) bridge.emit(sample);
  assert.equal(application.getSnapshot().records?.best, null);
  application.dispose();
});

test('mode and hotkey changes remain usable across first telemetry and layout changes when writes are denied', () => {
  const { application, bridge, storage } = setup();
  storage.failWrites = true;
  const binding: KeyBinding = { code: 'KeyR', altKey: false, ctrlKey: true, shiftKey: false, metaKey: false };
  application.setBinding(binding);
  application.cycleReference();
  assert.equal(application.getSnapshot().mode, 'opt');

  bridge.emit(frame());
  assert.equal(application.getSnapshot().mode, 'opt', 'first layout initialization preserves the in-memory mode');
  assert.deepEqual(application.getSnapshot().binding, binding);
  assert.equal(application.handleKey({ ...binding, repeat: false, target: null }, true), true);
  assert.equal(application.getSnapshot().mode, 'best');

  bridge.emit(frame({ layoutId: 11, sessionId: 'layout-11' }));
  assert.equal(application.getSnapshot().mode, 'best', 'switching layout preserves the current mode');
  assert.deepEqual(application.getSnapshot().binding, binding);
  application.dispose();
});

test('unsaved Best and Opt references survive leaving and returning to a layout', () => {
  const { application, bridge, storage } = setup();
  storage.failWrites = true;
  for (const sample of completeLapFrames()) bridge.emit(sample);
  assert.equal(application.getSnapshot().records?.best?.totalUs, 1_000_000);
  assert.equal(storage.writes.length, 0);

  bridge.emit(frame({ layoutId: 11, sessionId: 'layout-11' }));
  assert.equal(application.getSnapshot().records?.best, null);
  bridge.emit(frame({ observedAtMs: 2000 }));
  assert.equal(application.getSnapshot().records?.best?.totalUs, 1_000_000);
  assert.equal(application.getSnapshot().records?.opt?.totalUs, 1_000_000);

  storage.failWrites = false;
  bridge.emit(frame({ observedAtMs: 2250, distanceFraction: 0.25, lapElapsedUs: 250_000 }));
  const saved = [...storage.values.values()].map(value => JSON.parse(value));
  assert.ok(saved.some(value => value.schemaVersion === 1 && value.layoutId === 10 && value.best?.totalUs === 1_000_000));
  application.dispose();
});
