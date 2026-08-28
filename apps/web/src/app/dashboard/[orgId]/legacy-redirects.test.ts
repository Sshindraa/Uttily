import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Chantier 17.1-A — fermeture des routes héritées Catalogue / Inventaire.
 *
 * Ces tests exécutent réellement chaque page convertie : si une route rendait
 * encore une interface Pro, elle retournerait un élément React au lieu de lever
 * la redirection. La preuve est donc comportementale, pas textuelle.
 */

// `redirect()` lève dans le runtime Next ; on capture la destination.
const redirectCalls: string[] = [];
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    redirectCalls.push(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

import LegacyCatalogEdit from './catalog/[productId]/edit/page';
import LegacyCatalogVariantNew from './catalog/[productId]/variants/new/page';
import LegacyCatalogVariant from './catalog/[productId]/variants/[variantId]/page';
import LegacyCatalogVariantPricing from './catalog/[productId]/variants/[variantId]/pricing/page';
import LegacyInventoryEdit from './inventory/[itemId]/edit/page';
import LegacyInventoryTransfer from './inventory/[itemId]/transfer/page';

type LegacyPage = (args: {
  params: Promise<Record<string, string>>;
}) => Promise<never>;

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ID = '22222222-2222-4222-8222-222222222222';
const VARIANT_ID = '33333333-3333-4333-8333-333333333333';
const ITEM_ID = '44444444-4444-4444-8444-444444444444';

/**
 * Exécute la page héritée et exige qu'elle redirige vers `expectedUrl`.
 * Retourner un élément React (cas d'une interface encore rendue) fait échouer
 * le test, car aucune redirection ne serait levée.
 */
async function expectRedirect(
  page: LegacyPage,
  params: Record<string, string>,
  expectedUrl: string,
): Promise<void> {
  redirectCalls.length = 0;
  await expect(page({ params: Promise.resolve(params) })).rejects.toThrow(
    `NEXT_REDIRECT:${expectedUrl}`,
  );
  expect(redirectCalls).toEqual([expectedUrl]);
}

describe('Routes héritées converties en redirections (Chantier 17.1-A)', () => {
  describe('arbre Catalogue → fiche canonique Mes vélos', () => {
    it('/catalog/[productId]/edit → /bikes/[productId]', async () => {
      await expectRedirect(
        LegacyCatalogEdit as LegacyPage,
        { orgId: ORG_ID, productId: PRODUCT_ID },
        `/dashboard/${ORG_ID}/bikes/${PRODUCT_ID}`,
      );
    });

    it('/catalog/[productId]/variants/new → /bikes/[productId]', async () => {
      await expectRedirect(
        LegacyCatalogVariantNew as LegacyPage,
        { orgId: ORG_ID, productId: PRODUCT_ID },
        `/dashboard/${ORG_ID}/bikes/${PRODUCT_ID}`,
      );
    });

    it('/catalog/[productId]/variants/[variantId] → /bikes/[productId]', async () => {
      await expectRedirect(
        LegacyCatalogVariant as LegacyPage,
        { orgId: ORG_ID, productId: PRODUCT_ID, variantId: VARIANT_ID },
        `/dashboard/${ORG_ID}/bikes/${PRODUCT_ID}`,
      );
    });

    it('/catalog/[productId]/variants/[variantId]/pricing → /bikes/[productId]', async () => {
      await expectRedirect(
        LegacyCatalogVariantPricing as LegacyPage,
        { orgId: ORG_ID, productId: PRODUCT_ID, variantId: VARIANT_ID },
        `/dashboard/${ORG_ID}/bikes/${PRODUCT_ID}`,
      );
    });
  });

  describe('arbre Inventaire → surface canonique Flotte', () => {
    it('/inventory/[itemId]/edit → /fleet', async () => {
      await expectRedirect(
        LegacyInventoryEdit as LegacyPage,
        { orgId: ORG_ID, itemId: ITEM_ID },
        `/dashboard/${ORG_ID}/fleet`,
      );
    });

    it('/inventory/[itemId]/transfer → /fleet', async () => {
      await expectRedirect(
        LegacyInventoryTransfer as LegacyPage,
        { orgId: ORG_ID, itemId: ITEM_ID },
        `/dashboard/${ORG_ID}/fleet`,
      );
    });
  });

  describe('les cibles canoniques existent réellement', () => {
    it('la fiche vélo canonique existe', () => {
      expect(existsSync(join(__dirname, 'bikes/[bikeId]/page.tsx'))).toBe(true);
    });

    it('la surface Flotte canonique existe', () => {
      expect(existsSync(join(__dirname, 'fleet/page.tsx'))).toBe(true);
    });
  });

  describe('les anciens formulaires ont été supprimés', () => {
    it('aucun formulaire Catalogue ou Inventaire orphelin ne subsiste', () => {
      const deadFiles = [
        'catalog/[productId]/edit/edit-product-form.tsx',
        'catalog/[productId]/variants/new/new-variant-form.tsx',
        'catalog/[productId]/variants/[variantId]/edit-variant-form.tsx',
        'catalog/[productId]/variants/[variantId]/pricing/pricing-form.tsx',
        'inventory/[itemId]/edit/edit-inventory-form.tsx',
        'inventory/[itemId]/transfer/transfer-form.tsx',
      ];

      for (const rel of deadFiles) {
        expect(existsSync(join(__dirname, rel)), `${rel} devrait avoir été supprimé`).toBe(false);
      }
    });
  });
});
