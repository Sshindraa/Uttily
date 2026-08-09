import type { DbExecutor } from '@uttily/database';
import { auditLog } from '@uttily/database';

/**
 * Journal d'audit append-only (invariant §3).
 * Sert à la traçabilité transverse : actions de l'admin Uttily, transitions
 * terrain (fulfillment), rapports d'état et dommages, etc.
 * Aucune UPDATE ni DELETE ne doit être appliquée à audit_log.
 */
export async function writeAuditEntry(
  db: DbExecutor,
  entry: {
    actorUserId?: string | null;
    action: string;
    targetType: string;
    targetId?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    metadata: entry.metadata ?? null,
  });
}
