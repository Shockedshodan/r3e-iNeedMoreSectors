import type { TelemetryBridge, TimingFrame } from '../contracts.ts';
import type { AdaptedTelemetry, RaceRoomAdapter } from './raceroom-adapter.ts';
import { createRaceRoomAdapter } from './raceroom-adapter.ts';
import { projectRawTelemetry } from '../diagnostics/capture-format.ts';

/** Timing-only projection from the receive boundary, before adaptation. */
export interface BridgeIngressEvent {
  type: 'open' | 'close' | 'error' | 'message' | 'malformed';
  connectionId: number;
  atMs: number;
  data?: unknown;
  byteLength?: number;
  messageType?: string;
  reason?: string;
}

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
  onIngress?: (event: BridgeIngressEvent) => void;
  clock?: () => number;
}

export interface RaceRoomBridge extends TelemetryBridge {
  latest(): AdaptedTelemetry | null;
  status(): string;
}

function payloadSize(value: unknown): number | undefined {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
  return undefined;
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
  const clock = options.clock ?? (() => performance.now());
  const listeners = new Set<{ receive: (frame: TimingFrame) => void }>();
  let socket: RaceRoomSocket | null = null;
  let pollTimer: unknown = null;
  let reconnectTimer: unknown = null;
  let latest: AdaptedTelemetry | null = null;
  let state = 'Disconnected';
  let connectionId = 0;

  function ingress(event: BridgeIngressEvent): void {
    if (!options.onIngress) return;
    let projected = event;
    if (event.type === 'message') {
      try {
        // Projection creates independent nested values, so observers can neither
        // expose unrelated driver data nor mutate the adapter's input object.
        projected = { ...event, data: projectRawTelemetry(event.data) };
      } catch {
        // JSON permits exponents that parse to Infinity, which cannot be
        // faithfully written back to JSONL. Retain an explicit rejection event
        // instead of silently losing the observation or coercing it to null.
        const { data: _omitted, ...metadata } = event;
        projected = { ...metadata, type: 'malformed', reason: 'projection-unrepresentable' };
      }
    }
    try {
      options.onIngress(projected);
    } catch {
      // Diagnostic collection must never alter the ordinary telemetry path.
    }
  }

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
    const currentId = ++connectionId;
    try { current = socketFactory(address); } catch {
      ingress({ type: 'error', connectionId: currentId, atMs: clock(), reason: 'socket-construction-failed' });
      reconnect(); return;
    }
    socket = current;
    let opened = false;

    function poll(): void {
      pollTimer = null;
      if (socket !== current || listeners.size === 0) return;
      if (current.readyState === 1) {
        try { current.send(''); } catch {
          ingress({ type: 'error', connectionId: currentId, atMs: clock(), reason: 'poll-send-failed' });
          reconnect(); return;
        }
      }
      pollTimer = schedule(poll, pollMs);
    }

    current.onopen = () => {
      if (socket !== current || listeners.size === 0 || opened) return;
      opened = true;
      if (pollTimer !== null) cancel(pollTimer);
      ingress({ type: 'open', connectionId: currentId, atMs: clock() });
      status('Connected to telemetry bridge');
      poll();
    };
    current.onmessage = event => {
      if (socket !== current || listeners.size === 0) return;
      const atMs = clock();
      const messageType = typeof event.data;
      const byteLength = options.onIngress ? payloadSize(event.data) : undefined;
      let raw: unknown;
      try {
        if (typeof event.data !== 'string') throw new TypeError('Expected JSON text');
        raw = JSON.parse(event.data);
      } catch {
        ingress({ type: 'malformed', connectionId: currentId, atMs, messageType, byteLength, reason: 'Expected valid JSON text' });
        adapter.reset();
        latest = null;
        status('Malformed telemetry message');
        return;
      }
      ingress({ type: 'message', connectionId: currentId, atMs, data: raw, messageType, byteLength });
      let observation: AdaptedTelemetry | null;
      try {
        observation = adapter.adapt(raw);
      } catch {
        ingress({ type: 'error', connectionId: currentId, atMs, reason: 'Adapter rejected a malformed observation' });
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
    current.onclose = () => {
      if (socket === current) {
        ingress({ type: 'close', connectionId: currentId, atMs: clock() });
        reconnect();
      }
    };
    current.onerror = () => {
      if (socket === current) {
        ingress({ type: 'error', connectionId: currentId, atMs: clock(), reason: 'socket-error' });
        reconnect();
      }
    };
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
          if (socket) ingress({ type: 'close', connectionId, atMs: clock(), reason: 'disposed' });
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
