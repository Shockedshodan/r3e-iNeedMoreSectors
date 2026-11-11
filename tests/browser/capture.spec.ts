import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCaptureServer } from '../../src/diagnostics/capture-server.ts';
import type { CaptureServer } from '../../src/diagnostics/capture-server.ts';
import { parseCapture } from '../../src/diagnostics/capture-format.ts';
import type { CaptureManifest } from '../../src/diagnostics/capture-format.ts';
import { createBrowserBridge, lapFrames, rawFrame } from '../fixtures/browser-bridge.ts';
import type { BrowserBridge } from '../fixtures/browser-bridge.ts';

let bridge: BrowserBridge;
let host: CaptureServer;
let directory: string;
let closed: boolean;

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'r3e-capture-browser-'));
  bridge = await createBrowserBridge();
  host = await createCaptureServer({ outputDir: directory, staticDir: resolve('dist'), port: 0, hudVersion: 'browser-test' });
  closed = false;
});
test.afterEach(async () => {
  await bridge.close();
  if (!closed) await host.close();
  await rm(directory, { recursive: true, force: true });
});

async function openCapture(page: Page, synthetic = false) {
  await page.goto(`${host.url}/?capture=1&${synthetic ? 'demo=1&' : ''}ws=${bridge.authority}`);
  await expect(page.getByRole('button', { name: 'Cycle reference', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start capture', exact: true })).toBeVisible();
  await expect.poll(() => bridge.activeConnections()).toBe(1);
  await expect.poll(() => bridge.polls()).toBeGreaterThan(0);
  await page.getByRole('textbox', { name: 'Game build', exact: true }).fill('RaceRoom browser fixture');
  await page.getByRole('textbox', { name: 'Bridge build', exact: true }).fill('Raw test bridge 3.6');
}

async function startCapture(page: Page) {
  await page.getByRole('button', { name: 'Start capture', exact: true }).click();
  await expect(page.getByTestId('capture-status')).toHaveText('Capturing telemetry');
}

async function savedCapture() {
  const sessions = await readdir(directory);
  expect(sessions).toHaveLength(1);
  const session = join(directory, sessions[0]);
  const text = await readFile(join(session, 'capture.jsonl'), 'utf8');
  const manifest = JSON.parse(await readFile(join(session, 'manifest.json'), 'utf8')) as CaptureManifest;
  return { session, text, manifest };
}

test('live diagnostic capture preserves projected raw input and annotations while Off, with one bridge socket', async ({ page }) => {
  await openCapture(page);
  await startCapture(page);
  const privateFrame = {
    ...rawFrame(), DriverData: [{ DriverInfo: { Name: 'PRIVATE_DRIVER_NAME' } }],
  };
  await bridge.send(privateFrame);
  await bridge.sendFrames(lapFrames(0, 1).slice(1));
  const invalid = lapFrames(1, 1.2, 1).slice(1).map(sample => ({ ...sample, LapValidState: 1, PrevLapValid: 0 }));
  await bridge.sendFrames(invalid);
  // An adapter-rejected message must still be captured before adaptation.
  await bridge.send(rawFrame({ VersionMajor: 99 }));
  await page.getByRole('spinbutton', { name: 'Completed lap', exact: true }).fill('2');
  await page.getByRole('combobox', { name: 'Result', exact: true }).selectOption('invalid');
  await page.getByRole('textbox', { name: 'Note', exact: true }).fill('Official result screen showed invalid');
  await page.getByRole('button', { name: 'Mark lap', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cycle reference', exact: true })).toContainText('Off');
  await page.getByRole('button', { name: 'Stop capture', exact: true }).click();
  await expect(page.getByTestId('capture-status')).toHaveText('Capture complete');
  await expect(page.getByTestId('capture-output')).toContainText('Saved:');
  const { text, manifest } = await savedCapture();
  const capture = parseCapture(text);
  expect(capture.header.source).toBe('live');
  expect(capture.header.gameVersion).toBe('RaceRoom browser fixture');
  expect(capture.complete).toBe(true);
  expect(capture.events.some(event => event.type === 'message' && event.data?.VersionMajor === 99)).toBe(true);
  expect(capture.events.find(event => event.type === 'annotation')?.annotation).toEqual({
    completedLap: 2, outcome: 'invalid', notes: 'Official result screen showed invalid',
  });
  expect(text).not.toContain('PRIVATE_DRIVER_NAME');
  expect(text).not.toContain('DriverData');
  expect(manifest.complete).toBe(true);
  expect(manifest.sha256).toBe(createHash('sha256').update(text).digest('hex'));
  expect(manifest.eventCount).toBe(capture.events.length);
  expect(bridge.connections()).toBe(1);
  expect(bridge.activeConnections()).toBe(1);
  expect(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes(':records:')))).toEqual([]);
  await expect(page.getByTestId('recording-status')).toContainText('disabled');
});

test('demo capture is explicitly synthetic rather than evidence for a live profile', async ({ page }) => {
  await openCapture(page, true);
  await expect(page.getByText('Synthetic demo', { exact: true })).toBeVisible();
  await startCapture(page);
  await bridge.sendFrames(lapFrames(0, 1));
  await page.getByRole('combobox', { name: 'Result', exact: true }).selectOption('valid');
  await page.getByRole('spinbutton', { name: 'Official time seconds', exact: true }).fill('1.000');
  await page.getByRole('button', { name: 'Mark lap', exact: true }).click();
  await page.getByRole('button', { name: 'Stop capture', exact: true }).click();
  await expect(page.getByTestId('capture-status')).toHaveText('Capture complete');
  const { text, manifest } = await savedCapture();
  const capture = parseCapture(text);
  expect(capture.header.source).toBe('synthetic');
  expect(capture.events.find(event => event.type === 'annotation')?.annotation).toEqual({
    completedLap: 1, outcome: 'valid', totalUs: 1_000_000, totalToleranceUs: 1000,
  });
  expect(manifest.source).toBe('synthetic');
  expect(bridge.connections()).toBe(1);
});

test('closing a recording page leaves an explicitly incomplete session on host shutdown', async ({ page }) => {
  await openCapture(page);
  await startCapture(page);
  await bridge.sendFrames(lapFrames(0, 1).slice(0, 3));
  await expect.poll(async () => {
    const sessions = await readdir(directory);
    return sessions.length ? (await stat(join(directory, sessions[0], 'capture.jsonl'))).size : 0;
  }).toBeGreaterThan(0);
  await page.close();
  await host.close();
  closed = true;
  const { manifest } = await savedCapture();
  expect(manifest.complete).toBe(false);
  expect(manifest.problems.length).toBeGreaterThan(0);
});

test('a failed capture sink is reported incomplete while the normal HUD keeps working', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/capture/*/batch', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Simulated disk sink unavailable"}' }));
  await openCapture(page);
  await page.getByRole('button', { name: 'Start capture', exact: true }).click();
  await expect(page.getByTestId('capture-status')).toHaveText('Capture incomplete');
  await bridge.send(rawFrame());
  await page.getByRole('button', { name: 'Cycle reference', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cycle reference', exact: true })).toContainText('Opt');
  await expect(page.getByTestId('timing-sectors')).toContainText('No saved');
  // A sink failure automatically finalizes the session as incomplete; it must
  // not require a second successful write or an enabled Stop button to report it.
  await expect(page.getByTestId('capture-output')).toContainText('Partial data:');
  const { manifest } = await savedCapture();
  expect(manifest.complete).toBe(false);
  expect(bridge.activeConnections()).toBe(1);
  expect(errors).toEqual([]);
});
