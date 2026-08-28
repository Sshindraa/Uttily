import { redirect } from 'next/navigation';

/**
 * Route historique Opérations (Chantier 6 / G4B).
 *
 * Chantier 17 — IA Pro définitive : Opérations a été unifié dans **Réservations** (`/bookings`).
 * Cette route redirige proprement vers `/dashboard/${orgId}/bookings` en préservant
 * les paramètres de filtre éventuels.
 */
export default async function LegacyOperationsRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams?: Promise<{ status?: string | string[] }>;
}): Promise<never> {
  const { orgId } = await params;
  const sp = (await searchParams) ?? {};
  const query = new URLSearchParams();
  if (sp.status) {
    if (Array.isArray(sp.status)) {
      for (const s of sp.status) query.append('status', s);
    } else {
      query.set('status', sp.status);
    }
  }
  const suffix = query.toString();
  redirect(`/dashboard/${orgId}/bookings${suffix ? `?${suffix}` : ''}`);
}
