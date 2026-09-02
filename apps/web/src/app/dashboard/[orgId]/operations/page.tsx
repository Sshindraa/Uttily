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
  searchParams?: Promise<{
    status?: string | string[];
    locationId?: string | string[];
    date?: string | string[];
    search?: string | string[];
  }>;
}): Promise<never> {
  const { orgId } = await params;
  const sp = (await searchParams) ?? {};
  const query = new URLSearchParams();
  for (const key of ['status', 'locationId', 'date', 'search'] as const) {
    const value = sp[key];
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    } else if (value) {
      query.set(key, value);
    }
  }
  const suffix = query.toString();
  redirect(`/dashboard/${orgId}/bookings${suffix ? `?${suffix}` : ''}`);
}
