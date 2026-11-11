import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createBrowserBridge, rawFrame } from '../fixtures/browser-bridge.ts';

test('production site boots below the Pages project path with its local bridge and license notice', async ({ page }) => {
  const projectPath = '/r3e-iNeedMoreSectors/';
  const directory = resolve('dist');
  const contentTypes: Record<string, string> = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.txt': 'text/plain', '.map': 'application/json',
  };
  // Serve only built files below the project path. A root-relative asset URL
  // must fail here, rather than being hidden by a development-server fallback.
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
        if (!pathname.startsWith(projectPath)) throw new Error('Outside project path');
        const file = resolve(directory, pathname.slice(projectPath.length) || 'index.html');
        if (!file.startsWith(directory + sep)) throw new Error('Outside site directory');
        const body = await readFile(file);
        response.writeHead(200, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream' });
        response.end(body);
      } catch {
        response.writeHead(404);
        response.end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing static host address');
  const origin = `http://127.0.0.1:${address.port}`;
  const bridge = await createBrowserBridge(rawFrame());
  const errors: string[] = [];
  const failedRequests: string[] = [];
  const scriptUrls: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => failedRequests.push(request.url()));
  page.on('response', response => {
    if (response.url().startsWith(origin) && response.status() >= 400) {
      failedRequests.push(`${response.status()} ${response.url()}`);
    }
    if (response.request().resourceType() === 'script') scriptUrls.push(response.url());
  });
  try {
    const pageResponse = await page.goto(`${origin}${projectPath}?ws=${bridge.authority}`);
    expect(pageResponse?.status()).toBe(200);
    await expect(page).toHaveTitle('R3E Sector Timer');
    await expect(page.getByRole('button', { name: 'Cycle reference', exact: true })).toContainText('Off');
    await expect(page.getByTestId('recording-status')).toContainText('disabled');
    await expect.poll(() => bridge.activeConnections()).toBe(1);
    await expect.poll(() => bridge.polls()).toBeGreaterThan(0);
    expect(scriptUrls).toEqual([`${origin}${projectPath}app.js`]);

    const notices = await page.request.get(`${origin}${projectPath}THIRD_PARTY_NOTICES.txt`);
    expect(notices.status()).toBe(200);
    expect(await notices.text()).toContain('Permission is hereby granted, free of charge');
    expect(await notices.text()).toContain('Diego Junges');
    expect(errors).toEqual([]);
    expect(failedRequests).toEqual([]);
  } finally {
    await page.close();
    await bridge.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
