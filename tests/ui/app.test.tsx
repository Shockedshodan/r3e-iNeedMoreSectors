import './dom.ts';
import React from 'react';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { createHudApplication } from '../../src/application.ts';
import { createLayoutController } from '../../src/ui/layout.ts';
import { HudApp, SectorPanelWidget, SavedDeltaWidget } from '../../src/ui/App.tsx';
import { definition, frame, MemoryStorage } from '../helpers.ts';
import type { TimingFrame } from '../../src/contracts.ts';

afterEach(cleanup);

function setup() {
  let receive: ((frame: TimingFrame) => void) | undefined;
  const application = createHudApplication({
    storage: new MemoryStorage(),
    bridge: { connect(listener) { receive = listener; return () => { receive = undefined; }; } },
    resolveDefinition: () => definition,
    discoverModules: ({ timing }) => [timing],
    components: { panel: SectorPanelWidget, delta: SavedDeltaWidget },
  });
  const layout = createLayoutController(new MemoryStorage(), application.widgets());
  render(<HudApp application={application} layout={layout} connection="Waiting for telemetry" demo={false} />);
  act(() => receive?.(frame()));
  return { application, layout };
}

test('real settings open and mode action cycles both rendered widgets', () => {
  const { application } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Cycle reference' }));
  assert.equal(application.getSnapshot().mode, 'opt');
  assert.ok(screen.getByTestId('timing-sectors'));
  assert.ok(screen.getByTestId('timing-delta'));
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  assert.ok(screen.getByRole('dialog', { name: 'HUD settings' }));
  assert.ok(screen.getByRole('checkbox', { name: 'Show sector panel' }));
});

test('DOM hotkey ignores editable targets and repeat but works while layout is locked', () => {
  const { application } = setup();
  fireEvent.keyDown(window, { key: 't', code: 'KeyT', altKey: true, repeat: true });
  assert.equal(application.getSnapshot().mode, 'off');
  const input = document.createElement('input');
  document.body.append(input);
  fireEvent.keyDown(input, { key: 't', code: 'KeyT', altKey: true });
  input.remove();
  assert.equal(application.getSnapshot().mode, 'off');
  fireEvent.click(screen.getByRole('button', { name: 'Lock layout' }));
  fireEvent.keyDown(window, { key: 't', code: 'KeyT', altKey: true });
  assert.equal(application.getSnapshot().mode, 'opt');
});

test('settings rebind the real controller without firing the newly captured key', () => {
  const { application } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Hotkey' }), { key: 'r', code: 'KeyR', ctrlKey: true });
  assert.equal(application.getSnapshot().binding.code, 'KeyR');
  assert.equal(application.getSnapshot().mode, 'off');
  fireEvent.keyDown(window, { key: 'r', code: 'KeyR', ctrlKey: true });
  assert.equal(application.getSnapshot().mode, 'opt');
});

test('settings visibility, edit previews and profile selection use the layout controller', () => {
  const { application, layout } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show delta' }));
  assert.equal(layout.getState().widgets['timing.delta'].enabled, false);
  fireEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
  assert.equal(layout.getState().editing, true);
  assert.equal(application.getSnapshot().view.delta.preview, true);
  assert.ok(screen.getByTestId('timing-delta'));
  fireEvent.change(screen.getByRole('combobox', { name: 'Layout profile' }), { target: { value: '2' } });
  assert.equal(layout.getState().profile, 2);
});

test('live saving gate is visible and keyboard listeners are removed on unmount', () => {
  const { application } = setup();
  assert.match(screen.getByTestId('recording-status').textContent!, /not yet validated|disabled/i);
  cleanup();
  fireEvent.keyDown(window, { key: 't', code: 'KeyT', altKey: true });
  assert.equal(application.getSnapshot().mode, 'off');
});
