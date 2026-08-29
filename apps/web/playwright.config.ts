import { defineConfig } from '@playwright/test';

const testPort = process.env.PLAYWRIGHT_TEST_PORT ?? '3000';
if (!/^\d{1,5}$/.test(testPort) || Number(testPort) < 1 || Number(testPort) > 65535) {
  throw new Error('PLAYWRIGHT_TEST_PORT must be a valid TCP port.');
}

const baseURL = process.env.PLAYWRIGHT_TEST_BASE_URL ?? `http://localhost:${testPort}`;

export default defineConfig({
  testDir: './src/e2e/browser',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : 2,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'Mobile (375x812)',
      use: {
        viewport: { width: 375, height: 812 },
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      },
    },
    {
      name: 'Tablet (768x1024)',
      use: {
        viewport: { width: 768, height: 1024 },
      },
    },
    {
      name: 'Small Desktop (1024x768)',
      use: {
        viewport: { width: 1024, height: 768 },
      },
    },
    {
      name: 'Desktop (1440x900)',
      use: {
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: `pnpm --filter @uttily/web exec next dev --hostname 0.0.0.0 --port ${testPort}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
