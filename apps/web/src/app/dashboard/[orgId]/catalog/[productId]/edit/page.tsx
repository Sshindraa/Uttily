import { redirect } from 'next/navigation';

/**
 * Route historique d'édition produit (Chantier 3).
 *
 * Chantier 17.1-A — fermeture de l'arbre Catalogue : l'édition d'un produit vit
 * désormais dans la fiche canonique **Mes équipements**. Cette route redirige
 * uniquement ; elle ne rend plus aucune interface Pro.
 */
export default async function LegacyCatalogEditRedirect({
  params,
}: {
  params: Promise<{ orgId: string; productId: string }>;
}): Promise<never> {
  const { orgId, productId } = await params;
  redirect(`/dashboard/${orgId}/bikes/${productId}`);
}
