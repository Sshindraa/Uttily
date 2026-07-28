import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getMembership, requireMembership, LOCATION_MANAGERS } from '@uttily/core';
import { createLocationAction } from '@/app/actions/locations';

export default async function NewLocationPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');
  const db = getDb();
  const membership = await getMembership(db, orgId, user.id);
  requireMembership(membership, LOCATION_MANAGERS);

  async function createLocation(formData: FormData) {
    'use server';
    const name = String(formData.get('name') ?? '');
    const timeZone = String(formData.get('timeZone') ?? 'Europe/Paris');
    const addressLine1 = String(formData.get('addressLine1') ?? '') || undefined;
    const city = String(formData.get('city') ?? '') || undefined;
    const postalCode = String(formData.get('postalCode') ?? '') || undefined;
    const countryCode = String(formData.get('countryCode') ?? '') || undefined;
    const payload: Parameters<typeof createLocationAction>[0] = {
      organizationId: orgId,
      name,
      timeZone,
    };
    if (addressLine1) payload.addressLine1 = addressLine1;
    if (city) payload.city = city;
    if (postalCode) payload.postalCode = postalCode;
    if (countryCode) payload.countryCode = countryCode;
    await createLocationAction(payload);
    redirect(`/dashboard/${orgId}/locations`);
  }

  return (
    <main>
      <h1>Nouvel établissement</h1>
      <form action={createLocation}>
        <label htmlFor="name">Nom</label>
        <input id="name" name="name" type="text" required minLength={2} />

        <label htmlFor="timeZone">Fuseau IANA</label>
        <input id="timeZone" name="timeZone" type="text" defaultValue="Europe/Paris" required />

        <label htmlFor="addressLine1">Adresse</label>
        <input id="addressLine1" name="addressLine1" type="text" />

        <label htmlFor="city">Ville</label>
        <input id="city" name="city" type="text" />

        <label htmlFor="postalCode">Code postal</label>
        <input id="postalCode" name="postalCode" type="text" />

        <label htmlFor="countryCode">Pays (ISO 3166-1)</label>
        <input id="countryCode" name="countryCode" type="text" maxLength={2} />

        <button type="submit">Créer</button>
      </form>
    </main>
  );
}
