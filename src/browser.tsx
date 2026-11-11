// Required by core code on older embedded Chromium. Actual in-game support is
// still a live acceptance check; these polyfills are tested independently.
import 'core-js/actual/array/at';
import 'core-js/actual/object/from-entries';
import 'core-js/actual/structured-clone';
import 'core-js/actual/aggregate-error';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createHudApplication } from './application.ts';
import { discoverModules } from './discover-modules.ts';
import { createLayoutDefinitionRegistry } from './layout-definitions.ts';
import { createRaceRoomAdapter } from './telemetry/raceroom-adapter.ts';
import { createRaceRoomBridge } from './telemetry/websocket-bridge.ts';
import { createCaptureClient } from './diagnostics/capture-client.ts';
import type { CaptureClient } from './diagnostics/capture-client.ts';
import { createLayoutController } from './ui/layout.ts';
import { HudApp, SectorPanelWidget, SavedDeltaWidget } from './ui/App.tsx';
import type { StorageLike } from './contracts.ts';
import type { AdaptedTelemetry } from './telemetry/raceroom-adapter.ts';
import './ui/app.css';
import './ui/timing-widgets.css';

const parameters = new URLSearchParams(window.location.search);
const demo = parameters.get('demo') === '1';
const prefix = demo ? 'r3e-sectors:demo:' : '';
// Access storage inside the methods, since the localStorage getter itself can
// throw when browser privacy settings deny it. Repositories handle that error.
const storage: StorageLike = {
  getItem: key => window.localStorage.getItem(prefix + key),
  setItem: (key, value) => window.localStorage.setItem(prefix + key, value),
};
const definitions = createLayoutDefinitionRegistry(storage);
const adapter = createRaceRoomAdapter({ enableRecordWrites: demo });
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing HUD root');
const root = createRoot(rootElement);
let latest: AdaptedTelemetry | null = null;
let connection = 'Waiting for RaceRoom practice telemetry';
let activeTelemetry = false;
let refresh: (() => void) | null = null;
let disposeApplication: (() => void) | null = null;
let captureClient: CaptureClient | null = null;

function bridgeUrl(): string {
  const override = parameters.get('ws');
  if (!override) return 'ws://localhost:8070/r3e';
  const value = new URL(override.includes('://') ? override : `ws://${override}`);
  if (!['ws:', 'wss:'].includes(value.protocol) || value.username || value.password || value.search || value.hash) {
    throw new Error('WebSocket address must use ws:// or wss:// without credentials or query parameters');
  }
  if (value.pathname === '/') value.pathname = '/r3e';
  return value.href;
}

try {
  const captureClock = () => performance.now();
  if (parameters.get('capture') === '1') captureClient = createCaptureClient({ nowMs: captureClock });
  const bridge = createRaceRoomBridge({
    url: bridgeUrl(), adapter,
    clock: captureClock,
    onIngress: captureClient ? event => captureClient?.recordIngress(event) : undefined,
    onObservation(observation) { latest = observation; refresh?.(); },
    onStatus(status) {
      activeTelemetry = status.startsWith('Fixture recording enabled') || status.startsWith('Connected; live record writes disabled');
      connection = status.startsWith('Fixture recording enabled') ? 'Demo telemetry connected'
        : status.startsWith('Connected; live record writes disabled') ? 'RaceRoom practice connected' : status;
      refresh?.();
    },
  });
  const application = createHudApplication({
    storage, bridge, discoverModules,
    resolveDefinition(frame) {
      if (!latest || latest.frame.layoutId !== frame.layoutId) return null;
      return definitions.resolve(frame.layoutId, latest.layoutLengthM);
    },
    components: { panel: SectorPanelWidget, delta: SavedDeltaWidget },
  });
  disposeApplication = () => application.dispose();
  const layout = createLayoutController(storage, application.widgets());
  refresh = () => root.render(<HudApp application={application} layout={layout} demo={demo}
    connection={connection} activeTelemetry={activeTelemetry}
    captureClient={captureClient ?? undefined}
    track={latest ? [latest.trackName, latest.layoutName].filter(Boolean).join(' · ') : undefined} />);
  refresh();
  window.addEventListener('pagehide', () => {
    captureClient?.dispose(); application.dispose(); disposeApplication = null; root.unmount();
  }, { once: true });
} catch (error) {
  try { captureClient?.dispose(); } catch { /* Diagnostic cleanup must preserve the startup error. */ }
  try { disposeApplication?.(); } catch { /* Cleanup must not conceal the startup error. */ }
  disposeApplication = null;
  refresh = null;
  root.render(<main className="startup-error"><h1>HUD could not start</h1><p>{error instanceof Error ? error.message : 'Invalid HUD configuration'}</p></main>);
}
