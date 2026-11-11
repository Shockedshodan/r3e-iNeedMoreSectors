import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const systemChromium = '/usr/bin/chromium';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  outputDir: '.test-results/browser',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    viewport: { width: 1280, height: 900 },
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        || (existsSync(systemChromium) ? systemChromium : undefined),
    },
  },
  webServer: {
    command: 'npm start -- --host 127.0.0.1 --port 3100 --no-open',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
