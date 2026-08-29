import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testPort = process.env.PLAYWRIGHT_TEST_PORT ?? '3000';
if (!/^\d{1,5}$/.test(testPort) || Number(testPort) < 1 || Number(testPort) > 65535) {
  throw new Error('PLAYWRIGHT_TEST_PORT must be a valid TCP port.');
}

const baseURL = process.env.PLAYWRIGHT_TEST_BASE_URL ?? `http://localhost:${testPort}`;
const packageRoot = dirname(fileURLToPath(import.meta.url));
const clerkAuthFile = join(packageRoot, 'playwright', '.clerk', 'user.json');

const publicProjects = [
  {
    name: 'Mobile (375x812)',
    testMatch: /responsive-and-a11y\.spec\.ts$/,
    use: {
      viewport: { width: 375, height: 812 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
    },
  },
  {
    name: 'Tablet (768x1024)',
    testMatch: /responsive-and-a11y\.spec\.ts$/,
    use: { viewport: { width: 768, height: 1024 } },
  },
  {
    name: 'Small Desktop (1024x768)',
    testMatch: /responsive-and-a11y\.spec\.ts$/,
    use: { viewport: { width: 1024, height: 768 } },
  },
  {
    name: 'Desktop (1440x900)',
    testMatch: /responsive-and-a11y\.spec\.ts$/,
    use: { viewport: { width: 1440, height: 900 } },
  },
];

const clerkBrowserConfigured =
  /^pk_test_[A-Za-z0-9_-]{16,}$/.test(process.env.CLERK_PUBLISHABLE_KEY ?? '') &&
  /^sk_test_[A-Za-z0-9_-]{16,}$/.test(process.env.CLERK_SECRET_KEY ?? '') &&
  (process.env.E2E_CLERK_USER_EMAIL?.trim().length ?? 0) > 0;

const proProjects = [
  {
    name: 'Pro Mobile (375x812)',
    testMatch: /pro-authenticated\.spec\.ts$/,
    dependencies: ['Clerk auth setup'],
    use: {
      viewport: { width: 375, height: 812 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      storageState: clerkAuthFile,
    },
  },
  {
    name: 'Pro Tablet (768x1024)',
    testMatch: /pro-authenticated\.spec\.ts$/,
    dependencies: ['Clerk auth setup'],
    use: { viewport: { width: 768, height: 1024 }, storageState: clerkAuthFile },
  },
  {
    name: 'Pro Small Desktop (1024x768)',
    testMatch: /pro-authenticated\.spec\.ts$/,
    dependencies: ['Clerk auth setup'],
    use: { viewport: { width: 1024, height: 768 }, storageState: clerkAuthFile },
  },
  {
    name: 'Pro Desktop (1440x900)',
    testMatch: /pro-authenticated\.spec\.ts$/,
    dependencies: ['Clerk auth setup'],
    use: { viewport: { width: 1440, height: 900 }, storageState: clerkAuthFile },
  },
];

const authenticatedProjects = clerkBrowserConfigured
  ? [
      {
        name: 'Clerk auth setup',
        testMatch: /clerk\.setup\.ts$/,
        use: { baseURL },
      },
      ...proProjects,
    ]
  : [];

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
  projects: [...publicProjects, ...authenticatedProjects],
  webServer: {
    command: `pnpm --filter @uttily/web exec next dev --hostname 0.0.0.0 --port ${testPort}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
