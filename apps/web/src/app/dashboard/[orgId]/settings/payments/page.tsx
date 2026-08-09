import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getMembership, requireMembership, ROLE_MANAGERS } from '@uttily/core';
import { getConnectedAccountReadinessAction } from '@/app/actions/connected-accounts';
import { PaymentsSettingsClient } from './payments-settings-client';

// Page server-side des paramètres de paiement Stripe Connect.
// Autorisation : MANAGER+ (ROLE_MANAGERS). L'organizationId vient du paramètre
// de route [orgId], validé par le layout ; aucune valeur client n'est trustée.
export default async function PaymentsSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');
  const db = getDb();
  const membership = await getMembership(db, orgId, user.id);
  requireMembership(membership, ROLE_MANAGERS);

  const readiness = await getConnectedAccountReadinessAction(orgId);

  return (
    <main>
      <h1>Paiements Stripe</h1>
      <PaymentsSettingsClient organizationId={orgId} readiness={readiness} />
    </main>
  );
}
