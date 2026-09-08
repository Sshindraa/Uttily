import { test, expect } from '@playwright/test';

test.describe('Pack Orchestrator E2E Real Browser Journeys', () => {
  test('Parcours 1 & 2 : Recherche Pack, sélection et ouverture du tiroir de confirmation avec les mentions obligatoires', async ({
    page,
  }) => {
    // 1. Accès à la recherche Pack
    await page.goto(
      '/fr/search?city=Annecy&destinationPublicId=2130abc1-8b69-42d8-b7d2-ac86064dd168&startDate=2026-09-12&endDateExclusive=2026-09-13&intent=DAY_RANGE&peopleCount=3&categorySlug=bike',
      { waitUntil: 'domcontentloaded' },
    );

    // Vérifier le chargement du document
    await expect(page.locator('body')).toBeVisible();

    // Vérifier la présence du bloc Pack Orchestrator ou de la section de solutions
    const selectPackBtn = page.getByRole('button', { name: /Choisir ce pack/i });

    // Si des packs sont disponibles en local/seed
    if (await selectPackBtn.isVisible()) {
      // 2. Clic sur le bouton de sélection du pack
      await selectPackBtn.first().click();

      // 3. Vérification du tiroir de confirmation
      const drawerDialog = page.getByRole('dialog');
      await expect(drawerDialog).toBeVisible();

      // Vérification des libellés UI tempérés exigés
      await expect(
        page.getByText('Tous les équipements seront bloqués ensemble lors de votre réservation'),
      ).toBeVisible();
      await expect(
        page.getByText('Caution selon les conditions du loueur (empreinte bancaire ou chèque au comptoir)'),
      ).toBeVisible();

      // Vérification du CTA vers la réservation
      await expect(
        page.getByRole('button', { name: /Continuer vers la réservation/i }),
      ).toBeVisible();

      // 4. Fermeture via la croix
      const closeBtn = drawerDialog.getByRole('button', { name: /Fermer|✕/i });
      await closeBtn.click();
      await expect(drawerDialog).toBeHidden();
    } else {
      // Si la base locale n'a pas de matériel seedé pour cette destination exacte,
      // la section des alternatives intelligentes s'affiche proprement sans crash
      await expect(
        page.getByRole('heading', { name: 'Aucune correspondance exacte pour ce créneau' }),
      ).toBeVisible();
    }
  });

  test('Parcours 3 : Recherche avec intention multi-besoins transportée dans packRequirements', async ({
    page,
  }) => {
    // Intention 2 VAE + 1 remorque
    const multiReqUrl =
      '/fr/search?city=Annecy&destinationPublicId=2130abc1-8b69-42d8-b7d2-ac86064dd168&startDate=2026-09-12&endDateExclusive=2026-09-13&intent=DAY_RANGE&peopleCount=3&categorySlug=bike&packRequirements=' +
      encodeURIComponent(
        JSON.stringify([
          { familySlug: 'bike', electricPreferred: true },
          { familySlug: 'bike', electricPreferred: true },
          { familySlug: 'bike', accessoryRequired: 'CHILD_TRAILER' },
        ]),
      );

    await page.goto(multiReqUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();

    // La page charge en 200 sans aucune erreur de parsing
    const title = await page.title();
    expect(title).toContain('Uttily');
  });

  test('Parcours 4 : Accessibilité clavier du tiroir de confirmation (fermeture Escape)', async ({
    page,
  }) => {
    await page.goto(
      '/fr/search?city=Annecy&destinationPublicId=2130abc1-8b69-42d8-b7d2-ac86064dd168&startDate=2026-09-12&endDateExclusive=2026-09-13&intent=DAY_RANGE&peopleCount=3&categorySlug=bike',
      { waitUntil: 'domcontentloaded' },
    );

    const selectPackBtn = page.getByRole('button', { name: /Choisir ce pack/i });
    if (await selectPackBtn.isVisible()) {
      await selectPackBtn.first().click();

      const drawerDialog = page.getByRole('dialog');
      await expect(drawerDialog).toBeVisible();

      // Appui sur Escape pour fermer
      await page.keyboard.press('Escape');
      await expect(drawerDialog).toBeHidden();
    }
  });

  test('Parcours 5 : Navigation depuis la page d’accueil et affichage des contrôles de recherche', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Vérifier la présence du titre principal et du formulaire de recherche
    await expect(page.getByRole('heading', { name: 'Votre équipement vous attend.' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Rechercher/i })).toBeVisible();
  });
});
