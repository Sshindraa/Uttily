import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';

async function expectConfiguredViewport(page: Page, testInfo: TestInfo): Promise<void> {
  const configuredViewport = testInfo.project.use.viewport;
  expect(configuredViewport).toBeDefined();
  expect(page.viewportSize()).toEqual(configuredViewport);
}

async function waitForClientHydration(page: Page): Promise<void> {
  await page.waitForFunction(() => document.readyState === 'complete');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
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
    await waitForClientHydration(page);

    await expect(
      page.getByRole('heading', { name: 'Votre équipement vous attend.' }),
    ).toBeVisible();

    const header = page.getByRole('banner');
    await expect(header).toBeVisible();

    const hostLink = header.getByRole('link', { name: 'Vous êtes loueur' });
    await expect(hostLink).toBeVisible();
    await expectReasonableTouchTarget(hostLink, 'Lien loueur');

    const languageButton = header.getByRole('button', { name: 'Choisir la langue' });
    await expect(languageButton).toBeVisible();
    await expectReasonableTouchTarget(languageButton, 'Choix de langue');

    const menuTrigger = header.locator('summary[aria-label="Menu principal"]');
    await expect(menuTrigger).toBeVisible();
    await expectReasonableTouchTarget(menuTrigger, 'Menu principal');
    await menuTrigger.click();
    const signInLink = header.getByRole('link', { name: 'Se connecter' });
    await expect(signInLink).toBeVisible();
    await expectReasonableTouchTarget(signInLink, 'Lien de connexion');

    await expectNoGlobalHorizontalOverflow(page);
  });

  test('Search form works with keyboard and opens the deterministic public offer', async ({
    page,
  }, testInfo) => {
    await expectConfiguredViewport(page, testInfo);
    await page.goto('/fr/search', { waitUntil: 'domcontentloaded' });
    await waitForClientHydration(page);
    await expectNoGlobalHorizontalOverflow(page);

    const searchForm = page.getByRole('form', { name: 'Rechercher un équipement' });
    const destinationButton = searchForm.getByRole('button', { name: /Destination/ });
    await destinationButton.click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const destinationInput = page.getByRole('combobox', { name: 'Rechercher une destination' });
    await expect(destinationInput).toBeVisible();
    await destinationInput.fill('Lyon');
    await expect(page.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(destinationButton).toContainText('Lyon');

    const equipmentButton = searchForm.getByRole('button', { name: /Équipement/ });
    await expect(equipmentButton).toContainText('Équipement');
    await page.getByRole('button', { name: 'Tous les équipements' }).click();

    const searchStartDate = page.getByLabel('Début');
    const searchEndDate = page.getByLabel('Dernier jour');
    await expect(searchStartDate).toBeVisible();
    await expect(searchEndDate).toBeVisible();
    await searchStartDate.fill('2030-06-10');
    await searchEndDate.fill('2030-06-11');
    await page.getByRole('button', { name: 'Valider les dates' }).click();

    const submitButton = searchForm.getByRole('button', { name: 'Rechercher' });
    await expect(submitButton).toBeVisible();
    await expectReasonableTouchTarget(submitButton, 'CTA de recherche');
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
    await waitForClientHydration(page);

    const brandLink = page.getByRole('link', { name: 'Uttily, accueil' });
    const hostLink = page.getByRole('link', { name: 'Vous êtes loueur' });
    const languageButton = page.getByRole('button', { name: 'Choisir la langue' });

    await brandLink.focus();
    await expect(brandLink).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(hostLink).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(brandLink).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(languageButton).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('dialog', { name: 'Personnalisez votre expérience' }),
    ).toBeVisible();
  });

  test('Photo Coach dialog has semantics, focus management, keyboard close, and no overflow', async ({
    page,
  }, testInfo) => {
    await expectConfiguredViewport(page, testInfo);
    await page.goto('/photo-coach-demo', { waitUntil: 'domcontentloaded' });
    await waitForClientHydration(page);
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
