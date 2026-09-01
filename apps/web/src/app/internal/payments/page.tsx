import { listPaymentsSupport } from '@uttily/core';
import { PaymentsSupportView } from '@/features/internal';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';

export const dynamic = 'force-dynamic';

export default async function PaymentsSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { db } = await requireSupportPlatformAdmin();
  const { status } = await searchParams;

  const validStatus =
    status === 'FAILED' || status === 'PENDING' || status === 'SUCCEEDED' ? status : undefined;
  const payments = await listPaymentsSupport(db, {
    status: validStatus,
    limit: 50,
  });

  return <PaymentsSupportView payments={payments} validStatus={validStatus} />;
}
