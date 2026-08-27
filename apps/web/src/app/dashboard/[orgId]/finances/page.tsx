import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  getMembership,
  requireMembership,
  ROLE_MANAGERS,
  resolvePayoutAccountStatus,
  getMerchantFinanceOverview,
} from '@uttily/core';
import { getConnectedAccountReadinessAction } from '@/app/actions/connected-accounts';
import { FinancesHub } from './finances-hub';

export default async function FinancesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams?: Promise<{ locationId?: string; from?: string; to?: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const sp = (await searchParams) ?? {};

  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');
  const db = getDb();
  const membership = await getMembership(db, orgId, user.id);
  requireMembership(membership, ROLE_MANAGERS);

  const fromDate = sp.from ? new Date(sp.from) : undefined;
  const toDate = sp.to ? new Date(sp.to) : undefined;

  const [readiness, overview] = await Promise.all([
    getConnectedAccountReadinessAction(orgId),
    getMerchantFinanceOverview(db, orgId, {
      locationId: sp.locationId,
      from: fromDate,
      to: toDate,
    }),
  ]);

  const status = resolvePayoutAccountStatus(readiness);

  return <FinancesHub organizationId={orgId} status={status} overview={overview} />;
}
