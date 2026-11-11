import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLayoutController } from '../src/ui/layout.ts';
import type { WidgetSpec } from '../src/contracts.ts';
import { MemoryStorage } from './helpers.ts';

const descriptors: WidgetSpec[] = [
  { id: 'timing.sectors', component: null, defaults: { x: 0, y: -200, scale: 1, enabled: true } },
  { id: 'timing.delta', component: null, defaults: { x: 0, y: -150, scale: 1, enabled: true } },
];

test('new layouts preserve module placement and scale defaults', () => {
  const layout = createLayoutController(new MemoryStorage(), descriptors);
  assert.deepEqual(layout.getState(), {
    profile: 1, editing: false, locked: false,
    widgets: {
      'timing.sectors': { x: 0, y: -200, scale: 1, enabled: true },
      'timing.delta': { x: 0, y: -150, scale: 1, enabled: true },
    },
  });
});

test('position, scale, visibility, lock and selected profile survive recreation', () => {
  const storage = new MemoryStorage();
  const layout = createLayoutController(storage, descriptors);
  layout.setProfile(2);
  layout.setPosition('timing.sectors', { x: 122, y: -44 });
  layout.setScale('timing.delta', 1.25);
  layout.setEnabled('timing.delta', false);
  layout.setLocked(true);
  layout.setEditing(true);
  const restored = createLayoutController(storage, descriptors).getState();
  assert.equal(restored.profile, 2);
  assert.equal(restored.locked, true);
  assert.equal(restored.editing, false, 'editing is a transient session state');
  assert.deepEqual(restored.widgets['timing.sectors'], { x: 122, y: -44, scale: 1, enabled: true });
  assert.deepEqual(restored.widgets['timing.delta'], { x: 0, y: -150, scale: 1.25, enabled: false });
});

test('the three profiles retain independent positions and reset only the selected profile', () => {
  const layout = createLayoutController(new MemoryStorage(), descriptors);
  layout.setPosition('timing.sectors', { x: 20, y: 30 });
  layout.setProfile(3);
  assert.equal(layout.getState().widgets['timing.sectors'].x, 0);
  layout.setPosition('timing.sectors', { x: 300, y: 400 });
  layout.resetProfile();
  assert.equal(layout.getState().widgets['timing.sectors'].x, 0);
  layout.setProfile(1);
  assert.equal(layout.getState().widgets['timing.sectors'].x, 20);
});

test('scale is clamped to upstream limits and malformed geometry is rejected', () => {
  const layout = createLayoutController(new MemoryStorage(), descriptors);
  layout.setScale('timing.delta', 0.01);
  assert.equal(layout.getState().widgets['timing.delta'].scale, 0.1);
  layout.setScale('timing.delta', 30);
  assert.equal(layout.getState().widgets['timing.delta'].scale, 3);
  assert.throws(() => layout.setPosition('timing.delta', { x: Number.NaN, y: 0 }), RangeError);
  assert.throws(() => layout.setScale('timing.delta', Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => layout.setPosition('unknown', { x: 0, y: 0 }), RangeError);
});

test('new module descriptors acquire defaults without resetting existing placement', () => {
  const layout = createLayoutController(new MemoryStorage(), descriptors);
  layout.setPosition('timing.delta', { x: 11, y: 22 });
  layout.registerWidgets([...descriptors, {
    id: 'extra.clock', component: null, defaults: { x: 400, y: 200, scale: 0.75, enabled: true },
  }]);
  assert.equal(layout.getState().widgets['timing.delta'].x, 11);
  assert.deepEqual(layout.getState().widgets['extra.clock'], { x: 400, y: 200, scale: 0.75, enabled: true });
});

test('layout subscriptions receive stable immutable snapshots and can unsubscribe', () => {
  const layout = createLayoutController(new MemoryStorage(), descriptors);
  const first = layout.getState();
  assert.equal(layout.getState(), first);
  let calls = 0;
  const unsubscribe = layout.subscribe(() => { calls += 1; });
  layout.setEditing(true);
  assert.equal(calls, 1);
  assert.equal(first.editing, false);
  assert.ok(Object.isFrozen(layout.getState()));
  assert.ok(Object.isFrozen(layout.getState().widgets['timing.delta']));
  unsubscribe();
  layout.setLocked(true);
  assert.equal(calls, 1);
});

test('corrupted or denied storage cannot stop local layout editing', () => {
  const storage = new MemoryStorage();
  storage.failReads = true;
  storage.failWrites = true;
  const layout = createLayoutController(storage, descriptors);
  layout.setPosition('timing.delta', { x: 42, y: -10 });
  assert.equal(layout.getState().widgets['timing.delta'].x, 42);
  storage.failReads = false;
  storage.failWrites = false;
  layout.setScale('timing.delta', 1.2);
  assert.equal(createLayoutController(storage, descriptors).getState().widgets['timing.delta'].x, 42);
});

test('invalid saved widget geometry is ignored independently of valid widget settings', () => {
  const storage = new MemoryStorage();
  const layout = createLayoutController(storage, descriptors);
  layout.setPosition('timing.sectors', { x: 123, y: 456 });
  const [key, raw] = [...storage.values.entries()][0];
  const saved = JSON.parse(raw);
  saved.profiles['1']['timing.delta'] = { x: 'bad', y: 0, scale: 5, enabled: true };
  storage.values.set(key, JSON.stringify(saved));
  const restored = createLayoutController(storage, descriptors).getState();
  assert.equal(restored.widgets['timing.sectors'].x, 123);
  assert.deepEqual(restored.widgets['timing.delta'], { x: 0, y: -150, scale: 1, enabled: true });
});
