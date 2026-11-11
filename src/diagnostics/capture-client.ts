import type { CaptureAnnotation, CaptureHeader, CaptureManifest } from './capture-format.ts';
import { parseCaptureRow, projectRawTelemetry } from './capture-format.ts';
import type { BridgeIngressEvent } from '../telemetry/websocket-bridge.ts';
import { createCaptureRecorder } from './recorder.ts';
import type { CaptureRecorder } from './recorder.ts';
export type { CaptureManifest } from './capture-format.ts';

export interface CaptureStartMetadata {
  source: 'live' | 'synthetic';
  gameVersion: string;
  bridgeVersion: string;
  browser: string;
  pollMs?: number;
}
export interface CaptureClientState {
  status: 'idle' | 'starting' | 'recording' | 'stopping' | 'complete' | 'incomplete';
  captureId: string | null;
  eventCount: number;
  bytes: number;
  reason: string | null;
  outputPath: string | null;
  manifest: CaptureManifest | null;
}
export interface CaptureClient {
  start(metadata: CaptureStartMetadata): Promise<void>;
  stop(): Promise<CaptureManifest>;
  recordIngress(event: BridgeIngressEvent): void;
  annotate(annotation: CaptureAnnotation): void;
  getState(): CaptureClientState;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
export function createCaptureClient(options: { fetch?: typeof fetch; nowMs?: () => number; baseUrl?: string } = {}): CaptureClient {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const nowMs = options.nowMs ?? (() => performance.now());
  const base = (options.baseUrl ?? '').replace(/\/$/, '');
  const listeners = new Set<() => void>();
  let state: CaptureClientState = Object.freeze({
    status: 'idle', captureId: null, eventCount: 0, bytes: 0,
    reason: null, outputPath: null, manifest: null,
  });
  let recorder: CaptureRecorder | null = null;
  let unsubscribeRecorder: (() => void) | null = null;
  let header: CaptureHeader | null = null;
  let finishPromise: Promise<CaptureManifest> | null = null;
  let finishing = false;
  let disposed = false;
  let batchIndex = 0;
  let openConnection: number | null = null;

  function publish(changes: Partial<CaptureClientState>): void {
    state = Object.freeze({ ...state, ...changes });
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* Observer failures cannot stop capture. */ }
    }
  }

  async function post(path: string, body: unknown, retry = false): Promise<unknown> {
    let response: Response;
    const init: RequestInit = {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    };
    try {
      response = await request(base + path, init);
    } catch (error) {
      if (!retry) throw error;
      // Exact same serialized body/index makes a lost-response retry idempotent.
      response = await request(base + path, init);
    }
    if (!response.ok) throw new Error(`Capture request failed (${response.status})`);
    return response.json();
  }

  function manifestFrom(value: unknown): CaptureManifest {
    if (!value || typeof value !== 'object') throw new Error('Invalid durable capture manifest');
    const manifest = value as CaptureManifest;
    if (manifest.version !== 1 || manifest.captureId !== state.captureId
      || manifest.source !== header?.source || typeof manifest.complete !== 'boolean'
      || !Number.isSafeInteger(manifest.byteCount) || manifest.byteCount < 0
      || !Number.isSafeInteger(manifest.eventCount) || manifest.eventCount < 0
      || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.sha256)
      || typeof manifest.outputPath !== 'string'
      || !Array.isArray(manifest.problems) || !manifest.problems.every(problem => typeof problem === 'string')) {
      throw new Error('Invalid durable capture manifest');
    }
    return Object.freeze({ ...manifest, problems: Object.freeze([...manifest.problems]) }) as CaptureManifest;
  }

  function finish(reason = 'stopped'): Promise<CaptureManifest> {
    if (finishPromise) return finishPromise;
    if (!recorder || !state.captureId) return Promise.reject(new Error('No active capture to finish'));
    const current = recorder;
    const captureId = state.captureId;
    finishing = true;
    publish({ status: 'stopping' });
    finishPromise = (async () => {
      try {
        const footer = await current.stop(reason);
        const value = await post(`/api/capture/${encodeURIComponent(captureId)}/finish`, {
          complete: footer.complete, reason: footer.reason,
        });
        const manifest = manifestFrom(value);
        if (manifest.complete && !footer.complete) throw new Error('Server reported complete data after an incomplete recorder stop');
        publish({
          status: manifest.complete ? 'complete' : 'incomplete', manifest,
          outputPath: manifest.outputPath, reason: manifest.complete ? null : footer.reason || manifest.problems.join('; '),
        });
        return manifest;
      } catch (error) {
        publish({ status: 'incomplete', manifest: null, reason: error instanceof Error ? error.message : 'Capture completion could not be confirmed' });
        finishPromise = null;
        throw error;
      } finally {
        finishing = false;
      }
    })();
    return finishPromise;
  }

  return {
    async start(metadata) {
      if (disposed) throw new Error('Capture client has been disposed');
      if (['starting', 'recording', 'stopping'].includes(state.status)
        || (state.captureId !== null && state.manifest === null)) throw new Error('A capture is already active or awaiting durable completion');
      unsubscribeRecorder?.();
      recorder = null;
      finishPromise = null;
      finishing = false;
      batchIndex = 0;
      header = null;
      publish({ status: 'starting', captureId: null, manifest: null, outputPath: null, reason: null, eventCount: 0, bytes: 0 });
      try {
        const result = await post('/api/capture/start', metadata);
        if (!result || typeof result !== 'object') throw new Error('Invalid capture start response');
        const value = result as { captureId?: unknown; header?: unknown; outputPath?: unknown };
        const parsed = parseCaptureRow(value.header);
        if (parsed.kind !== 'header' || value.captureId !== parsed.captureId || parsed.source !== metadata.source
          || typeof value.outputPath !== 'string') throw new Error('Invalid capture header or source');
        header = parsed;
        publish({ captureId: parsed.captureId, outputPath: value.outputPath });
        const captureId = parsed.captureId;
        recorder = createCaptureRecorder({
          nowMs,
          sink: {
            async write(lines) {
              const index = batchIndex;
              const accepted = await post(`/api/capture/${encodeURIComponent(captureId)}/batch`, { batchIndex: index, lines }, true);
              if (!accepted || typeof accepted !== 'object' || (accepted as { accepted?: unknown }).accepted !== true
                || (accepted as { batchIndex?: unknown }).batchIndex !== index) throw new Error('Capture batch was not acknowledged');
              batchIndex += 1;
            },
          },
        });
        const current = recorder;
        unsubscribeRecorder = current.subscribe(() => {
          const recording = current.getState();
          publish({
            status: finishing ? 'stopping' : recording.status === 'idle' ? 'starting' : recording.status === 'complete' ? 'stopping' : recording.status,
            eventCount: recording.eventCount, bytes: recording.bytes,
            reason: recording.reason,
          });
          if (!finishing && recording.status === 'incomplete') {
            void finish(recording.reason ?? 'incomplete').catch(() => {});
          }
        });
        current.start(parsed);
        if (openConnection !== null) current.record({ type: 'open', connectionId: openConnection, reason: 'already-open' }, nowMs());
        if (disposed) {
          await finish('aborted');
          throw new Error('Capture client was disposed while starting');
        }
      } catch (error) {
        publish({ status: 'incomplete', reason: error instanceof Error ? error.message : 'Capture could not start' });
        throw error;
      }
    },
    stop: () => finish(),
    recordIngress(event) {
      if (event.type === 'open' || event.type === 'message') openConnection = event.connectionId;
      else if ((event.type === 'close' || event.type === 'error') && event.connectionId === openConnection) openConnection = null;
      if (disposed || state.status !== 'recording' || !recorder) return;
      try {
        const { atMs, data, ...input } = event;
        recorder.record(event.type === 'message' ? { ...input, data: projectRawTelemetry(data) } : input, atMs);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Invalid diagnostic observation';
        publish({ reason, status: 'incomplete' });
        void finish('invalid-event').catch(() => {});
      }
    },
    annotate(annotation) {
      if (disposed || state.status !== 'recording' || !recorder) throw new Error('Annotations require an active capture');
      recorder.record({ type: 'annotation', connectionId: openConnection ?? 0, annotation }, nowMs());
    },
    getState: () => state,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (recorder && state.manifest === null && state.captureId !== null) void finish('aborted').catch(() => {});
      listeners.clear();
    },
  };
}
