import { redirect } from 'next/navigation';

/**
 * Route historique de création de variante (Chantier 3).
 *
 * Chantier 17.1-A — fermeture de l'arbre Catalogue : une variante se configure
 * depuis la fiche canonique **Mes vélos**. Cette route redirige uniquement.
 */
export default async function LegacyCatalogNewVariantRedirect({
  params,
}: {
  params: Promise<{ orgId: string; productId: string }>;
}): Promise<never> {
  const { orgId, productId } = await params;
  redirect(`/dashboard/${orgId}/bikes/${productId}`);
}
