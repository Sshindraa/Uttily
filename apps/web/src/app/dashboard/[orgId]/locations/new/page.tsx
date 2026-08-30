import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getMembership, requireMembership, LOCATION_MANAGERS } from '@uttily/core';
import { createLocationAction } from '@/app/actions/locations';
import { LocationFormFields } from '../location-form-fields';
import { parseLocationFormData } from '../location-form';
import { Button, Card, LinkButton, PageHeader } from '@uttily/ui';

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
    await createLocationAction({ organizationId: orgId, ...parseLocationFormData(formData) });
    redirect(`/dashboard/${orgId}/locations`);
  }

  return (
    <div style={pageStyle}>
      <PageHeader
        eyebrow="Points de vente & ateliers"
        title="Nouvel établissement"
        description="Ajoutez un point de retrait avec ses horaires, consignes et coordonnées publiques."
        actions={
          <LinkButton href={`/dashboard/${orgId}/locations`} variant="secondary">
            Annuler
          </LinkButton>
        }
      />
      <Card as="section" aria-labelledby="location-form-heading">
        <h2 id="location-form-heading" className="sr-only">
          Informations du nouvel établissement
        </h2>
        <form action={createLocation}>
          <LocationFormFields />
          <Button type="submit">Créer l’établissement</Button>
        </form>
      </Card>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ut-space-8)',
  margin: '0 auto',
  maxWidth: '64rem',
};
