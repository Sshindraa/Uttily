import { redirect } from 'next/navigation';

/**
 * Route historique Catalogue (Chantier 3).
 *
 * Chantier 17 — IA Pro définitive : Catalogue a été unifié dans **Mes vélos**.
 * Cette route redirige proprement vers `/dashboard/${orgId}/bikes`.
 */
export default async function LegacyCatalogRedirect({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<never> {
  const { orgId } = await params;
  redirect(`/dashboard/${orgId}/bikes`);
}
