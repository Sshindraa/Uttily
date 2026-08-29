import { expect, test, type Page, type TestInfo } from '@playwright/test';

type ProSurface = {
  name: string;
  path: (organizationId: string) => string;
  heading: RegExp;
  url?: RegExp;
};

const surfaces: ProSurface[] = [
  {
    name: 'Pro shell / Accueil',
    path: (organizationId) => `/dashboard/${organizationId}`,
    heading: /Bonjour/,
    url: /\/dashboard\/[^/]+$/,
  },
  {
    name: 'Mes vélos',
    path: (organizationId) => `/dashboard/${organizationId}/bikes`,
    heading: /Mes vélos/,
  },
  {
    name: 'Réservations',
    path: (organizationId) => `/dashboard/${organizationId}/bookings`,
    heading: /Réservations/,
  },
  {
    name: 'Planning',
    path: (organizationId) => `/dashboard/${organizationId}/bookings/planning`,
    heading: /Planning Opérationnel/,
  },
  {
    name: 'Flotte',
    path: (organizationId) => `/dashboard/${organizationId}/fleet`,
    heading: /Flotte/,
  },
  {
    name: 'Maintenance',
    path: (organizationId) => `/dashboard/${organizationId}/fleet/maintenance`,
    heading: /Atelier & Maintenance/,
  },
  {
    name: 'Établissements',
    path: (organizationId) => `/dashboard/${organizationId}/locations`,
    heading: /Établissements/,
  },
  {
    name: 'Revenus',
    path: (organizationId) => `/dashboard/${organizationId}/finances`,
    heading: /Revenus & Versements/,
  },
  {
    name: 'Équipe',
    path: (organizationId) => `/dashboard/${organizationId}/team`,
    heading: /Équipe/,
  },
  {
    name: 'Paramètres',
    path: (organizationId) => `/dashboard/${organizationId}/settings`,
    heading: /Paramètres/,
    url: /\/settings\/company$/,
  },
  {
    name: 'Paramètres / Entreprise',
    path: (organizationId) => `/dashboard/${organizationId}/settings/company`,
    heading: /Paramètres/,
  },
  {
    name: 'Paramètres / Politiques',
    path: (organizationId) => `/dashboard/${organizationId}/settings/policies`,
    heading: /Paramètres/,
  },
  {
    name: 'Onboarding loueur',
    path: (organizationId) => `/dashboard/${organizationId}/onboarding`,
    heading: /Créer ma boutique Uttily|Votre boutique Uttily est prête !/,
  },
  {
    name: 'Redirection Opérations',
    path: (organizationId) => `/dashboard/${organizationId}/operations`,
    heading: /Réservations/,
    url: /\/bookings(?:\?|$)/,
  },
  {
    name: 'Redirection Catalogue historique',
    path: (organizationId) => `/dashboard/${organizationId}/catalog`,
    heading: /Mes vélos/,
    url: /\/bikes$/,
  },
];

async function expectNoGlobalHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
}

async function findOrganizationId(page: Page): Promise<string> {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
  const organizationLink = page.getByRole('link', { name: /test-org-dev/i });
  await expect(organizationLink).toBeVisible();
  const href = await organizationLink.getAttribute('href');
  const match = href?.match(/^\/dashboard\/([0-9a-f-]+)$/i);
  expect(match, 'Le lien de l’organisation de test doit utiliser son UUID interne.').not.toBeNull();
  return match?.[1] ?? '';
}

async function expectUsableProNavigation(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? 1440;
  if (width <= 1024) {
    const openMenu = page.getByRole('button', { name: 'Ouvrir le menu' });
    await expect(openMenu).toBeVisible();
    await openMenu.click();
  }

  const navigation = page.getByRole('navigation', { name: 'Navigation principale' });
  await expect(navigation).toBeVisible();
  const reservationsLink = navigation.getByRole('link', { name: 'Réservations' });
  await expect(reservationsLink).toBeVisible();
  const box = await reservationsLink.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    expect(box.width).toBeGreaterThanOrEqual(40);
    expect(box.height).toBeGreaterThanOrEqual(40);
  }
}

async function visitSurface(page: Page, surface: ProSurface, testInfo: TestInfo): Promise<void> {
  expect(page.viewportSize()).toEqual(testInfo.project.use.viewport);
  const unexpectedStatuses: number[] = [];
  const pageErrors: string[] = [];
  page.on('response', (response) => {
    if ([401, 403, 500].includes(response.status())) unexpectedStatuses.push(response.status());
  });
  page.on('pageerror', () => pageErrors.push('pageerror'));

  const organizationId = await findOrganizationId(page);
  await page.goto(surface.path(organizationId), { waitUntil: 'domcontentloaded' });
  if (surface.url) await expect(page).toHaveURL(surface.url);
  await expect(page.getByRole('main').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: surface.heading }).first()).toBeVisible();
  await expectUsableProNavigation(page);
  await expectNoGlobalHorizontalOverflow(page);

  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toMatch(/stack trace|postgresql|oidc|rbac|uuid/i);
  expect(unexpectedStatuses, `${surface.name} ne doit pas répondre 401/403/500`).toEqual([]);
  expect(pageErrors, `${surface.name} ne doit pas produire d’erreur navigateur`).toEqual([]);
}

test.describe('Authenticated Pro browser evidence', () => {
  for (const surface of surfaces) {
    test(surface.name, async ({ page }, testInfo) => {
      await visitSurface(page, surface, testInfo);
    });
  }

  test('navigation Pro utilisable au clavier avec le vrai focus', async ({ page }, testInfo) => {
    expect(page.viewportSize()).toEqual(testInfo.project.use.viewport);
    const organizationId = await findOrganizationId(page);
    await page.goto(`/dashboard/${organizationId}`, { waitUntil: 'domcontentloaded' });
    const width = page.viewportSize()?.width ?? 1440;
    if (width <= 1024) {
      await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
    }
    const reservationsLink = page
      .getByRole('navigation', { name: 'Navigation principale' })
      .getByRole('link', { name: 'Réservations' });
    await reservationsLink.focus();
    await expect(reservationsLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/bookings$/);
    await expect(page.getByRole('heading', { name: 'Réservations' })).toBeVisible();
  });

  test('filtre Revenus manipulable sans mutation métier', async ({ page }, testInfo) => {
    expect(page.viewportSize()).toEqual(testInfo.project.use.viewport);
    const organizationId = await findOrganizationId(page);
    await page.goto(`/dashboard/${organizationId}/finances`, { waitUntil: 'domcontentloaded' });
    const filter = page.getByRole('textbox', {
      name: 'Rechercher par référence, vélo, client',
    });
    await expect(filter).toBeVisible();
    await filter.focus();
    await expect(filter).toBeFocused();
    await filter.fill('DEMO-BOOKING');
    await expect(filter).toHaveValue('DEMO-BOOKING');
    await expectNoGlobalHorizontalOverflow(page);
  });
});
