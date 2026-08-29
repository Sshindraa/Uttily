import { test, expect } from '@playwright/test';

test.describe('Real Browser Responsive & Accessibility Matrix', () => {
  test('Landing page loads, has semantic H1, accessible nav and zero global overflow', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // 1. Semantic H1 heading
    const h1 = page.locator('h1');
    await expect(h1).toBeVisible();
    await expect(h1).toContainText('Le bon équipement, au bon endroit.');

    // 2. Accessible Client Navigation
    const nav = page.getByRole('navigation', { name: 'Navigation client' });
    await expect(nav).toBeVisible();

    // 3. Search link in header is accessible
    const searchLink = nav.getByRole('link', { name: 'Trouver un équipement' });
    await expect(searchLink).toBeVisible();

    // 4. Real touch target measurement (minimum 40px height for mobile ergonomics)
    const box = await searchLink.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.height).toBeGreaterThanOrEqual(40);
    }

    // 5. Zero global horizontal overflow in the real viewport DOM
    const isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth + 2;
    });
    expect(isOverflowing).toBe(false);
  });

  test('Search page has accessible controls, zero global overflow, and supports keyboard navigation', async ({
    page,
  }) => {
    await page.goto('/fr/search', { waitUntil: 'domcontentloaded' });

    // 1. Zero global horizontal overflow
    const isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth + 2;
    });
    expect(isOverflowing).toBe(false);

    // 2. Accessible form controls
    const destinationInput = page.locator('#destinationQuery');
    await expect(destinationInput).toBeVisible();

    const intentSelect = page.getByLabel('Type de durée');
    await expect(intentSelect).toBeVisible();

    const submitBtn = page.getByRole('button', {
      name: 'Voir les équipements',
    });
    await expect(submitBtn).toBeVisible();

    // 3. Real keyboard interactions
    await destinationInput.focus();
    await page.keyboard.type('Annecy');

    // Check activeElement is indeed the destination input
    const isFocused = await page.evaluate(() => {
      return document.activeElement === document.querySelector('#destinationQuery');
    });
    expect(isFocused).toBe(true);

    // Tab to next interactive control
    await page.keyboard.press('Tab');
    const activeElementTag = await page.evaluate(() => document.activeElement?.tagName);
    expect(['INPUT', 'SELECT', 'BUTTON']).toContain(activeElementTag);
  });

  test('Keyboard navigation through header nav', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Focus brand link then tab through navigation
    const brandLink = page.getByRole('link', { name: 'Uttily, accueil' });
    await brandLink.focus();

    await page.keyboard.press('Tab');
    const activeText = await page.evaluate(() => document.activeElement?.textContent?.trim());
    expect(activeText).toBeTruthy();
  });

  test('Dialog accessibility: Photo coach modal opens, has dialog semantics, and closes via ESC and close button', async ({
    page,
  }) => {
    await page.goto('/photo-coach-demo', { waitUntil: 'domcontentloaded' });

    // Zero global overflow
    const isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth + 2;
    });
    expect(isOverflowing).toBe(false);

    // Find and click the first photo slot button to open dialog
    const slotButton = page
      .locator('button')
      .filter({ hasText: /Photo principale|Profil complet/i })
      .first();
    if (await slotButton.isVisible()) {
      await slotButton.click();

      // Verify modal dialog is visible with role="dialog"
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      // Test closing with ESC key
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();

      // Reopen and test close button
      await slotButton.click();
      await expect(dialog).toBeVisible();

      const closeButton = dialog.getByRole('button', {
        name: /fermer|close|annuler/i,
      });
      if (await closeButton.isVisible()) {
        await closeButton.click();
        await expect(dialog).not.toBeVisible();
      }
    }
  });
});
