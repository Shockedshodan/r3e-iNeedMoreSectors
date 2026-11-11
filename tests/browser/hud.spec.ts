import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createBrowserBridge, lapFrames, previousResult, rawFrame } from '../fixtures/browser-bridge.ts';
import type { BrowserBridge } from '../fixtures/browser-bridge.ts';

let bridge: BrowserBridge;

async function openHud(page: Page, demo = true): Promise<void> {
  await page.goto(`/?${demo ? 'demo=1&' : ''}ws=${bridge.authority}`);
  await expect(page.getByRole('button', { name: 'Cycle reference', exact: true })).toBeVisible();
  await expect.poll(() => bridge.activeConnections()).toBe(1);
  await expect.poll(() => bridge.polls()).toBeGreaterThan(0);
}

async function recordReferences(page: Page): Promise<void> {
  await bridge.sendFrames(lapFrames(0, 1));
  // The second, slower lap starts with the pre-improvement snapshot. Its next
  // crossing picks up the saved first lap without fabricating a reference.
  await bridge.sendFrames(lapFrames(1, 1.2, 1).slice(1));
  await page.getByRole('button', { name: 'Cycle reference', exact: true }).click();
  await expect(page.getByTestId('sector-total')).toHaveText('0:01.000');
}

async function recordEntries(page: Page) {
  return page.evaluate(() => Object.entries(localStorage).flatMap(([key, raw]) => {
    try {
      const value = JSON.parse(raw);
      return value && value.schemaVersion === 1 && value.best ? [{ key, value }] : [];
    } catch { return []; }
  }));
}

test.beforeEach(async () => { bridge = await createBrowserBridge(); });
test.afterEach(async () => { await bridge.close(); });

test('boots without telemetry and shows honest placement previews while editing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openHud(page);
  await expect(page.getByRole('button', { name: 'Cycle reference', exact: true })).toContainText('Off');
  await expect(page.getByTestId('timing-sectors')).toBeHidden();
  await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
  await expect(page.getByTestId('timing-sectors')).toBeVisible();
  await expect(page.getByTestId('timing-delta')).toBeVisible();
  await expect(page.getByTestId('timing-sectors')).toContainText('Preview');
  await expect(page.getByTestId('timing-delta')).toContainText('Preview');
  expect(await recordEntries(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('browser polyfills bootstrap and capture when selected modern APIs are absent', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Array.prototype, 'at', { configurable: true, writable: true, value: undefined });
    Object.defineProperty(Object, 'fromEntries', { configurable: true, writable: true, value: undefined });
    Object.defineProperty(globalThis, 'structuredClone', { configurable: true, writable: true, value: undefined });
    Object.defineProperty(globalThis, 'AggregateError', { configurable: true, writable: true, value: undefined });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openHud(page);
  await recordReferences(page);
  await expect(page.getByTestId('sector-total')).toHaveText('0:01.000');
  expect(await page.evaluate(() => [
    typeof Array.prototype.at, typeof Object.fromEntries,
    typeof globalThis.structuredClone, typeof globalThis.AggregateError,
  ])).toEqual(['function', 'function', 'function', 'function']);
  expect(errors).toEqual([]);
});

test('raw practice telemetry saves references while Off and renders continuous saved-reference delta', async ({ page }) => {
  await openHud(page);
  await recordReferences(page);
  const records = await recordEntries(page);
  expect(records).toHaveLength(1);
  expect(records[0].value.best.totalUs).toBe(1_000_000);
  expect(records[0].value.opt.totalUs).toBe(1_000_000);
  await expect(page.getByTestId('sector-time-0')).toHaveText('0:00.500');
  await expect(page.getByTestId('sector-time-1')).toHaveText('0:00.500');
  const panelBox = await page.getByTestId('timing-sectors').boundingBox();
  const deltaBox = await page.getByTestId('timing-delta').boundingBox();
  expect(panelBox).not.toBeNull();
  expect(deltaBox).not.toBeNull();
  expect(panelBox!.y + panelBox!.height <= deltaBox!.y
    || deltaBox!.y + deltaBox!.height <= panelBox!.y
    || panelBox!.x + panelBox!.width <= deltaBox!.x
    || deltaBox!.x + deltaBox!.width <= panelBox!.x,
  'default timing widgets must not cover one another').toBe(true);

  await bridge.send(rawFrame({ ...previousResult(1.2), CompletedLaps: 2,
    LapDistanceFraction: 0.25, LapTimeCurrentSelf: 0.3,
    Player: { GameSimulationTime: 14.3 } }));
  await expect(page.getByTestId('delta-value')).toHaveText('+0.050');
  await bridge.send(rawFrame({ ...previousResult(1.2), CompletedLaps: 2,
    LapDistanceFraction: 0.5, LapTimeCurrentSelf: 0.65,
    Player: { GameSimulationTime: 14.65 } }));
  await expect(page.getByTestId('delta-value')).toHaveText('+0.150');
  await page.getByRole('button', { name: 'Cycle reference', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cycle reference', exact: true })).toContainText('Best');
  await expect(page.getByTestId('sector-total')).toHaveText('0:01.000');
  await expect(page.getByTestId('delta-value')).toHaveText('+0.150');
  await page.screenshot({ path: test.info().outputPath('timing-hud.png'), fullPage: true });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.screenshot({ path: '.test-results/hud-screenshot.png', fullPage: true });
  await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
  await page.screenshot({ path: '.test-results/hud-edit-screenshot.png', fullPage: true });
});

test('hotkey cycling ignores repeats and input targets', async ({ page }) => {
  await openHud(page);
  const cycle = page.getByRole('button', { name: 'Cycle reference', exact: true });
  await page.keyboard.down('Alt');
  await page.keyboard.down('t');
  await page.keyboard.down('t');
  await page.keyboard.up('t');
  await page.keyboard.up('Alt');
  await expect(cycle).toContainText('Opt');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('textbox', { name: 'Hotkey', exact: true }).focus();
  await page.keyboard.press('Alt+t');
  await expect(cycle).toContainText('Opt');
});

test('rebinding persists and the selected key works while placement is locked', async ({ page }) => {
  await openHud(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const hotkey = page.getByRole('textbox', { name: 'Hotkey', exact: true });
  await hotkey.press('Control+Alt+r');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Lock layout', exact: true }).click();
  const cycle = page.getByRole('button', { name: 'Cycle reference', exact: true });
  await page.keyboard.press('Alt+t');
  await expect(cycle).toContainText('Off');
  await page.keyboard.press('Control+Alt+r');
  await expect(cycle).toContainText('Opt');
  await page.reload();
  await expect(cycle).toContainText('Opt');
  await page.keyboard.press('Control+Alt+r');
  await expect(cycle).toContainText('Best');
  await expect(page.getByRole('button', { name: 'Lock layout', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('dragging and wheel scaling survive reload and remain isolated by layout profile', async ({ page }) => {
  await openHud(page);
  await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
  const frame = page.locator('[data-widget-id="timing.sectors"]');
  const before = await frame.evaluate(element => ({ left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top, transform: (element as HTMLElement).style.transform }));
  const box = await frame.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 15, box!.y + 15);
  await page.mouse.down();
  await page.mouse.move(box!.x + 105, box!.y + 65, { steps: 6 });
  await page.mouse.up();
  await page.mouse.wheel(0, -120);
  await expect.poll(() => frame.evaluate(element => (element as HTMLElement).style.left)).not.toBe(before.left);
  await expect.poll(() => frame.evaluate(element => (element as HTMLElement).style.transform)).not.toBe(before.transform);
  const changed = await frame.getAttribute('style');
  await page.reload();
  await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
  await expect(frame).toHaveAttribute('style', changed!);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const profile = page.getByRole('combobox', { name: 'Layout profile', exact: true });
  await profile.selectOption('2');
  await expect(frame).not.toHaveAttribute('style', changed!);
  await profile.selectOption('1');
  await expect(frame).toHaveAttribute('style', changed!);
});

test('widget visibility is independent and survives reload', async ({ page }) => {
  await openHud(page);
  await page.getByRole('button', { name: 'Cycle reference', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Show sector panel', exact: true }).uncheck();
  await expect(page.getByTestId('timing-sectors')).toBeHidden();
  await expect(page.getByTestId('timing-delta')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('timing-sectors')).toBeHidden();
  await expect(page.getByTestId('timing-delta')).toBeVisible();
});

test('invalid raw telemetry cannot save a Best or Opt record', async ({ page }) => {
  await openHud(page);
  const samples = lapFrames(0, 1);
  samples[2] = { ...samples[2], LapValidState: 1 };
  await bridge.sendFrames(samples);
  await bridge.sendFrames(lapFrames(1, 1.2, 1).map(sample => ({ ...sample, LapValidState: 1, PrevLapValid: 0 })).slice(1));
  await page.getByRole('button', { name: 'Cycle reference', exact: true }).click();
  await expect(page.getByTestId('timing-sectors')).toContainText(/No saved/i);
  expect(await recordEntries(page)).toEqual([]);
});

test('reconnection interrupts a partial capture rather than joining across a lost connection', async ({ page }) => {
  await openHud(page);
  const samples = lapFrames(0, 1);
  await bridge.sendFrames(samples.slice(0, 3));
  bridge.disconnectAll();
  await expect.poll(() => bridge.connections()).toBeGreaterThan(1);
  await bridge.sendFrames(samples.slice(3));
  await page.getByRole('button', { name: 'Cycle reference', exact: true }).click();
  await expect(page.getByTestId('timing-sectors')).toContainText(/No saved/i);
  expect(await recordEntries(page)).toEqual([]);
});

test('a disconnected bridge clears the live delta while retaining the saved sector reference', async ({ page }) => {
  await openHud(page);
  await recordReferences(page);
  await bridge.send(rawFrame({ ...previousResult(1.2), CompletedLaps: 2,
    LapDistanceFraction: 0.25, LapTimeCurrentSelf: 0.3,
    Player: { GameSimulationTime: 14.3 } }));
  await bridge.send(rawFrame({ ...previousResult(1.2), CompletedLaps: 2,
    LapDistanceFraction: 0.5, LapTimeCurrentSelf: 0.65,
    Player: { GameSimulationTime: 14.65 } }));
  await expect(page.getByTestId('delta-value')).toHaveText('+0.150');
  bridge.pause();
  bridge.disconnectAll();
  await expect(page.getByTestId('connection-status')).toContainText(/Reconnecting/i);
  await expect(page.getByTestId('delta-value')).toHaveText('—');
  await expect(page.getByTestId('sector-total')).toHaveText('0:01.000');
  await expect.poll(() => bridge.connections()).toBeGreaterThan(1);
  await bridge.send(rawFrame({ ...previousResult(1.2), CompletedLaps: 2,
    LapDistanceFraction: 0.75, LapTimeCurrentSelf: 0.8,
    Player: { GameSimulationTime: 14.8 } }));
  await expect(page.getByTestId('delta-value')).toHaveText('+0.050');
});

test('demo records and preferences do not leak into live mode and live recording remains gated', async ({ page }) => {
  await openHud(page);
  await recordReferences(page);
  await expect(page.getByTestId('sector-total')).toHaveText('0:01.000');
  await page.goto(`/?ws=${bridge.authority}`);
  await expect(page.getByRole('button', { name: 'Cycle reference', exact: true })).toContainText('Off');
  await page.getByRole('button', { name: 'Cycle reference', exact: true }).click();
  await expect(page.getByTestId('timing-sectors')).toContainText(/No saved/i);
  const before = (await recordEntries(page)).map(entry => entry.key);
  // The bridge is at the start of lap 3 (CompletedLaps=2) after training.
  // Feed that complete lap so an accidentally enabled live writer would write.
  await bridge.sendFrames(lapFrames(2, 0.8, 1.2));
  await expect(page.getByTestId('recording-status')).toContainText(/disabled|await|unverified|validation|gated/i);
  expect((await recordEntries(page)).map(entry => entry.key)).toEqual(before);
});
