import assert from 'node:assert/strict';
import test from 'node:test';
import type { KeyBinding, KeyInput, RecordBook, TimingViewOptions } from '../src/contracts.ts';
import { createReferenceController, createTimingView } from '../src/reference-control.ts';
import { book, lap, MemoryStorage } from './helpers.ts';

// Proposed preferences wire contract; kept separate from per-combination records.
const preferencesKey = 'r3e-sectors:v1:preferences:timing';
const binding: KeyBinding = {
  code: 'KeyT', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false,
};

function key(overrides: Partial<KeyInput> = {}): KeyInput {
  return { ...binding, repeat: false, target: null, ...overrides };
}

function snapshot(): RecordBook {
  return { ...book(), best: lap([600_000, 400_000]), opt: lap([500_000, 300_000]) };
}

function viewOptions(overrides: Partial<TimingViewOptions> = {}): TimingViewOptions {
  return {
    mode: 'best', snapshot: snapshot(), lapElapsedUs: 800_000,
    distanceFraction: 0.75, panelEnabled: true, deltaEnabled: true,
    editing: false, ...overrides,
  };
}

test('reference selection starts Off and cycles Off → Opt → Best → Off', () => {
  const controller = createReferenceController(new MemoryStorage());
  assert.equal(controller.mode(), 'off');
  controller.cycle();
  assert.equal(controller.mode(), 'opt');
  controller.cycle();
  assert.equal(controller.mode(), 'best');
  controller.cycle();
  assert.equal(controller.mode(), 'off');
});

test('last mode and configured binding are restored from the preferences entry', () => {
  const storage = new MemoryStorage();
  storage.values.set(preferencesKey, JSON.stringify({ mode: 'best', binding }));
  const controller = createReferenceController(storage);
  assert.equal(controller.mode(), 'best');
  assert.deepEqual(controller.binding(), binding);
});

test('mode changes persist with the binding and survive controller recreation', () => {
  const storage = new MemoryStorage();
  const controller = createReferenceController(storage);
  controller.setBinding(binding);
  controller.cycle();
  const saved = JSON.parse(storage.getItem(preferencesKey)!);
  assert.equal(saved.mode, 'opt');
  assert.deepEqual(saved.binding, binding);
  const restored = createReferenceController(storage);
  assert.equal(restored.mode(), 'opt');
  assert.deepEqual(restored.binding(), binding);
});

test('rebinding takes effect immediately and persists without changing selected mode', () => {
  const storage = new MemoryStorage();
  const controller = createReferenceController(storage);
  controller.setBinding(binding);
  controller.cycle();
  const replacement = { ...binding, code: 'KeyR', ctrlKey: true };
  controller.setBinding(replacement);
  assert.equal(controller.mode(), 'opt');
  assert.equal(controller.handleKey(key(), false), false);
  assert.equal(controller.mode(), 'opt');
  assert.equal(controller.handleKey(key(replacement), false), true);
  assert.equal(controller.mode(), 'best');
  assert.deepEqual(createReferenceController(storage).binding(), replacement);
});

test('configured key cycles even when HUD placement is locked', () => {
  const controller = createReferenceController(new MemoryStorage());
  controller.setBinding(binding);
  assert.equal(controller.handleKey(key(), true), true);
  assert.equal(controller.mode(), 'opt');
});

for (const [description, input] of [
  ['a repeated key', key({ repeat: true })],
  ['an input target', key({ target: { tagName: 'INPUT', isContentEditable: false } })],
  ['a textarea target', key({ target: { tagName: 'TEXTAREA', isContentEditable: false } })],
  ['a select target', key({ target: { tagName: 'SELECT', isContentEditable: false } })],
  ['a contenteditable target', key({ target: { tagName: 'DIV', isContentEditable: true } })],
  ['the wrong key', key({ code: 'KeyQ' })],
  ['an extra modifier', key({ ctrlKey: true })],
  ['a missing modifier', key({ altKey: false })],
] as const) {
  test(`reference hotkey ignores ${description} without persisting a mode change`, () => {
    const storage = new MemoryStorage();
    const controller = createReferenceController(storage);
    controller.setBinding(binding);
    const writesBefore = storage.writes.length;
    assert.equal(controller.handleKey(input, false), false);
    assert.equal(controller.mode(), 'off');
    assert.equal(storage.writes.length, writesBefore);
  });
}

for (const mode of ['opt', 'best'] as const) {
  test(`sector panel and delta share the selected ${mode} lap snapshot`, () => {
    const options = viewOptions({ mode });
    const view = createTimingView(options);
    assert.equal(view.panel.visible, true);
    assert.equal(view.delta.visible, true);
    assert.equal(view.panel.preview, false);
    assert.equal(view.delta.preview, false);
    assert.deepEqual(view.panel.reference, options.snapshot[mode]);
    assert.deepEqual(view.delta.reference, options.snapshot[mode]);
    // At .75 overall distance, sector 2 local fraction is .5. Its
    // nonlinear fixture curve is at 40% of that sector's duration.
    assert.equal(view.delta.valueUs, mode === 'best' ? 40_000 : 180_000);
  });
}

test('Off hides both widgets and supplies no comparison delta', () => {
  const view = createTimingView(viewOptions({ mode: 'off' }));
  assert.equal(view.panel.visible, false);
  assert.equal(view.delta.visible, false);
  assert.equal(view.delta.valueUs, null);
});

test('a missing selected Opt reference does not silently fall back to Best', () => {
  const records = snapshot();
  records.opt = null;
  const view = createTimingView(viewOptions({ mode: 'opt', snapshot: records }));
  assert.equal(view.panel.reference, null);
  assert.equal(view.delta.reference, null);
  assert.equal(view.delta.valueUs, null);
});

test('delta uses the shared snapshot at exact custom-sector boundaries', () => {
  const view = createTimingView(viewOptions({ distanceFraction: 0.5, lapElapsedUs: 650_000 }));
  assert.equal(view.delta.valueUs, 50_000);
});

test('panel and delta can be enabled independently', () => {
  const panelOnly = createTimingView(viewOptions({ deltaEnabled: false }));
  assert.equal(panelOnly.panel.visible, true);
  assert.equal(panelOnly.delta.visible, false);
  const deltaOnly = createTimingView(viewOptions({ panelEnabled: false }));
  assert.equal(deltaOnly.panel.visible, false);
  assert.equal(deltaOnly.delta.visible, true);
});

test('layout editing gives both hidden widgets placement previews without a real delta', () => {
  const view = createTimingView(viewOptions({
    mode: 'off', panelEnabled: false, deltaEnabled: false, editing: true,
  }));
  assert.equal(view.panel.visible, true);
  assert.equal(view.delta.visible, true);
  assert.equal(view.panel.preview, true);
  assert.equal(view.delta.preview, true);
  assert.equal(view.delta.valueUs, null);
});
