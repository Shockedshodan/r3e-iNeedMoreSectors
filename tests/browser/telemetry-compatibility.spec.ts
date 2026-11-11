import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createBrowserBridge, rawFrame } from '../fixtures/browser-bridge.ts';
import type { RawRaceRoomFrame } from '../fixtures/browser-bridge.ts';

for (const source of ['captured 2.8', 'synthetic 3.77'] as const) {
  test(`normal HUD displays ${source} telemetry using exactly one connection`, async ({ page }) => {
    let packet: RawRaceRoomFrame;
    if (source === 'captured 2.8') {
      const bytes = await readFile(new URL('../fixtures/lap-count-windows/capture.jsonl', import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe('bb110b3ea564b86aa5c6b9a82db6acfe54ccf556db24d8ecb997e60dbfb85be6');
      // Send the original projected packet intact, including its absent names.
      packet = JSON.parse(bytes.toString('utf8').split('\n').find(line => {
        if (!line) return false;
        const row = JSON.parse(line);
        return row.seq === 9;
      })!).data;
      expect([packet.VersionMajor, packet.VersionMinor]).toEqual([2, 8]);
    } else {
      packet = rawFrame({ VersionMinor: 77, TrackName: 'Alternate minor circuit' });
    }
    const bridge = await createBrowserBridge();
    try {
      await page.goto(`/?ws=${bridge.authority}`);
      await expect.poll(() => bridge.activeConnections()).toBe(1);
      await expect.poll(() => bridge.polls()).toBeGreaterThan(0);
      await expect(page.getByTestId('connection-status')).not.toHaveText('RaceRoom practice connected');
      await bridge.send(packet);
      await expect(page.getByTestId('connection-status')).toHaveText('RaceRoom practice connected');
      if (source === 'synthetic 3.77') await expect(page.getByText('Alternate minor circuit')).toBeVisible();
      await expect(page.getByTestId('recording-status')).toContainText('Live record saving disabled');
      await expect(page.locator('body')).not.toContainText(/unsupported.*version|expected 3\.6|version.mismatch/i);
      expect(bridge.activeConnections()).toBe(1);
      expect(bridge.connections()).toBe(1);
      expect(await page.evaluate(() => Object.entries(localStorage).filter(([, value]) => {
        try { return Boolean(JSON.parse(value).best); } catch { return false; }
      }))).toEqual([]);
    } finally {
      await bridge.close();
    }
  });
}
