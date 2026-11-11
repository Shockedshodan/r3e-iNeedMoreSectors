import type { CaptureEvent, CaptureFooter, CaptureHeader } from './capture-format.ts';
import { parseCaptureRow, projectRawTelemetry } from './capture-format.ts';

export interface CaptureSink { write(lines: string): Promise<void> }
export interface CaptureRecorderState {
  status: 'idle' | 'recording' | 'stopping' | 'complete' | 'incomplete';
  eventCount: number;
  bytes: number;
  queueBytes: number;
  reason: string | null;
}
export type CaptureInput = Omit<CaptureEvent, 'kind' | 'seq' | 'tMs'>;
export interface CaptureRecorder {
  start(header: CaptureHeader): void;
  record(event: CaptureInput, atMs?: number): void;
  stop(reason?: string): Promise<CaptureFooter>;
  getState(): CaptureRecorderState;
  subscribe(listener: () => void): () => void;
}
export function createCaptureRecorder(options: {
  sink: CaptureSink;
  nowMs: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  flushIntervalMs?: number;
}): CaptureRecorder {
  const encoder = new TextEncoder();
  const listeners = new Set<() => void>();
  const schedule = options.schedule ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer;
  });
  const cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const reserveBytes = 512;
  const flushInterval = options.flushIntervalMs ?? 100;
  if (!Number.isFinite(flushInterval) || flushInterval <= 0) throw new RangeError('Flush interval must be positive');
  let state: CaptureRecorderState = Object.freeze({ status: 'idle', eventCount: 0, bytes: 0, queueBytes: 0, reason: null });
  let header: CaptureHeader;
  let startTime = 0;
  let lastTime = 0;
  let queue: { line: string; size: number }[] = [];
  let queuedBytes = 0;
  let inFlightBytes = 0;
  let totalBytes = 0;
  let eventCount = 0;
  let lossCount = 0;
  let highWater = 0;
  let timer: unknown = null;
  let flushTimer: unknown = null;
  let failed = false;
  let pumping: Promise<void> | null = null;
  let stopping: Promise<CaptureFooter> | null = null;
  let stopReason = 'stopped';

  function publish(changes: Partial<CaptureRecorderState> = {}): void {
    highWater = Math.max(highWater, queuedBytes + inFlightBytes);
    state = Object.freeze({ ...state, eventCount, bytes: totalBytes, queueBytes: queuedBytes + inFlightBytes, ...changes });
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* UI observers cannot interrupt telemetry or capture. */ }
    }
  }

  function pump(): void {
    if (pumping || failed || queue.length === 0) return;
    pumping = (async () => {
      // Keep record() synchronous and telemetry independent from sink latency.
      await Promise.resolve();
      while (queue.length > 0 && !failed) {
        const batch: string[] = [];
        let size = 0;
        while (queue.length > 0 && size + queue[0].size <= header.limits.batchBytes) {
          const item = queue.shift()!;
          queuedBytes -= item.size;
          size += item.size;
          batch.push(item.line);
        }
        if (batch.length === 0) { failed = true; stopReason = 'oversized-row'; break; }
        inFlightBytes = size;
        publish();
        try { await options.sink.write(batch.join('')); }
        catch {
          failed = true;
          stopReason = 'sink-error';
          lossCount += 1;
          if (timer !== null) { cancel(timer); timer = null; }
          queue = [];
          queuedBytes = 0;
        }
        inFlightBytes = 0;
        publish(failed ? { status: 'incomplete', reason: stopReason } : {});
      }
    })().finally(() => { pumping = null; });
  }

  function enqueue(line: string, immediate = false): void {
    const size = encoder.encode(line).byteLength;
    queue.push({ line, size });
    queuedBytes += size;
    totalBytes += size;
    publish();
    if (immediate || state.status === 'stopping' || queuedBytes >= header.limits.batchBytes) {
      if (flushTimer !== null) { cancel(flushTimer); flushTimer = null; }
      pump();
    } else if (!pumping && flushTimer === null) {
      flushTimer = schedule(() => { flushTimer = null; pump(); }, flushInterval);
    }
  }

  async function drain(): Promise<void> {
    if (flushTimer !== null) { cancel(flushTimer); flushTimer = null; }
    while (pumping || (queue.length > 0 && !failed)) {
      pump();
      if (pumping) await pumping;
    }
  }

  function duration(): number {
    const elapsed = options.nowMs() - startTime;
    return Math.max(lastTime, Math.min(header.limits.maxDurationMs, Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : lastTime));
  }

  function stop(reason = 'stopped'): Promise<CaptureFooter> {
    if (stopping) return stopping;
    if (state.status === 'idle') return Promise.reject(new Error('Capture has not started'));
    if (timer !== null) { cancel(timer); timer = null; }
    if (flushTimer !== null) { cancel(flushTimer); flushTimer = null; }
    if (stopReason === 'stopped') stopReason = reason;
    const stoppedAtMs = duration();
    publish({ status: 'stopping', reason: stopReason === 'stopped' ? null : stopReason });
    stopping = (async () => {
      await drain();
      let footer: CaptureFooter = {
        kind: 'footer', complete: !failed && lossCount === 0 && stopReason === 'stopped', reason: stopReason,
        eventCount, lastSeq: eventCount, durationMs: stoppedAtMs, queueHighWaterBytes: highWater, lossCount,
      };
      if (!failed) {
        const line = JSON.stringify(footer) + '\n';
        enqueue(line);
        await drain();
      }
      if (failed) footer = { ...footer, complete: false, reason: stopReason, lossCount };
      publish({ status: footer.complete ? 'complete' : 'incomplete', reason: footer.complete ? null : footer.reason });
      return Object.freeze(footer);
    })();
    return stopping;
  }

  function abort(reason: string): void {
    stopReason = reason;
    lossCount += 1;
    const marker: CaptureEvent = { kind: 'event', seq: eventCount + 1, tMs: lastTime,
      connectionId: 0, type: 'loss', reason };
    const line = JSON.stringify(marker) + '\n';
    const size = encoder.encode(line).byteLength;
    if (queuedBytes + inFlightBytes + size <= header.limits.maxBufferedBytes && totalBytes + size <= header.limits.maxSessionBytes) {
      eventCount += 1;
      enqueue(line, true);
    }
    void stop(reason);
  }

  return {
    start(value) {
      if (state.status !== 'idle') throw new Error('Recorder is single-use');
      const parsed = parseCaptureRow(value);
      if (parsed.kind !== 'header') throw new TypeError('Capture requires a header');
      const line = JSON.stringify(parsed) + '\n';
      const size = encoder.encode(line).byteLength;
      if (size > parsed.limits.batchBytes || size + reserveBytes > Math.min(parsed.limits.maxBufferedBytes, parsed.limits.maxSessionBytes)) {
        throw new RangeError('Capture limits cannot fit its header and termination records');
      }
      startTime = options.nowMs();
      if (!Number.isFinite(startTime)) throw new RangeError('Capture clock must be finite');
      header = parsed;
      publish({ status: 'recording' });
      enqueue(line);
      timer = schedule(() => { void stop('duration-limit'); }, header.limits.maxDurationMs);
    },
    record(input, atMs = options.nowMs()) {
      if (state.status !== 'recording') return;
      const time = atMs - startTime;
      if (!Number.isFinite(time) || time < lastTime || time < 0) { abort('clock-regression'); return; }
      if (time > header.limits.maxDurationMs) { void stop('duration-limit'); return; }
      const row = parseCaptureRow({ ...input, kind: 'event', seq: eventCount + 1, tMs: time,
        ...(input.type === 'message' ? { data: projectRawTelemetry(input.data) } : {}) });
      if (row.kind !== 'event') throw new TypeError('Expected capture event');
      const line = JSON.stringify(row) + '\n';
      const size = encoder.encode(line).byteLength;
      if (size > header.limits.batchBytes) { abort('oversized-row'); return; }
      if (totalBytes + size + reserveBytes > header.limits.maxSessionBytes) { abort('session-limit'); return; }
      if (queuedBytes + inFlightBytes + size + reserveBytes > header.limits.maxBufferedBytes) { abort('buffer-overflow'); return; }
      lastTime = time;
      eventCount += 1;
      enqueue(line);
    },
    stop,
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
