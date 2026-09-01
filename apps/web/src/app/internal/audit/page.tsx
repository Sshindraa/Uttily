import { listAuditLogsSupport } from '@uttily/core';
import { AuditSupportView } from '@/features/internal';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';

export const dynamic = 'force-dynamic';

export default async function AuditSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ targetId?: string; targetType?: string }>;
}) {
  const { db } = await requireSupportPlatformAdmin();
  const { targetId, targetType } = await searchParams;
  const logs = await listAuditLogsSupport(db, {
    targetId,
    targetType,
    limit: 100,
  });

  return <AuditSupportView logs={logs} />;
}
