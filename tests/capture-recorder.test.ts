import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CAPTURE_LIMITS, parseCapture } from '../src/diagnostics/capture-format.ts';
import type { CaptureHeader } from '../src/diagnostics/capture-format.ts';
import { createCaptureRecorder } from '../src/diagnostics/recorder.ts';

function header(overrides: Partial<CaptureHeader> = {}): CaptureHeader {
  return { kind: 'header', version: 1, captureId: 'test-capture', startedAt: '2026-11-11T12:00:00.000Z', source: 'synthetic',
    hudVersion: 'test', gameVersion: 'test', bridgeVersion: 'test', browser: 'test', pollMs: 16,
    limits: { ...DEFAULT_CAPTURE_LIMITS }, ...overrides };
}

test('recorder writes ordered JSONL without blocking delivery and stops exactly once', async () => {
  let now = 100;
  const batches: string[] = [];
  const recorder = createCaptureRecorder({ nowMs: () => now, sink: { async write(lines) { batches.push(lines); } } });
  recorder.start(header());
  recorder.record({ type: 'open', connectionId: 1 });
  now = 116;
  recorder.record({ type: 'message', connectionId: 1, data: { CompletedLaps: 0 } });
  const footer = await recorder.stop();
  const doc = parseCapture(batches.join(''));
  assert.equal(doc.events[1].tMs, 16);
  assert.equal(footer.complete, true);
  assert.deepEqual(await recorder.stop(), footer);
  assert.equal(batches.join('').match(/"kind":"footer"/g)?.length, 1);
  assert.equal(recorder.getState().status, 'complete');
});

test('raw timing is projected before serialization and external mutations cannot change queued data', async () => {
  const batches: string[] = [];
  const recorder = createCaptureRecorder({ nowMs: () => 0, sink: { async write(lines) { batches.push(lines); } } });
  recorder.start(header());
  const data = { VehicleInfo: { ModelId: 20, Name: 'private' }, DriverData: ['private'] };
  recorder.record({ type: 'message', connectionId: 1, data });
  data.VehicleInfo.ModelId = 99;
  await recorder.stop();
  const doc = parseCapture(batches.join(''));
  assert.deepEqual(doc.events[0].data, { VehicleInfo: { ModelId: 20 } });
  assert.equal(batches.join('').includes('private'), false);
});

test('sink failure produces an incomplete result without an unhandled rejection', async () => {
  const recorder = createCaptureRecorder({ nowMs: () => 0, sink: { async write() { throw new Error('disk unavailable'); } } });
  recorder.start(header());
  recorder.record({ type: 'message', connectionId: 1, data: { CompletedLaps: 0 } });
  const footer = await recorder.stop();
  assert.equal(footer.complete, false);
  assert.equal(recorder.getState().status, 'incomplete');
  assert.equal(recorder.getState().reason, 'sink-error');
});

test('a stalled sink cannot grow the queue beyond the configured cap', async () => {
  const batches: string[] = [];
  let release: (() => void) | undefined;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const recorder = createCaptureRecorder({ nowMs: () => 0, sink: { async write(lines) { await blocked; batches.push(lines); } } });
  const limits = { ...DEFAULT_CAPTURE_LIMITS, maxBufferedBytes: 4096, batchBytes: 1024 };
  recorder.start(header({ limits }));
  for (let index = 0; index < 100; index++) {
    recorder.record({ type: 'message', connectionId: 1, data: { Source: 'x'.repeat(500) } });
    assert.ok(recorder.getState().queueBytes <= limits.maxBufferedBytes);
  }
  release!();
  const footer = await recorder.stop();
  assert.equal(footer.complete, false);
  assert.equal(footer.reason, 'buffer-overflow');
  const doc = parseCapture(batches.join(''), { allowIncomplete: true });
  assert.ok(doc.events.some(event => event.type === 'loss'));
});

test('duration expiry and backwards clocks stop recording explicitly', async () => {
  for (const [end, reason] of [[101, 'duration-limit'], [-1, 'clock-regression']] as const) {
    let now = 0;
    const batches: string[] = [];
    const recorder = createCaptureRecorder({ nowMs: () => now, sink: { async write(lines) { batches.push(lines); } } });
    recorder.start(header({ limits: { ...DEFAULT_CAPTURE_LIMITS, maxDurationMs: 100 } }));
    now = end;
    recorder.record({ type: 'message', connectionId: 1, data: {} });
    const footer = await recorder.stop();
    assert.equal(footer.complete, false);
    assert.equal(footer.reason, reason);
  }
});

test('recorder snapshots stay stable between changes and subscribers can unsubscribe', async () => {
  const recorder = createCaptureRecorder({ nowMs: () => 0, sink: { async write() {} } });
  assert.equal(recorder.getState(), recorder.getState());
  let changes = 0;
  const unsubscribe = recorder.subscribe(() => { changes++; });
  recorder.start(header());
  assert.ok(changes > 0);
  unsubscribe();
  const before = changes;
  recorder.record({ type: 'message', connectionId: 1, data: {} });
  await recorder.stop();
  assert.equal(changes, before);
});

test('ordinary telemetry batches on a timer rather than sending one HTTP write per frame', async () => {
  const batches: string[] = [];
  const tasks = new Map<number, { callback: () => void; delay: number }>();
  let sequence = 0;
  const recorder = createCaptureRecorder({
    nowMs: () => 0, sink: { async write(lines) { batches.push(lines); } },
    schedule(callback, delay) { tasks.set(++sequence, { callback, delay }); return sequence; },
    cancel(handle) { tasks.delete(handle as number); },
  });
  recorder.start(header());
  await new Promise<void>(resolve => setImmediate(resolve));
  const initial = batches.length;
  recorder.record({ type: 'message', connectionId: 1, data: { CompletedLaps: 0 } });
  await new Promise<void>(resolve => setImmediate(resolve));
  recorder.record({ type: 'message', connectionId: 1, data: { CompletedLaps: 1 } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(batches.length, initial, 'the capture sink waits for its batch interval');
  const flush = [...tasks.values()].find(task => task.delay === 100);
  assert.ok(flush, 'a bounded-time flush is scheduled even with low-volume telemetry');
  flush.callback();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(batches.length, initial + 1);
  assert.equal(batches.at(-1)!.match(/"kind":"event"/g)?.length, 2);
  await recorder.stop();
});

test('slow file delivery does not extend the observed recording interval after Stop', async () => {
  let now = 0;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const recorder = createCaptureRecorder({ nowMs: () => now, sink: { async write() { await blocked; } } });
  recorder.start(header());
  now = 10;
  recorder.record({ type: 'message', connectionId: 1, data: { CompletedLaps: 0 } });
  now = 20;
  const stopping = recorder.stop();
  now = 1000;
  release!();
  assert.equal((await stopping).durationMs, 20);
});
