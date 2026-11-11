import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  HudModule, ModuleContext, TelemetryBridge, TimingFrame, WidgetSpec,
} from '../src/contracts.ts';
import { createHudHost } from '../src/module-host.ts';
import { frame, MemoryStorage } from './helpers.ts';

class FakeBridge implements TelemetryBridge {
  connections = 0;
  disconnections = 0;
  listeners = new Set<(value: TimingFrame) => void>();
  connect(listener: (value: TimingFrame) => void): () => void {
    this.connections += 1;
    this.listeners.add(listener);
    return () => {
      this.disconnections += 1;
      this.listeners.delete(listener);
    };
  }
  emit(value: TimingFrame): void {
    for (const listener of this.listeners) listener(value);
  }
}

function widget(id: string, enabled = true): WidgetSpec {
  return {
    id, component: () => null,
    defaults: { x: 10, y: 20, scale: 1.25, enabled },
  };
}

function listeningModule(id: string, frames: TimingFrame[], enabled = true): HudModule {
  return {
    id,
    create(context) {
      const unsubscribe = context.subscribe(value => frames.push(value));
      return { widgets: [widget(`${id}.panel`, enabled)], dispose: unsubscribe };
    },
  };
}

test('host connects once and distributes each telemetry frame to all modules', () => {
  const bridge = new FakeBridge();
  const first: TimingFrame[] = [];
  const second: TimingFrame[] = [];
  const host = createHudHost([
    listeningModule('timing', first), listeningModule('another-feature', second),
  ], bridge, new MemoryStorage());
  const value = frame({ observedAtMs: 100 });
  bridge.emit(value);
  assert.equal(bridge.connections, 1);
  assert.deepEqual(first, [value]);
  assert.deepEqual(second, [value]);
  host.dispose();
});

test('adding a module descriptor registers its widgets, defaults and actions', () => {
  let runs = 0;
  const spec = widget('new-feature.unusual-widget');
  const module: HudModule = {
    id: 'new-feature',
    create: () => ({
      widgets: [spec], actions: [{ id: 'new-feature.perform', run: () => { runs += 1; } }],
      dispose() {},
    }),
  };
  const host = createHudHost([module], new FakeBridge(), new MemoryStorage());
  assert.deepEqual(host.widgets(), [spec]);
  assert.equal(host.dispatch('new-feature.perform'), true);
  assert.equal(runs, 1);
  assert.equal(host.dispatch('unknown-action'), false);
  assert.equal(runs, 1);
  host.dispose();
});

test('a disabled timing widget does not disable background collection', () => {
  const bridge = new FakeBridge();
  const received: TimingFrame[] = [];
  const host = createHudHost([listeningModule('timing', received, false)], bridge, new MemoryStorage());
  bridge.emit(frame());
  bridge.emit(frame({ observedAtMs: 250, distanceFraction: 0.25 }));
  assert.equal(host.widgets()[0].defaults.enabled, false);
  assert.equal(received.length, 2);
  host.dispose();
});

test('module storage isolates identical local keys without colliding with global preferences', () => {
  const storage = new MemoryStorage();
  storage.values.set('settings', 'existing-global-value');
  const contexts: ModuleContext[] = [];
  const modules = ['one', 'two'].map((id): HudModule => ({
    id,
    create(context) {
      contexts.push(context);
      return { widgets: [], dispose() {} };
    },
  }));
  const host = createHudHost(modules, new FakeBridge(), storage);
  contexts[0].storage.setItem('settings', 'first-module');
  contexts[1].storage.setItem('settings', 'second-module');
  assert.equal(contexts[0].storage.getItem('settings'), 'first-module');
  assert.equal(contexts[1].storage.getItem('settings'), 'second-module');
  assert.equal(storage.getItem('settings'), 'existing-global-value');
  // Prefix spelling is deliberately unspecified; isolation and persistence
  // through the supplied backing storage are the externally visible contract.
  assert.equal([...storage.values.values()].includes('first-module'), true);
  assert.equal([...storage.values.values()].includes('second-module'), true);
  host.dispose();
});

test('module-owned unsubscribe stops only that subscription', () => {
  const bridge = new FakeBridge();
  const received: TimingFrame[] = [];
  let unsubscribe: (() => void) | undefined;
  const module: HudModule = {
    id: 'self-unsubscribing',
    create(context) {
      unsubscribe = context.subscribe(value => received.push(value));
      return { widgets: [], dispose() {} };
    },
  };
  const host = createHudHost([module], bridge, new MemoryStorage());
  bridge.emit(frame());
  unsubscribe!();
  bridge.emit(frame({ observedAtMs: 1 }));
  assert.equal(received.length, 1);
  assert.equal(bridge.disconnections, 0);
  host.dispose();
});

test('disposing twice cleans each module and bridge once and prevents later callbacks', () => {
  const bridge = new FakeBridge();
  let received = 0;
  let disposed = 0;
  let actionRuns = 0;
  const module: HudModule = {
    id: 'timing',
    create(context) {
      // Host must remove owned subscriptions even if a module forgets to.
      context.subscribe(() => { received += 1; });
      return {
        widgets: [widget('timing.panel')],
        actions: [{ id: 'timing.cycleReference', run: () => { actionRuns += 1; } }],
        dispose() { disposed += 1; },
      };
    },
  };
  const host = createHudHost([module], bridge, new MemoryStorage());
  bridge.emit(frame());
  assert.equal(received, 1);
  host.dispose();
  host.dispose();
  bridge.emit(frame({ observedAtMs: 2 }));
  assert.equal(host.dispatch('timing.cycleReference'), false);
  assert.equal(received, 1);
  assert.equal(actionRuns, 0);
  assert.equal(disposed, 1);
  assert.equal(bridge.disconnections, 1);
  assert.equal(bridge.listeners.size, 0);
});

for (const duplicateKind of ['module', 'widget', 'action'] as const) {
  test(`duplicate ${duplicateKind} IDs are rejected`, () => {
    const modules = ['one', 'two'].map((id): HudModule => ({
      id: duplicateKind === 'module' ? 'duplicate' : id,
      create: () => ({
        widgets: [widget(duplicateKind === 'widget' ? 'duplicate-widget' : `${id}.panel`)],
        actions: [{ id: duplicateKind === 'action' ? 'duplicate-action' : `${id}.run`, run() {} }],
        dispose() {},
      }),
    }));
    assert.throws(
      () => createHudHost(modules, new FakeBridge(), new MemoryStorage()),
      /duplicate/i,
    );
  });
}

test('an initialization failure releases earlier modules and their subscriptions', () => {
  const bridge = new FakeBridge();
  let received = 0;
  let disposed = 0;
  const ready: HudModule = {
    id: 'ready',
    create(context) {
      context.subscribe(() => { received += 1; });
      return { widgets: [], dispose() { disposed += 1; } };
    },
  };
  const failure = new Error('Module initialization failed');
  const broken: HudModule = {
    id: 'broken',
    create(context) {
      context.subscribe(() => { received += 1; });
      throw failure;
    },
  };
  assert.throws(() => createHudHost([ready, broken], bridge, new MemoryStorage()), error => error === failure);
  bridge.emit(frame());
  assert.equal(received, 0);
  assert.equal(disposed, 1);
  assert.equal(bridge.listeners.size, 0);
  // A host may initialize modules before connecting; either way there must
  // be no live connection after the failed construction.
  assert.equal(bridge.disconnections, bridge.connections);
});
