import { requireSupportPlatformAdmin } from '@/lib/support-auth';
import { emitOperationalLog, getOperationalHealth, type OperationalHealth } from '@uttily/core';
import { HealthSupportView } from '@/features/internal';

export const dynamic = 'force-dynamic';

export default async function InternalHealthPage(): Promise<React.ReactElement> {
  const { db } = await requireSupportPlatformAdmin();

  let health: OperationalHealth | undefined;
  try {
    health = await getOperationalHealth(db);
  } catch {
    emitOperationalLog({
      operation: 'internal_health',
      outcome: 'failed',
      errorCode: 'HEALTH_READ_FAILED',
    });
  }

  return <HealthSupportView health={health} />;
}
