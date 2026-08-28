import { redirect } from 'next/navigation';

/**
 * Route historique de tarification par variante (Chantier 3).
 *
 * Chantier 17.1-A — fermeture de l'arbre Catalogue : la tarification se règle
 * depuis la fiche canonique **Mes vélos**. Cette route redirige uniquement.
 */
export default async function LegacyCatalogVariantPricingRedirect({
  params,
}: {
  params: Promise<{ orgId: string; productId: string; variantId: string }>;
}): Promise<never> {
  const { orgId, productId } = await params;
  redirect(`/dashboard/${orgId}/bikes/${productId}`);
}
