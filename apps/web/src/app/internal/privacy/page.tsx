import { listPrivacyRequestsSupport } from '@uttily/core';
import { PrivacySupportView } from '@/features/internal';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';

export const dynamic = 'force-dynamic';

export default async function PrivacySupportPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: 'ACTIVE' | 'CLOSED' | 'ALL'; type?: string }>;
}) {
  const { db } = await requireSupportPlatformAdmin();
  const { tab = 'ACTIVE', type } = await searchParams;

  const data = await listPrivacyRequestsSupport(db, {
    tab,
    requestType: type,
    limit: 100,
  });

  return <PrivacySupportView initialData={data} filters={{ tab, requestType: type }} />;
}
