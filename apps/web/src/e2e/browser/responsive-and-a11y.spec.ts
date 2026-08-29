import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';

async function expectConfiguredViewport(page: Page, testInfo: TestInfo): Promise<void> {
  const configuredViewport = testInfo.project.use.viewport;
  expect(configuredViewport).toBeDefined();
  expect(page.viewportSize()).toEqual(configuredViewport);
}

async function expectNoGlobalHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
}

async function expectReasonableTouchTarget(locator: Locator, label: string): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${label} doit être mesurable dans le viewport`).not.toBeNull();
  if (!box) return;

  expect(box.width, `${label} : largeur réelle`).toBeGreaterThanOrEqual(40);
  expect(box.height, `${label} : hauteur réelle`).toBeGreaterThanOrEqual(40);
}

test.describe('Real Browser Responsive & Accessibility Matrix', () => {
  test('Landing loads with semantic navigation, usable controls, and no global overflow', async ({
    page,
  }, testInfo) => {
    await expectConfiguredViewport(page, testInfo);
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(
      page.getByRole('heading', { name: 'Le bon équipement, au bon endroit.' }),
    ).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Navigation client' });
    await expect(nav).toBeVisible();

    const searchLink = nav.getByRole('link', { name: 'Trouver un équipement' });
    await expect(searchLink).toBeVisible();
    await expectReasonableTouchTarget(searchLink, 'Lien de recherche Client');

    const signInLink = nav.getByRole('link', { name: 'Se connecter' });
    await expect(signInLink).toBeVisible();
    await expectReasonableTouchTarget(signInLink, 'Lien de connexion');

    await expectNoGlobalHorizontalOverflow(page);
  });

  test('Search form works with keyboard and opens the deterministic public offer', async ({
    page,
  }, testInfo) => {
    await expectConfiguredViewport(page, testInfo);
    await page.goto('/fr/search', { waitUntil: 'domcontentloaded' });
    await expectNoGlobalHorizontalOverflow(page);

    const destinationInput = page.getByRole('combobox', { name: 'Destination' });
    const intentSelect = page.getByLabel('Type de durée');
    const categorySelect = page.getByLabel('Catégorie');
    const submitButton = page.getByRole('button', { name: 'Voir les équipements' });

    await expect(destinationInput).toBeVisible();
    await expect(intentSelect).toBeVisible();
    await expect(categorySelect).toBeVisible();
    await expect(submitButton).toBeVisible();
    await expectReasonableTouchTarget(submitButton, 'CTA de recherche');

    await destinationInput.focus();
    await expect(destinationInput).toBeFocused();
    await destinationInput.pressSequentially('Lyon');
    await expect(page.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(destinationInput).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Enter');
    await expect(destinationInput).toHaveValue('Lyon · FR');
    await expect(destinationInput).toHaveAttribute('aria-expanded', 'false');

    await intentSelect.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByLabel('Début')).toBeVisible();
    await expect(page.getByLabel('Fin')).toBeVisible();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByLabel('Premier jour')).toBeVisible();
    await expect(page.getByLabel('Restitution')).toBeVisible();

    await page.getByLabel('Premier jour').fill('2030-06-10');
    await page.getByLabel('Restitution').fill('2030-06-11');
    await submitButton.focus();
    await expect(submitButton).toBeFocused();
    await page.keyboard.press('Space');

    await expect(page).toHaveURL(/\/fr\/search\?/);
    await expect(page.getByRole('heading', { name: /offre.*disponible/i })).toBeVisible();

    const offerCta = page.getByRole('link', { name: 'Voir l’offre et réserver' }).first();
    await expect(offerCta).toBeVisible();
    await expectReasonableTouchTarget(offerCta, 'CTA de réservation de l’offre');
    await offerCta.click();

    await expect(page).toHaveURL(/\/fr\/offers\/[^/]+\/[^/]+/);
    await expect(page.getByRole('heading', { name: 'Kayak de démonstration' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Réserver cet équipement' })).toBeVisible();
    await expectNoGlobalHorizontalOverflow(page);

    const startDate = page.getByLabel('Date de début (inclus)');
    const endDate = page.getByLabel('Date de fin (exclus)');
    await expect(startDate).toBeVisible();
    await expect(endDate).toBeVisible();
    await startDate.fill('2030-06-10');
    await endDate.fill('2030-06-11');

    const hourlyButton = page.getByRole('button', { name: 'Par heure' });
    await hourlyButton.focus();
    await page.keyboard.press('Enter');
    const startTime = page.getByLabel('Date et heure de début');
    const endTime = page.getByLabel('Date et heure de fin');
    await expect(startTime).toBeVisible();
    await expect(endTime).toBeVisible();
    await startTime.fill('2030-06-10T10:00');
    await endTime.fill('2030-06-10T11:00');

    const reserveButton = page.getByRole('button', { name: 'Réserver' });
    await expect(reserveButton).toBeVisible();
    await expectReasonableTouchTarget(reserveButton, 'CTA réserver');
    await reserveButton.focus();
    await page.keyboard.press('Space');

    // The browser must stop at the real auth boundary; it must not fake a checkout or payment.
    await expect(page).toHaveURL(/\/sign-in\?redirect_url=/);
  });

  test('Client navigation supports Tab, Shift+Tab, and Enter', async ({ page }, testInfo) => {
    await expectConfiguredViewport(page, testInfo);
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const brandLink = page.getByRole('link', { name: 'Uttily, accueil' });
    const searchLink = page
      .getByRole('navigation', { name: 'Navigation client' })
      .getByRole('link', { name: 'Trouver un équipement' });

    await brandLink.focus();
    await expect(brandLink).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(searchLink).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(brandLink).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/fr\/search$/);
  });

  test('Photo Coach dialog has semantics, focus management, keyboard close, and no overflow', async ({
    page,
  }, testInfo) => {
    await expectConfiguredViewport(page, testInfo);
    await page.goto('/photo-coach-demo', { waitUntil: 'domcontentloaded' });
    await expectNoGlobalHorizontalOverflow(page);

    const openButton = page.getByRole('button', { name: /Commencer par la vue profil/ });
    await expect(openButton).toBeVisible();
    await expectReasonableTouchTarget(openButton, 'CTA Photo Coach');
    await openButton.focus();
    await page.keyboard.press('Space');

    const dialog = page.getByRole('dialog', { name: /Photo Coach Uttily.*Profil Hero/ });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    const closeButton = dialog.getByRole('button', { name: 'Fermer le Photo Coach' });
    await expect(closeButton).toBeVisible();
    await expectReasonableTouchTarget(closeButton, 'Fermeture Photo Coach');
    await expect(closeButton).toBeFocused();

    await page.keyboard.press('Tab');
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.querySelector('[role="dialog"]')?.contains(document.activeElement),
        ),
      )
      .toBe(true);
    await page.keyboard.press('Shift+Tab');
    await expect(closeButton).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(openButton).toBeFocused();

    await page.keyboard.press('Space');
    await expect(dialog).toBeVisible();
    await expect(closeButton).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).not.toBeVisible();
    await expect(openButton).toBeFocused();
  });
});
