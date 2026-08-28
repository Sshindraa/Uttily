import { and, desc, eq } from 'drizzle-orm';
import type { DatabaseClient, DbExecutor } from '@uttily/database';
import { auditLog, users } from '@uttily/database';
import type { AuditLogSupportListItem } from './types';

export interface ListAuditLogsSupportOptions {
  readonly targetType?: string | undefined;
  readonly targetId?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/**
 * Liste les entrées du journal d'audit append-only pour la console support.
 */
export async function listAuditLogsSupport(
  db: DatabaseClient | DbExecutor,
  options?: ListAuditLogsSupportOptions,
): Promise<readonly AuditLogSupportListItem[]> {
  const limit = Math.max(1, Math.min(options?.limit ?? 50, 100));
  const offset = Math.max(0, options?.offset ?? 0);

  const conditions = [];

  if (options?.targetType) {
    conditions.push(eq(auditLog.targetType, options.targetType));
  }

  if (options?.targetId) {
    conditions.push(eq(auditLog.targetId, options.targetId));
  }

  const rows = await db
    .select({
      id: auditLog.id,
      actorUserId: auditLog.actorUserId,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
      actorEmail: users.email,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorUserId, users.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map((r) => ({
    id: r.id,
    actorUserId: r.actorUserId,
    actorEmail: r.actorEmail ?? null,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    createdAt: r.createdAt,
  }));
}
