import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src/e2e/browser',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: 2,
  reporter: 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:3000',
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
    command:
      'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_dummy CLERK_SECRET_KEY=sk_test_dummy pnpm --filter @uttily/web dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 60000,
  },
});
