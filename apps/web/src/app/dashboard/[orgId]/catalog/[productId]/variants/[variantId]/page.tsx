import { redirect } from 'next/navigation';

/**
 * Route historique d'édition de variante (Chantier 3).
 *
 * Chantier 17.1-A — fermeture de l'arbre Catalogue : la variante n'est plus une
 * page autonome. L'identité, la taille et le tarif se pilotent depuis la fiche
 * canonique **Mes vélos**. Cette route redirige uniquement.
 */
export default async function LegacyCatalogVariantRedirect({
  params,
}: {
  params: Promise<{ orgId: string; productId: string; variantId: string }>;
}): Promise<never> {
  const { orgId, productId } = await params;
  redirect(`/dashboard/${orgId}/bikes/${productId}`);
}
