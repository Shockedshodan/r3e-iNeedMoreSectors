import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, realpath, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_CAPTURE_LIMITS, parseCaptureRow, projectRawTelemetry } from './capture-format.ts';
import type { CaptureFooter, CaptureHeader, CaptureLimits, CaptureManifest } from './capture-format.ts';
export type { CaptureManifest } from './capture-format.ts';

export interface CaptureServerOptions {
  outputDir: string;
  staticDir: string;
  host?: string;
  port?: number;
  hudVersion?: string;
  maxBodyBytes?: number;
  limits?: Partial<CaptureLimits>;
}
export interface CaptureServer {
  url: string;
  close(): Promise<void>;
}
export async function createCaptureServer(options: CaptureServerOptions): Promise<CaptureServer> {
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new RangeError('Capture host must bind to loopback');
  const port = options.port ?? 3200;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('Invalid capture server port');
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new RangeError('Invalid request body limit');
  const limits: CaptureLimits = { ...DEFAULT_CAPTURE_LIMITS, ...options.limits };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Capture limits must be positive integers');
  }
  if (limits.batchBytes > limits.maxBufferedBytes || limits.batchBytes > limits.maxSessionBytes) {
    throw new RangeError('Batch limit cannot exceed queue/session limit');
  }
  const outputDir = resolve(options.outputDir);
  const staticDir = await realpath(options.staticDir);
  if (!(await stat(staticDir)).isDirectory()) throw new RangeError('Static HUD directory must exist');
  await mkdir(outputDir, { recursive: true });
  const sessions = new Map<string, Session>();
  let active: string | null = null;
  let closing = false;

  interface Session {
    header: CaptureHeader;
    directory: string;
    file: string;
    handle: FileHandle | null;
    directoryCreated: boolean;
    fileCreated: boolean;
    bytes: number;
    nextBatch: number;
    digests: Map<number, string>;
    headerWritten: boolean;
    lastSeq: number;
    lastTime: number;
    lossEvents: number;
    footer: CaptureFooter | null;
    queue: Promise<unknown>;
    problems: string[];
    manifest: CaptureManifest | null;
  }
  class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
  }
  function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  function json(response: ServerResponse, status: number, value: unknown): void {
    if (response.headersSent) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  }
  function serial<T>(session: Session, action: () => Promise<T>): Promise<T> {
    const operation = session.queue.then(action);
    session.queue = operation.catch(() => {});
    return operation;
  }
  function metadata(value: unknown, fallback = 'unknown'): string {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || value.length > 300) throw new HttpError(400, 'Invalid version metadata');
    return value.trim() || fallback;
  }
  function requestBody(request: IncomingMessage): Promise<unknown> {
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      request.resume();
      throw new HttpError(415, 'Capture requests require application/json');
    }
    if (Number(request.headers['content-length']) > maxBodyBytes) {
      request.resume();
      throw new HttpError(413, 'Capture request is too large');
    }
    return new Promise((resolveBody, reject) => {
      let size = 0;
      let chunks: Buffer[] = [];
      let settled = false;
      request.on('data', (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBodyBytes) {
          settled = true; chunks = []; reject(new HttpError(413, 'Capture request is too large')); return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        if (settled) return;
        settled = true;
        try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new HttpError(400, 'Malformed JSON request')); }
      });
      request.on('error', () => { if (!settled) { settled = true; reject(new HttpError(400, 'Request interrupted')); } });
      request.on('aborted', () => { if (!settled) { settled = true; reject(new HttpError(400, 'Request interrupted')); } });
    });
  }
  async function ensureFile(session: Session): Promise<FileHandle> {
    if (session.handle) return session.handle;
    if (session.fileCreated) throw new HttpError(409, 'Capture data file has already been finalized');
    if (!session.directoryCreated) {
      await mkdir(session.directory, { recursive: false });
      session.directoryCreated = true;
    }
    session.handle = await open(session.file, 'wx');
    session.fileCreated = true;
    return session.handle;
  }
  async function finalize(session: Session, requestedComplete: boolean, reason?: string): Promise<CaptureManifest> {
    if (session.manifest) return session.manifest;
    if (!session.headerWritten) session.problems.push('Capture header was not received');
    if (!session.footer) session.problems.push('Missing capture footer');
    if (!requestedComplete) session.problems.push(reason ?? 'Capture was marked incomplete');
    if (session.footer && !session.footer.complete) session.problems.push(`Capture incomplete: ${session.footer.reason}`);
    if (session.lossEvents || session.footer?.lossCount) session.problems.push('Capture contains lost observations');
    if (session.footer && session.footer.durationMs > session.header.limits.maxDurationMs) session.problems.push('Capture duration limit exceeded');
    // A metadata write may fail after the data file was successfully synced
    // and closed. Retry hashing/manifest creation from that existing file;
    // never recreate, reopen for writes, or truncate completed capture data.
    if (!session.fileCreated) await ensureFile(session);
    if (session.handle) {
      try { await session.handle.sync(); } catch { session.problems.push('Capture file could not be synchronized'); }
      await session.handle.close();
      session.handle = null;
    }
    const digest = createHash('sha256');
    let byteCount = 0;
    for await (const chunk of createReadStream(session.file)) {
      byteCount += chunk.length;
      digest.update(chunk);
    }
    const manifest: CaptureManifest = {
      version: 1, captureId: session.header.captureId,
      complete: requestedComplete && session.problems.length === 0,
      source: session.header.source, byteCount, eventCount: session.lastSeq,
      sha256: digest.digest('hex'), outputPath: session.directory,
      problems: [...new Set(session.problems)],
    };
    const manifestPath = join(session.directory, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    session.manifest = manifest;
    if (active === session.header.captureId) active = null;
    return manifest;
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closing) throw new HttpError(503, 'Capture server is shutting down');
    const authority = request.headers.host;
    if (!authority || !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(authority)) throw new HttpError(403, 'Loopback host required');
    const address = new URL(request.url ?? '/', `http://${authority}`);
    if (request.method === 'POST') {
      if (request.headers.origin && request.headers.origin !== address.origin) throw new HttpError(403, 'Capture requires same-origin requests');
      const body = await requestBody(request);
      if (closing) throw new HttpError(503, 'Capture server is shutting down');
      if (!object(body)) throw new HttpError(400, 'Capture request must be an object');
      if (address.pathname === '/api/capture/start') {
        if (active !== null) throw new HttpError(409, 'A capture is already active');
        if (body.source !== 'live' && body.source !== 'synthetic') throw new HttpError(400, 'Capture source must be live or synthetic');
        const selectedLimits = { ...limits };
        if (body.limits !== undefined) {
          if (!object(body.limits)) throw new HttpError(400, 'Invalid capture limits');
          for (const key of Object.keys(selectedLimits) as (keyof CaptureLimits)[]) {
            if (body.limits[key] !== undefined) {
              const value = body.limits[key];
              if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new HttpError(400, 'Invalid capture limits');
              selectedLimits[key] = Math.min(value, limits[key]);
            }
          }
        }
        const pollMs = body.pollMs ?? 16;
        if (typeof pollMs !== 'number' || !Number.isFinite(pollMs) || pollMs <= 0) throw new HttpError(400, 'Invalid poll interval');
        const captureId = randomUUID();
        const header: CaptureHeader = {
          kind: 'header', version: 1, captureId, startedAt: new Date().toISOString(),
          source: body.source, hudVersion: options.hudVersion ?? 'unknown',
          gameVersion: metadata(body.gameVersion), bridgeVersion: metadata(body.bridgeVersion),
          browser: metadata(body.browser), pollMs, limits: selectedLimits,
        };
        try { parseCaptureRow(header); } catch { throw new HttpError(400, 'Invalid capture metadata or limits'); }
        const directory = join(outputDir, captureId);
        sessions.set(captureId, {
          header, directory, file: join(directory, 'capture.jsonl'), handle: null,
          directoryCreated: false, fileCreated: false, bytes: 0, nextBatch: 0,
          digests: new Map(), headerWritten: false, lastSeq: 0, lastTime: 0, lossEvents: 0,
          footer: null, queue: Promise.resolve(), problems: [], manifest: null,
        });
        active = captureId;
        json(response, 201, { captureId, header, outputPath: directory });
        return;
      }
      const match = /^\/api\/capture\/([a-f0-9-]+)\/(batch|finish)$/.exec(address.pathname);
      if (!match || !sessions.has(match[1])) throw new HttpError(404, 'Unknown capture');
      const session = sessions.get(match[1])!;
      if (match[2] === 'finish') {
        if (typeof body.complete !== 'boolean') throw new HttpError(400, 'Completion state is required');
        const manifest = await serial(session, () => finalize(session, body.complete as boolean, metadata(body.reason, 'Capture marked incomplete')));
        json(response, 200, manifest);
        return;
      }
      const result = await serial(session, async () => {
        if (session.manifest) throw new HttpError(409, 'Capture is finalized');
        if (!Number.isSafeInteger(body.batchIndex) || Number(body.batchIndex) < 0 || typeof body.lines !== 'string') {
          throw new HttpError(400, 'Batch requires a nonnegative index and complete JSONL lines');
        }
        const batchIndex = Number(body.batchIndex);
        const lines = body.lines;
        const bytes = Buffer.byteLength(lines);
        if (bytes > session.header.limits.batchBytes) throw new HttpError(413, 'Capture batch is too large');
        if (!lines.endsWith('\n') || !lines.trim()) throw new HttpError(400, 'Batch requires complete nonempty JSONL lines');
        const digest = createHash('sha256').update(lines).digest('hex');
        const previousDigest = session.digests.get(batchIndex);
        if (previousDigest !== undefined) {
          if (previousDigest !== digest) throw new HttpError(409, 'Conflicting batch retry');
          return { batchIndex, accepted: true, duplicate: true };
        }
        if (batchIndex !== session.nextBatch) throw new HttpError(409, 'Capture batch is out of order');
        if (session.bytes + bytes > session.header.limits.maxSessionBytes) throw new HttpError(413, 'Capture session is too large');
        let headerWritten = session.headerWritten;
        let lastSeq = session.lastSeq;
        let lastTime = session.lastTime;
        let lossEvents = session.lossEvents;
        let footer = session.footer;
        for (const line of lines.slice(0, -1).split('\n')) {
          let row;
          try { row = parseCaptureRow(JSON.parse(line)); } catch { throw new HttpError(400, 'Invalid projected capture row'); }
          if (footer) throw new HttpError(400, 'Rows cannot follow the capture footer');
          if (row.kind === 'header') {
            if (headerWritten || lastSeq !== 0 || JSON.stringify(row) !== JSON.stringify(session.header)) throw new HttpError(400, 'Header does not match capture session');
            headerWritten = true;
          } else if (row.kind === 'event') {
            if (!headerWritten || row.seq !== lastSeq + 1 || row.tMs < lastTime) throw new HttpError(400, 'Capture event ordering is invalid');
            if (row.tMs > session.header.limits.maxDurationMs) throw new HttpError(413, 'Capture duration exceeded');
            if (row.data && JSON.stringify(projectRawTelemetry(row.data)) !== JSON.stringify(row.data)) throw new HttpError(400, 'Unprojected telemetry is not allowed');
            lastSeq = row.seq; lastTime = row.tMs;
            if (row.type === 'loss') lossEvents += 1;
          } else {
            if (!headerWritten || row.eventCount !== lastSeq || row.lastSeq !== lastSeq || row.durationMs < lastTime) throw new HttpError(400, 'Capture footer does not match events');
            footer = row;
          }
        }
        try {
          const handle = await ensureFile(session);
          await handle.writeFile(lines, 'utf8');
        } catch {
          session.problems.push('Capture file write failed');
          throw new HttpError(500, 'Capture file write failed');
        }
        Object.assign(session, { headerWritten, lastSeq, lastTime, lossEvents, footer, bytes: session.bytes + bytes, nextBatch: session.nextBatch + 1 });
        session.digests.set(batchIndex, digest);
        return { batchIndex, accepted: true, duplicate: false };
      });
      json(response, 200, result);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    if (address.pathname === '/api/capture/config') {
      json(response, 200, { available: true, hudVersion: options.hudVersion ?? 'unknown', liveWritesAllowed: false, limits, maxBodyBytes });
      return;
    }
    if (address.pathname.startsWith('/api/')) throw new HttpError(404, 'Unknown capture endpoint');
    let pathname: string;
    try { pathname = decodeURIComponent(address.pathname); } catch { throw new HttpError(400, 'Invalid asset path'); }
    if (pathname.includes('\0') || pathname.includes('\\')) throw new HttpError(400, 'Invalid asset path');
    const candidate = resolve(staticDir, '.' + (pathname === '/' ? '/index.html' : pathname));
    const inside = (file: string) => { const path = relative(staticDir, file); return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path); };
    if (!inside(candidate)) throw new HttpError(403, 'Asset path is outside HUD directory');
    let file: string;
    try { file = await realpath(candidate); } catch { throw new HttpError(404, 'HUD asset not found'); }
    if (!inside(file)) throw new HttpError(403, 'Asset path is outside HUD directory');
    const info = await stat(file);
    if (!info.isFile()) throw new HttpError(404, 'HUD asset not found');
    const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
    response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).on('error', () => response.destroy()).pipe(response);
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(error => {
      json(response, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Capture server operation failed' });
    });
  });
  server.maxConnections = 16;
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolveListening(); });
  });
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('Capture server did not acquire a port');
  const url = `http://${bound.address.includes(':') ? `[${bound.address}]` : bound.address}:${bound.port}`;
  let closePromise: Promise<void> | null = null;
  return {
    url,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        const closed = new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
        for (const session of sessions.values()) {
          if (!session.manifest) await serial(session, () => finalize(session, false, 'Server shutdown before capture completion'));
        }
        server.closeIdleConnections();
        await closed;
      })();
      return closePromise;
    },
  };
}
