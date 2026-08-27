import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getMembership, requireMembership, ROLE_MANAGERS } from '@uttily/core';
import { getConnectedAccountReadinessAction } from '@/app/actions/connected-accounts';
import { FinancesClient } from './finances-client';

export default async function FinancesPage({
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

  return <FinancesClient organizationId={orgId} readiness={readiness} />;
}
