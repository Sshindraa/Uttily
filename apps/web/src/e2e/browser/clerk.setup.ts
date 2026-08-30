import { clerk, clerkSetup } from '@clerk/testing/playwright';
import { test as setup, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

setup.describe.configure({ mode: 'serial' });

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const authFile = join(packageRoot, 'playwright', '.clerk', 'user.json');

function findWorkspaceRoot(startDirectory: string): string {
  let current = resolve(startDirectory);
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error('Workspace root not found.');
    current = parent;
  }
}

setup(
  'authenticate the dedicated Clerk TEST user and provision Uttily access',
  async ({ page }) => {
    await clerkSetup();

    const email = process.env.E2E_CLERK_USER_EMAIL;
    if (!email) throw new Error('Clerk TEST browser credentials are not configured.');

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await clerk.signIn({
      page,
      emailAddress: email,
    });

    // This real customer route executes getAuthenticatedUser() and therefore
    // provisionUserFromOidc() before the local membership fixture is applied.
    await page.goto('/fr/account/bookings', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Mes locations' })).toBeVisible();

    // The public shell must reflect the same authenticated Clerk session.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('navigation', { name: 'Navigation client' }).getByRole('link', {
        name: 'Se connecter',
      }),
    ).toHaveCount(0);

    execFileSync('pnpm', ['--filter', '@uttily/database', 'db:ensure-browser-e2e-membership'], {
      cwd: findWorkspaceRoot(packageRoot),
      env: process.env,
      stdio: 'inherit',
    });

    // The dashboard now crosses the real organization membership guard.
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'test-org-dev' })).toBeVisible();

    mkdirSync(dirname(authFile), { recursive: true });
    await page.context().storageState({ path: authFile });
  },
);
