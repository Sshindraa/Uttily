import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getMembership, requireMembership, LOCATION_MANAGERS } from '@uttily/core';
import { updateLocationAction } from '@/app/actions/locations';

export default async function EditLocationPage({
  params,
}: {
  params: Promise<{ orgId: string; locationId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, locationId } = await params;
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');
  const db = getDb();
  const membership = await getMembership(db, orgId, user.id);
  const active = requireMembership(membership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);

  const canManage = LOCATION_MANAGERS.includes(active.role);

  async function updateLocation(formData: FormData) {
    'use server';
    const name = String(formData.get('name') ?? '') || undefined;
    const timeZone = String(formData.get('timeZone') ?? '') || undefined;
    const addressLine1 = String(formData.get('addressLine1') ?? '') || undefined;
    const city = String(formData.get('city') ?? '') || undefined;
    const pickupEnabled = formData.get('pickupEnabled') === 'on';
    const payload: Parameters<typeof updateLocationAction>[2] = { pickupEnabled };
    if (name) payload.name = name;
    if (timeZone) payload.timeZone = timeZone;
    if (addressLine1) payload.addressLine1 = addressLine1;
    if (city) payload.city = city;
    await updateLocationAction(orgId, locationId, payload);
    redirect(`/dashboard/${orgId}/locations`);
  }

  return (
    <main>
      <h1>Établissement</h1>
      {canManage ? (
        <form action={updateLocation}>
          <label htmlFor="name">Nom</label>
          <input id="name" name="name" type="text" />

          <label htmlFor="timeZone">Fuseau IANA</label>
          <input id="timeZone" name="timeZone" type="text" />

          <label htmlFor="addressLine1">Adresse</label>
          <input id="addressLine1" name="addressLine1" type="text" />

          <label htmlFor="city">Ville</label>
          <input id="city" name="city" type="text" />

          <label htmlFor="pickupEnabled">Retrait activé</label>
          <input id="pickupEnabled" name="pickupEnabled" type="checkbox" defaultChecked />

          <button type="submit">Mettre à jour</button>
        </form>
      ) : (
        <p>Lecture seule. Rôle insuffisant pour modifier.</p>
      )}
    </main>
  );
}
