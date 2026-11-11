import type { TelemetryBridge, TimingFrame } from '../contracts.ts';
import type { AdaptedTelemetry, RaceRoomAdapter } from './raceroom-adapter.ts';
import { createRaceRoomAdapter } from './raceroom-adapter.ts';

export interface RaceRoomSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface RaceRoomBridgeOptions {
  url?: string;
  adapter?: RaceRoomAdapter;
  onObservation?: (observation: AdaptedTelemetry) => void;
  onStatus?: (status: string) => void;
  socketFactory?: (url: string) => RaceRoomSocket;
  pollMs?: number;
  reconnectMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface RaceRoomBridge extends TelemetryBridge {
  latest(): AdaptedTelemetry | null;
  status(): string;
}

export function createRaceRoomBridge(options: RaceRoomBridgeOptions = {}): RaceRoomBridge {
  const address = options.url ?? 'ws://localhost:8070/r3e';
  let parsed: URL;
  try { parsed = new URL(address); } catch { throw new RangeError('Invalid telemetry WebSocket URL'); }
  if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new RangeError('Telemetry requires a ws/wss URL without embedded credentials');
  }
  const pollMs = options.pollMs ?? 16;
  const reconnectMs = options.reconnectMs ?? 1000;
  if (!Number.isFinite(pollMs) || pollMs <= 0 || !Number.isFinite(reconnectMs) || reconnectMs <= 0) {
    throw new RangeError('Polling and reconnect intervals must be positive and finite');
  }
  const adapter = options.adapter ?? createRaceRoomAdapter();
  const socketFactory = options.socketFactory ?? (url => new WebSocket(url) as unknown as RaceRoomSocket);
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const listeners = new Set<{ receive: (frame: TimingFrame) => void }>();
  let socket: RaceRoomSocket | null = null;
  let pollTimer: unknown = null;
  let reconnectTimer: unknown = null;
  let latest: AdaptedTelemetry | null = null;
  let state = 'Disconnected';

  function status(value: string): void {
    state = value;
    options.onStatus?.(value);
  }

  function clearTimers(): void {
    if (pollTimer !== null) cancel(pollTimer);
    if (reconnectTimer !== null) cancel(reconnectTimer);
    pollTimer = null;
    reconnectTimer = null;
  }

  function detach(): void {
    const old = socket;
    socket = null;
    if (old === null) return;
    old.onopen = null;
    old.onmessage = null;
    old.onclose = null;
    old.onerror = null;
    try { old.close(); } catch { /* The socket may have already failed. */ }
  }

  function reconnect(): void {
    clearTimers();
    detach();
    latest = null;
    adapter.reset();
    if (listeners.size === 0) { status('Disconnected'); return; }
    status('Reconnecting to telemetry bridge');
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      if (listeners.size > 0) open();
    }, reconnectMs);
  }

  function open(): void {
    if (listeners.size === 0 || socket !== null) return;
    status('Connecting to telemetry bridge');
    let current: RaceRoomSocket;
    try { current = socketFactory(address); } catch { reconnect(); return; }
    socket = current;

    function poll(): void {
      pollTimer = null;
      if (socket !== current || listeners.size === 0) return;
      if (current.readyState === 1) {
        try { current.send(''); } catch { reconnect(); return; }
      }
      pollTimer = schedule(poll, pollMs);
    }

    current.onopen = () => {
      if (socket !== current || listeners.size === 0) return;
      if (pollTimer !== null) cancel(pollTimer);
      status('Connected to telemetry bridge');
      poll();
    };
    current.onmessage = event => {
      if (socket !== current || listeners.size === 0) return;
      let observation: AdaptedTelemetry | null;
      try {
        if (typeof event.data !== 'string') throw new TypeError('Expected JSON text');
        observation = adapter.adapt(JSON.parse(event.data));
      } catch {
        adapter.reset();
        latest = null;
        status('Malformed telemetry message');
        return;
      }
      if (!observation) {
        latest = null;
        status(adapter.status());
        return;
      }
      latest = observation;
      status(adapter.status());
      // Runtime can establish the layout/module before dispatching this frame.
      options.onObservation?.(observation);
      for (const listener of [...listeners]) {
        if (socket !== current) break;
        if (listeners.has(listener)) listener.receive(observation.frame);
      }
    };
    current.onclose = () => { if (socket === current) reconnect(); };
    current.onerror = () => { if (socket === current) reconnect(); };
    if (current.readyState === 1) current.onopen();
  }

  return {
    connect(receive) {
      if (typeof receive !== 'function') throw new TypeError('A telemetry frame listener is required');
      const listener = { receive };
      listeners.add(listener);
      if (listeners.size === 1) open();
      let disconnected = false;
      return () => {
        if (disconnected) return;
        disconnected = true;
        listeners.delete(listener);
        if (listeners.size === 0) {
          clearTimers();
          detach();
          adapter.reset();
          latest = null;
          status('Disconnected');
        }
      };
    },
    latest: () => latest,
    status: () => state,
  };
}
