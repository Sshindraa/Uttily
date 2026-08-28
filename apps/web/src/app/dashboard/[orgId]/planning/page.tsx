import { redirect } from 'next/navigation';

/**
 * Route historique du planning (Chantier 10).
 *
 * Chantier 17 — IA Pro définitive : le planning n'est plus une entrée de
 * navigation top-level ; il vit dans **Réservations**. Cette URL continue
 * de fonctionner via une redirection propre qui préserve les query params.
 */
export default async function LegacyPlanningRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams?: Promise<{ locationId?: string; from?: string; to?: string }>;
}): Promise<never> {
  const { orgId } = await params;
  const sp = (await searchParams) ?? {};
  const query = new URLSearchParams();
  if (sp.locationId) query.set('locationId', sp.locationId);
  if (sp.from) query.set('from', sp.from);
  if (sp.to) query.set('to', sp.to);
  const suffix = query.toString();
  redirect(`/dashboard/${orgId}/bookings/planning${suffix ? `?${suffix}` : ''}`);
}
