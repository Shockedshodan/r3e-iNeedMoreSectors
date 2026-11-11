import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCaptureServer } from '../src/diagnostics/capture-server.ts';
import type { CaptureServerOptions } from '../src/diagnostics/capture-server.ts';
import type { CaptureFooter, CaptureHeader, CaptureManifest } from '../src/diagnostics/capture-format.ts';

async function setup(t: { after(fn: () => Promise<void>): void }, overrides: Partial<CaptureServerOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'r3e-capture-server-'));
  const staticDir = join(root, 'dist');
  const outputDir = join(root, 'captures');
  await mkdir(staticDir);
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>HUD test</title>');
  await writeFile(join(staticDir, 'app.js'), 'window.HUD=true;');
  const server = await createCaptureServer({ outputDir, staticDir, port: 0, hudVersion: 'test-hud', ...overrides });
  t.after(() => server.close());
  return { ...server, outputDir, staticDir, root };
}

async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
async function start(url: string) {
  const response = await post(url, '/api/capture/start', {
    source: 'live', gameVersion: 'test-game', bridgeVersion: 'test-bridge', browser: 'test-browser',
  });
  assert.equal(response.status, 201);
  return response.json() as Promise<{ captureId: string; header: CaptureHeader; outputPath: string }>;
}
function footer(eventCount = 1): CaptureFooter {
  return { kind: 'footer', complete: true, reason: 'stopped', eventCount, lastSeq: eventCount,
    durationMs: 100, queueHighWaterBytes: 1024, lossCount: 0 };
}
function rows(header: CaptureHeader): string {
  return [header, { kind: 'event', seq: 1, tMs: 10, connectionId: 1, type: 'message',
    data: { VersionMajor: 3, VersionMinor: 6, CompletedLaps: 1 } }, footer()].map(row => JSON.stringify(row) + '\n').join('');
}

test('capture host serves built HUD assets, metadata and no broad CORS', async t => {
  const server = await setup(t);
  const root = await fetch(server.url + '/?capture=1');
  assert.equal(root.status, 200);
  assert.match(await root.text(), /HUD test/);
  assert.match(root.headers.get('content-type')!, /text\/html/);
  const js = await fetch(server.url + '/app.js');
  assert.match(js.headers.get('content-type')!, /javascript/);
  const config = await fetch(server.url + '/api/capture/config');
  assert.equal(config.status, 200);
  assert.equal(config.headers.get('access-control-allow-origin'), null);
  const value = await config.json();
  assert.equal(value.available, true);
  assert.equal(value.liveWritesAllowed, false);
  assert.equal(value.hudVersion, 'test-hud');
  assert.equal((await fetch(server.url + '/missing')).status, 404);
});

test('complete ordered batches stream to an exclusive file with a matching SHA256 manifest', async t => {
  const server = await setup(t);
  const session = await start(server.url);
  assert.equal(session.header.source, 'live');
  assert.equal(session.header.hudVersion, 'test-hud');
  const text = rows(session.header);
  const batch = await post(server.url, `/api/capture/${session.captureId}/batch`, { batchIndex: 0, lines: text });
  assert.equal(batch.status, 200);
  const finished = await post(server.url, `/api/capture/${session.captureId}/finish`, { complete: true });
  assert.equal(finished.status, 200);
  const manifest = await finished.json() as CaptureManifest;
  assert.equal(manifest.complete, true);
  assert.equal(manifest.eventCount, 1);
  assert.equal(manifest.byteCount, Buffer.byteLength(text));
  assert.equal(manifest.sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(await readFile(join(server.outputDir, session.captureId, 'capture.jsonl'), 'utf8'), text);
  assert.deepEqual(JSON.parse(await readFile(join(server.outputDir, session.captureId, 'manifest.json'), 'utf8')), manifest);
});

test('batch retries are idempotent, while conflicts and out-of-order batches fail without data changes', async t => {
  const server = await setup(t);
  const session = await start(server.url);
  const path = `/api/capture/${session.captureId}/batch`;
  const first = JSON.stringify(session.header) + '\n';
  assert.equal((await post(server.url, path, { batchIndex: 1, lines: first })).status, 409);
  assert.equal((await post(server.url, path, { batchIndex: 0, lines: first })).status, 200);
  const duplicate = await post(server.url, path, { batchIndex: 0, lines: first });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal((await post(server.url, path, { batchIndex: 0, lines: first + '\n' })).status, 409);
  const manifest = await (await post(server.url, `/api/capture/${session.captureId}/finish`, { complete: false })).json();
  assert.equal(manifest.byteCount, Buffer.byteLength(first));
  assert.equal(manifest.complete, false);
});

test('a capture cannot be called complete with a missing footer or dropped events', async t => {
  const server = await setup(t);
  const session = await start(server.url);
  await post(server.url, `/api/capture/${session.captureId}/batch`, { batchIndex: 0, lines: JSON.stringify(session.header) + '\n' });
  const manifest = await (await post(server.url, `/api/capture/${session.captureId}/finish`, { complete: true })).json();
  assert.equal(manifest.complete, false);
  assert.ok(manifest.problems.length > 0);
});

test('the server rejects private data, sequence gaps and backwards timestamps before writing a batch', async t => {
  const server = await setup(t);
  const session = await start(server.url);
  const header = JSON.stringify(session.header) + '\n';
  const path = `/api/capture/${session.captureId}/batch`;
  assert.equal((await post(server.url, path, { batchIndex: 0, lines: header })).status, 200);
  const event = { kind: 'event', seq: 1, tMs: 10, connectionId: 1, type: 'message', data: { DriverData: ['private-name'] } };
  assert.equal((await post(server.url, path, { batchIndex: 1, lines: JSON.stringify(event) + '\n' })).status, 400);
  assert.equal((await post(server.url, path, { batchIndex: 1, lines: JSON.stringify({ ...event, seq: 2, data: {} }) + '\n' })).status, 400);
  assert.equal((await post(server.url, path, { batchIndex: 1, lines: JSON.stringify({ ...event, data: {} }) + '\n' })).status, 200);
  assert.equal((await post(server.url, path, { batchIndex: 2, lines: JSON.stringify({ ...event, seq: 2, tMs: 9, data: {} }) + '\n' })).status, 400);
  const manifest = await (await post(server.url, `/api/capture/${session.captureId}/finish`, { complete: false })).json();
  assert.equal(manifest.eventCount, 1);
});

test('one active session, same-origin requests and loopback binding are enforced', async t => {
  const server = await setup(t);
  await start(server.url);
  const duplicate = await post(server.url, '/api/capture/start', { source: 'live', gameVersion: 'g', bridgeVersion: 'b', browser: 'c' });
  assert.equal(duplicate.status, 409);
  const remote = await post(server.url, '/api/capture/start', {}, { Origin: 'https://unrelated.example' });
  assert.equal(remote.status, 403);
  await assert.rejects(createCaptureServer({ outputDir: server.outputDir, staticDir: server.staticDir, host: '0.0.0.0' }), RangeError);
});

test('request size and session size limits reject oversized input', async t => {
  const server = await setup(t, { maxBodyBytes: 2048, limits: { batchBytes: 1024, maxSessionBytes: 1500 } });
  const response = await post(server.url, '/api/capture/start', { source: 'live', browser: 'b', gameVersion: 'g', bridgeVersion: 'b', extra: 'x'.repeat(3000) });
  assert.equal(response.status, 413);
  const session = await start(server.url);
  const batch = await post(server.url, `/api/capture/${session.captureId}/batch`, { batchIndex: 0, lines: 'x'.repeat(1100) });
  assert.equal(batch.status, 413);
});

test('cumulative file size is bounded across individually valid small batches', async t => {
  const server = await setup(t, { limits: { batchBytes: 700, maxSessionBytes: 1000 } });
  const session = await start(server.url);
  const path = `/api/capture/${session.captureId}/batch`;
  const header = JSON.stringify(session.header) + '\n';
  assert.equal((await post(server.url, path, { batchIndex: 0, lines: header })).status, 200);
  let acceptedBytes = Buffer.byteLength(header);
  let acceptedEvents = 0;
  for (let sequence = 1; sequence <= 20; sequence++) {
    const lines = JSON.stringify({ kind: 'event', seq: sequence, tMs: sequence, connectionId: 1, type: 'message', data: { CarSpeed: 20 } }) + '\n';
    const response = await post(server.url, path, { batchIndex: sequence, lines });
    if (acceptedBytes + Buffer.byteLength(lines) > 1000) {
      assert.equal(response.status, 413);
      break;
    }
    assert.equal(response.status, 200);
    acceptedBytes += Buffer.byteLength(lines);
    acceptedEvents++;
  }
  const manifest = await (await post(server.url, `/api/capture/${session.captureId}/finish`, { complete: false })).json();
  assert.equal(manifest.byteCount, acceptedBytes);
  assert.equal(manifest.eventCount, acceptedEvents);
  assert.ok(manifest.byteCount <= 1000);
  assert.equal(manifest.complete, false);
});

test('shutdown flushes unfinished recordings as incomplete and does not overwrite prior captures', async t => {
  const server = await setup(t);
  const session = await start(server.url);
  await post(server.url, `/api/capture/${session.captureId}/batch`, { batchIndex: 0, lines: JSON.stringify(session.header) + '\n' });
  await server.close();
  const manifest = JSON.parse(await readFile(join(server.outputDir, session.captureId, 'manifest.json'), 'utf8'));
  assert.equal(manifest.complete, false);
  assert.match(manifest.problems.join(' '), /shutdown|footer|incomplete/i);
  assert.deepEqual(await readdir(join(server.outputDir, session.captureId)), ['capture.jsonl', 'manifest.json']);
});

test('loss markers and a declared excessive duration prevent completion', async t => {
  const server = await setup(t);
  for (const [event, end] of [
    [{ kind: 'event', seq: 1, tMs: 10, connectionId: 0, type: 'loss', reason: 'queue overflow' }, { ...footer(), lossCount: 1 }],
    [{ kind: 'event', seq: 1, tMs: 10, connectionId: 1, type: 'open' }, { ...footer(), durationMs: 2_000_000 }],
  ] as const) {
    const session = await start(server.url);
    const text = [session.header, event, end].map(row => JSON.stringify(row) + '\n').join('');
    assert.equal((await post(server.url, `/api/capture/${session.captureId}/batch`, { batchIndex: 0, lines: text })).status, 200);
    const manifest = await (await post(server.url, `/api/capture/${session.captureId}/finish`, { complete: true })).json();
    assert.equal(manifest.complete, false);
    assert.ok(manifest.problems.length > 0);
  }
});

test('consecutive captures preserve separate immutable files', async t => {
  const server = await setup(t);
  const first = await start(server.url);
  const text = rows(first.header);
  await post(server.url, `/api/capture/${first.captureId}/batch`, { batchIndex: 0, lines: text });
  await post(server.url, `/api/capture/${first.captureId}/finish`, { complete: true });
  const second = await start(server.url);
  assert.notEqual(first.captureId, second.captureId);
  assert.equal(await readFile(join(server.outputDir, first.captureId, 'capture.jsonl'), 'utf8'), text);
  assert.equal((await post(server.url, `/api/capture/${first.captureId}/batch`, { batchIndex: 1, lines: text })).status, 409);
});

test('finalization retries a transient manifest failure without recreating or altering the closed capture file', async t => {
  const server = await setup(t);
  const session = await start(server.url);
  const text = rows(session.header);
  await post(server.url, `/api/capture/${session.captureId}/batch`, { batchIndex: 0, lines: text });
  const manifestPath = join(server.outputDir, session.captureId, 'manifest.json');
  // A directory collision reliably causes the manifest write to fail on both
  // Windows and Unix, without depending on chmod privileges or root behavior.
  await mkdir(manifestPath);
  assert.equal((await post(server.url, `/api/capture/${session.captureId}/finish`, { complete: true })).status, 500);
  assert.equal(await readFile(join(server.outputDir, session.captureId, 'capture.jsonl'), 'utf8'), text);
  await rm(manifestPath, { recursive: true });

  const retry = await post(server.url, `/api/capture/${session.captureId}/finish`, { complete: true });
  assert.equal(retry.status, 200);
  const manifest = await retry.json() as CaptureManifest;
  assert.equal(manifest.complete, true);
  assert.equal(manifest.sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(await readFile(join(server.outputDir, session.captureId, 'capture.jsonl'), 'utf8'), text);
  assert.deepEqual(await (await post(server.url, `/api/capture/${session.captureId}/finish`, { complete: true })).json(), manifest);
});
