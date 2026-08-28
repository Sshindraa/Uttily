import { redirect } from 'next/navigation';

/**
 * Route historique Inventaire (Chantier 3).
 *
 * Chantier 17 — IA Pro définitive : Inventaire a été unifié dans **Flotte** (`/fleet`).
 * Cette route redirige proprement vers `/dashboard/${orgId}/fleet`.
 */
export default async function LegacyInventoryRedirect({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<never> {
  const { orgId } = await params;
  redirect(`/dashboard/${orgId}/fleet`);
}
