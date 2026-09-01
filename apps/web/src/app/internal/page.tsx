import { searchSupport, listAuditLogsSupport } from '@uttily/core';
import { SupportCockpitView } from '@/features/internal';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';

export const dynamic = 'force-dynamic';

export default async function InternalCockpitPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { db } = await requireSupportPlatformAdmin();
  const { q } = await searchParams;
  const rawQuery = q?.trim();

  const searchResults = rawQuery ? await searchSupport(db, rawQuery, { limit: 15 }) : null;
  const recentAudit = !rawQuery ? await listAuditLogsSupport(db, { limit: 8 }) : [];

  return (
    <SupportCockpitView
      initialQuery={rawQuery ?? ''}
      searchResults={searchResults}
      recentAudit={recentAudit}
    />
  );
}
