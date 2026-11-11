import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCaptureClient } from '../src/diagnostics/capture-client.ts';
import type { CaptureHeader, CaptureManifest, CaptureRow } from '../src/diagnostics/capture-format.ts';
import { DEFAULT_CAPTURE_LIMITS } from '../src/diagnostics/capture-format.ts';
import { parseCapture } from '../src/diagnostics/capture-format.ts';
import { createCaptureServer } from '../src/diagnostics/capture-server.ts';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

function setup() {
  let now = 10;
  let source: 'live' | 'synthetic' = 'live';
  let failBatch = 0;
  let failFinish = false;
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const rows: CaptureRow[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const path = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push({ path, body });
    if (path.endsWith('/start')) {
      source = body.source as 'live' | 'synthetic';
      const header: CaptureHeader = {
        kind: 'header', version: 1, captureId: 'capture-1', startedAt: '2026-11-11T12:00:00.000Z',
        source, hudVersion: 'test', gameVersion: String(body.gameVersion), bridgeVersion: String(body.bridgeVersion),
        browser: String(body.browser), pollMs: 16, limits: { ...DEFAULT_CAPTURE_LIMITS },
      };
      return Response.json({ captureId: 'capture-1', header, outputPath: 'captures/capture-1' });
    }
    if (path.endsWith('/batch')) {
      if (failBatch-- > 0) throw new TypeError('Network failure after server receive');
      for (const line of String(body.lines).trim().split('\n')) rows.push(JSON.parse(line));
      return Response.json({ batchIndex: body.batchIndex, accepted: true });
    }
    if (path.endsWith('/finish')) {
      if (failFinish) return new Response('Disk unavailable', { status: 500 });
      const manifest: CaptureManifest = {
        version: 1, captureId: 'capture-1', complete: body.complete === true,
        source, byteCount: 1234, eventCount: rows.filter(row => row.kind === 'event').length,
        sha256: '0'.repeat(64), outputPath: 'captures/capture-1', problems: body.complete === true ? [] : ['Incomplete capture'],
      };
      return Response.json(manifest);
    }
    throw new Error(`Unexpected request ${path}`);
  };
  const client = createCaptureClient({ fetch: mockFetch, nowMs: () => now });
  return {
    client, requests, rows,
    setTime(value: number) { now = value; },
    failNextBatch() { failBatch = 1; },
    failFinish() { failFinish = true; },
    restoreFinish() { failFinish = false; },
  };
}

const metadata = { source: 'live' as const, gameVersion: 'game-build', bridgeVersion: 'bridge-build', browser: 'browser-build', pollMs: 16 };

test('HTTP capture preserves projected raw values, closes durably, and keeps stable state snapshots', async () => {
  const value = setup();
  assert.equal(value.client.getState(), value.client.getState());
  await value.client.start(metadata);
  value.setTime(20);
  value.client.recordIngress({ type: 'open', connectionId: 1, atMs: 20 });
  value.client.recordIngress({ type: 'message', connectionId: 1, atMs: 20,
    data: { VersionMajor: 99, LapTimePreviousSelf: -1, PrevLapValid: null, DriverData: ['private'] } });
  const manifest = await value.client.stop();
  assert.equal(manifest.complete, true);
  assert.equal(value.client.getState().status, 'complete');
  assert.equal(value.client.getState().outputPath, 'captures/capture-1');
  const message = value.rows.find(row => row.kind === 'event' && row.type === 'message');
  assert.ok(message?.kind === 'event');
  assert.deepEqual(message.data, { VersionMajor: 99, LapTimePreviousSelf: -1, PrevLapValid: null });
  assert.equal(JSON.stringify(value.requests).includes('private'), false);
  assert.equal(value.requests.filter(request => request.path.endsWith('/start')).length, 1);
  assert.ok(value.rows.some(row => row.kind === 'footer' && row.complete));
});

test('starting mid-connection records an already-open boundary at the capture origin', async () => {
  const value = setup();
  value.client.recordIngress({ type: 'open', connectionId: 7, atMs: 1 });
  await value.client.start(metadata);
  const result = await value.client.stop();
  assert.equal(result.complete, true);
  const opened = value.rows.find(row => row.kind === 'event' && row.type === 'open');
  assert.ok(opened?.kind === 'event');
  assert.equal(opened.connectionId, 7);
  assert.equal(opened.tMs, 0);
  assert.equal(opened.reason, 'already-open');
});

test('malformed input and independent annotations survive without exposing wire payloads', async () => {
  const value = setup();
  await value.client.start(metadata);
  value.client.recordIngress({ type: 'open', connectionId: 1, atMs: 10 });
  value.client.recordIngress({ type: 'malformed', connectionId: 1, atMs: 10, messageType: 'string', byteLength: 24, reason: 'Expected JSON' });
  value.client.annotate({ completedLap: 2, outcome: 'invalid', totalUs: 90_000_000, notes: 'Cut before finish' });
  await value.client.stop();
  assert.ok(value.rows.some(row => row.kind === 'event' && row.type === 'malformed' && row.byteLength === 24));
  assert.ok(value.rows.some(row => row.kind === 'event' && row.type === 'annotation' && row.annotation?.outcome === 'invalid'));
});

test('transport failure retries the same batch identity without a duplicate recording session', async () => {
  const value = setup();
  value.failNextBatch();
  await value.client.start(metadata);
  const manifest = await value.client.stop();
  assert.equal(manifest.complete, true);
  const batches = value.requests.filter(request => request.path.endsWith('/batch'));
  assert.ok(batches.length >= 2);
  assert.equal(batches[0].body.batchIndex, batches[1].body.batchIndex);
  assert.equal(batches[0].body.lines, batches[1].body.lines);
});

test('an unconfirmed durable finish rejects and never claims a completed recording', async () => {
  const value = setup();
  await value.client.start(metadata);
  value.failFinish();
  await assert.rejects(value.client.stop(), /500|durable|capture/i);
  assert.equal(value.client.getState().status, 'incomplete');
  assert.equal(value.client.getState().manifest, null);
  value.restoreFinish();
  const recovered = await value.client.stop();
  assert.equal(recovered.complete, true);
  assert.equal(value.rows.filter(row => row.kind === 'footer').length, 1);
  assert.equal(value.requests.filter(request => request.path.endsWith('/start')).length, 1);
});

test('synthetic captures remain explicitly marked and duplicate starts are rejected', async () => {
  const value = setup();
  await value.client.start({ ...metadata, source: 'synthetic' });
  await assert.rejects(value.client.start(metadata), /active|recording/i);
  const manifest = await value.client.stop();
  assert.equal(manifest.source, 'synthetic');
  assert.equal(value.rows[0].kind === 'header' && value.rows[0].source, 'synthetic');
});

test('the real HTTP collector durably saves the client stream with matching checksum and no private fields', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r3e-capture-client-'));
  const publicDir = join(directory, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>HUD fixture</title>');
  const server = await createCaptureServer({ outputDir: join(directory, 'captures'), staticDir: publicDir, port: 0 });
  const client = createCaptureClient({ baseUrl: server.url, nowMs: () => 10 });
  t.after(async () => { client.dispose(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  await client.start({ ...metadata, source: 'synthetic' });
  client.recordIngress({ type: 'open', connectionId: 1, atMs: 10 });
  client.recordIngress({ type: 'message', connectionId: 1, atMs: 10,
    data: { VersionMajor: 3, VersionMinor: 6, CompletedLaps: 0, LapTimeCurrentSelf: 0, DriverData: [{ Name: 'not captured' }] } });
  client.annotate({ completedLap: 0, outcome: 'unknown', notes: 'Manual fixture annotation' });
  const manifest = await client.stop();
  const contents = await readFile(join(manifest.outputPath, 'capture.jsonl'));
  assert.equal(manifest.complete, true);
  assert.equal(manifest.source, 'synthetic');
  assert.equal(manifest.sha256, createHash('sha256').update(contents).digest('hex'));
  assert.equal(manifest.byteCount, contents.byteLength);
  const captured = parseCapture(contents.toString());
  assert.equal(captured.complete, true);
  assert.equal(captured.events.length, 3);
  assert.equal(contents.includes(Buffer.from('not captured')), false);
  assert.equal(contents.includes(Buffer.from('DriverData')), false);
});
