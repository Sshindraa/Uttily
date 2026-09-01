import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const WIZARD_PATH = join(
  __dirname,
  '../../../../../..',
  'features/bikes/setup/bike-setup-wizard.tsx',
);

describe('BikeSetupPage (/bikes/[bikeId]/setup)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const wizardSource = readFileSync(WIZARD_PATH, 'utf8');

  it('charge getUnifiedBike et calcule dynamiquement la progression via resolveBikeSetupProgress', () => {
    expect(pageSource).toContain('requireCatalogManagerOf(orgId)');
    expect(pageSource).toContain('getUnifiedBike(db, organizationId, bikeId)');
    expect(pageSource).toContain('resolveBikeSetupProgress(bike)');
    expect(pageSource).toContain('if (bike === null) notFound()');
  });

  it('intègre les 5 étapes dans son wizard client', () => {
    expect(wizardSource).toContain('1. Mon équipement');
    expect(wizardSource).toContain('2. Mes photos');
    expect(wizardSource).toContain('3. Mon tarif');
    expect(wizardSource).toContain('4. Mes exemplaires');
    expect(wizardSource).toContain('5. Mettre en ligne');
  });

  it('appelle les actions de sauvegarde immédiate et de mise en ligne', () => {
    expect(wizardSource).toContain('updateProductAction');
    expect(wizardSource).toContain('saveDailyPricingPlanDraftAction');
    expect(wizardSource).toContain('bulkCreateInventoryItemsAction');
    expect(wizardSource).toContain('publishBikeFromSetupAction');
  });

  it('transmet le slug et réserve le Photo Coach au vélo', () => {
    expect(pageSource).toContain('categorySlug: bike.product.categorySlug');
    expect(pageSource).toContain('photoCount: bike.photos.count');
    expect(wizardSource).toContain('getCategoryPresentation(selectedCategorySlug)');
    expect(wizardSource).toContain("categoryPresentation.specificSections.includes('photo-slots')");
    expect(wizardSource).toContain("currentStep === 'PHOTOS' && hasBikePhotoModule");
    expect(wizardSource).toContain("currentStep === 'PHOTOS' && !hasBikePhotoModule");
    expect(wizardSource).toContain('<NeutralPhotoUploader');
  });

  it('laisse la présentation et les mutations interactives au wizard de la feature bikes', () => {
    expect(pageSource).toContain('<BikeSetupWizard');
    expect(pageSource).not.toContain('className=');
    expect(pageSource).not.toContain('<form');
  });
});
