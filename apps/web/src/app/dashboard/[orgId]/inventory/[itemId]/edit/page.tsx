import { redirect } from 'next/navigation';

/**
 * Route historique d'édition d'exemplaire (Chantier 3).
 *
 * Chantier 17.1-A — fermeture de l'arbre Inventaire : la flotte unitaire vit
 * désormais dans la surface canonique **Flotte**. Il n'existe aucune route
 * canonique par exemplaire (`/fleet/[itemId]`) ; plutôt que de créer une
 * nouvelle interface Pro, cette route redirige vers la Flotte.
 */
export default async function LegacyInventoryEditRedirect({
  params,
}: {
  params: Promise<{ orgId: string; itemId: string }>;
}): Promise<never> {
  const { orgId } = await params;
  redirect(`/dashboard/${orgId}/fleet`);
}
