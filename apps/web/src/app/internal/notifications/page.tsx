import { listNotificationsSupport } from '@uttily/core';
import { NotificationsSupportView } from '@/features/internal';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';

export const dynamic = 'force-dynamic';

export default async function NotificationsSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { db } = await requireSupportPlatformAdmin();
  const { status } = await searchParams;

  const validStatus =
    status === 'FAILED' || status === 'PENDING' || status === 'SENT' || status === 'CANCELLED'
      ? status
      : undefined;
  const notifications = await listNotificationsSupport(db, {
    status: validStatus,
    limit: 50,
  });

  return <NotificationsSupportView notifications={notifications} validStatus={validStatus} />;
}
