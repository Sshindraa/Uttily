import { redirect } from 'next/navigation';

/**
 * Route historique de transfert d'exemplaire (Chantier 3).
 *
 * Chantier 17.1-A — fermeture de l'arbre Inventaire : la Flotte canonique
 * n'expose pas encore d'action de transfert dédiée. Plutôt que de préserver
 * une URL qui rendrait une seconde interface Pro, cette route redirige
 * uniquement vers la surface canonique **Flotte**.
 */
export default async function LegacyInventoryTransferRedirect({
  params,
}: {
  params: Promise<{ orgId: string; itemId: string }>;
}): Promise<never> {
  const { orgId } = await params;
  redirect(`/dashboard/${orgId}/fleet`);
}
