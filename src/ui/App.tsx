import React, { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { HudApplication } from '../application.ts';
import type { KeyBinding, KeyInput } from '../contracts.ts';
import type { LayoutController, LayoutProfile } from './layout.ts';
import { WidgetFrame } from './WidgetFrame.tsx';
import { SectorPanel, DeltaWidget } from './TimingWidgets.tsx';

const ApplicationContext = createContext<HudApplication | null>(null);
const TelemetryActiveContext = createContext(true);

function useApplicationSnapshot() {
  const application = useContext(ApplicationContext);
  if (!application) throw new Error('Timing widgets require the HUD application');
  return useSyncExternalStore(application.subscribe, application.getSnapshot);
}

function bindingLabel(binding: KeyBinding): string {
  return [binding.ctrlKey && 'Ctrl', binding.altKey && 'Alt', binding.shiftKey && 'Shift', binding.metaKey && 'Meta',
    binding.code.replace(/^Key/, '').replace(/^Digit/, '')].filter(Boolean).join('+');
}

function keyInput(event: KeyboardEvent): KeyInput {
  const target = event.composedPath()[0] ?? event.target;
  return {
    code: event.code, ctrlKey: event.ctrlKey, altKey: event.altKey,
    shiftKey: event.shiftKey, metaKey: event.metaKey, repeat: event.repeat,
    target: target instanceof HTMLElement ? { tagName: target.tagName, isContentEditable: target.isContentEditable } : null,
  };
}

export interface HudAppProps {
  application: HudApplication;
  layout: LayoutController;
  connection: string;
  demo: boolean;
  track?: string;
  activeTelemetry?: boolean;
}

export function HudApp({ application, layout, connection, demo, track, activeTelemetry = true }: HudAppProps): React.ReactElement {
  const snapshot = useSyncExternalStore(application.subscribe, application.getSnapshot);
  const placement = useSyncExternalStore(layout.subscribe, layout.getState);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const widgets = application.widgets();

  useEffect(() => {
    application.setEditing(placement.editing);
    if (placement.widgets['timing.sectors']) application.setWidgetEnabled('panel', placement.widgets['timing.sectors'].enabled);
    if (placement.widgets['timing.delta']) application.setWidgetEnabled('delta', placement.widgets['timing.delta'].enabled);
  }, [application, placement.editing, placement.widgets]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent): void {
      if (event.isComposing) return;
      if (application.handleKey(keyInput(event), layout.getState().locked)) event.preventDefault();
    }
    window.addEventListener('keydown', handleKey);
    return () => { window.removeEventListener('keydown', handleKey); };
  }, [application, layout]);

  const widgetLabel = (id: string) => id === 'timing.sectors' ? 'sector panel' : id === 'timing.delta' ? 'delta' : id;
  return <ApplicationContext.Provider value={application}>
    <TelemetryActiveContext.Provider value={activeTelemetry}>
    <div className={`hud-shell${placement.editing ? ' is-editing' : ''}`}>
      <header className="hud-toolbar">
        <div className="hud-brand"><span className="hud-brand-mark">R3E</span><strong>iNeedMoreSectors</strong></div>
        <nav aria-label="HUD controls">
          <button aria-label="Cycle reference" onClick={() => application.cycleReference()} className="reference-button">
            <span>Reference</span> <strong>{snapshot.mode === 'off' ? 'Off' : snapshot.mode === 'opt' ? 'Opt' : 'Best'}</strong>
          </button>
          <button aria-label="Edit layout" aria-pressed={placement.editing} onClick={() => layout.setEditing(!placement.editing)}>Edit layout</button>
          <button aria-label="Lock layout" aria-pressed={placement.locked} onClick={() => layout.setLocked(!placement.locked)}>{placement.locked ? 'Locked' : 'Lock layout'}</button>
          <button aria-label="Settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}>Settings</button>
        </nav>
      </header>
      <div className="hud-status">
        <span data-testid="connection-status">{connection}</span>
        {track && <span>{track}</span>}
        <span data-testid="recording-status" className={demo ? 'demo-status' : 'live-status'}>
          {demo ? 'Demo · records saved separately' : 'Live record saving disabled — telemetry timing is not yet validated'}
        </span>
      </div>
      {placement.editing && <p className="edit-instructions">Drag widgets to place them. Scroll to scale; hold Shift for larger steps. {placement.locked && 'Unlock the layout to make changes.'}</p>}
      <main className="hud-canvas" aria-label="Timing HUD">
        {widgets.map(descriptor => {
          const state = placement.widgets[descriptor.id];
          if (!state) return null;
          const Component = descriptor.component as React.ElementType;
          return <WidgetFrame key={descriptor.id} descriptor={descriptor} state={state}
            editing={placement.editing} locked={placement.locked}
            onPosition={position => layout.setPosition(descriptor.id, position)}
            onScale={scale => layout.setScale(descriptor.id, scale)}>
            <Component />
          </WidgetFrame>;
        })}
      </main>
      {settingsOpen && <section className="hud-settings" role="dialog" aria-label="HUD settings">
        <div className="settings-heading"><h1>HUD settings</h1><button onClick={() => setSettingsOpen(false)} aria-label="Close settings">×</button></div>
        <p className="settings-intro">Both timing widgets compare against the same saved reference. Recording continues when they are hidden.</p>
        <label>Hotkey<input aria-label="Hotkey" readOnly value={bindingLabel(snapshot.binding)} onKeyDown={event => {
          if (event.key === 'Tab') return;
          event.preventDefault(); event.stopPropagation();
          if (event.repeat || !event.code || /^(Shift|Alt|Control|Meta)(Left|Right)$/.test(event.code)) return;
          application.setBinding({ code: event.code, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey });
        }} /></label>
        <p className="field-help">Focus the hotkey field and press a key combination.</p>
        <label>Layout profile<select aria-label="Layout profile" value={placement.profile}
          onChange={event => layout.setProfile(Number(event.target.value) as LayoutProfile)}>
          {[1, 2, 3].map(profile => <option key={profile} value={profile}>Layout {profile}</option>)}
        </select></label>
        <label>Filter widgets<input aria-label="Filter widgets" value={filter} onChange={event => setFilter(event.target.value)} /></label>
        <fieldset><legend>Widget visibility</legend>
          {widgets.filter(widget => widgetLabel(widget.id).toLowerCase().includes(filter.toLowerCase())).map(widget =>
            <label className="widget-checkbox" key={widget.id}><input type="checkbox" checked={placement.widgets[widget.id].enabled}
              onChange={event => layout.setEnabled(widget.id, event.target.checked)} />Show {widgetLabel(widget.id)}</label>)}
        </fieldset>
        <button className="reset-layout" onClick={() => layout.resetProfile()}>Reset layout</button>
      </section>}
    </div>
    </TelemetryActiveContext.Provider>
  </ApplicationContext.Provider>;
}
export function SectorPanelWidget(): React.ReactNode {
  const snapshot = useApplicationSnapshot();
  return <SectorPanel view={snapshot.view.panel} mode={snapshot.mode} boundaries={snapshot.records?.boundaries} />;
}
export function SavedDeltaWidget(): React.ReactNode {
  const snapshot = useApplicationSnapshot();
  const active = useContext(TelemetryActiveContext);
  return <DeltaWidget view={active ? snapshot.view.delta : { ...snapshot.view.delta, valueUs: null }} mode={snapshot.mode} />;
}
