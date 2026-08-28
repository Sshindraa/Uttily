import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import type { DatabaseClient, DbExecutor } from '@uttily/database';
import { notifications, organizations } from '@uttily/database';
import type { NotificationSupportListItem } from './types';

export interface ListNotificationsSupportOptions {
  readonly status?: string | undefined;
  readonly template?: string | undefined;
  readonly recipient?: string | undefined;
  readonly organizationId?: string | undefined;
  readonly bookingId?: string | undefined;
  readonly failedOnly?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/**
 * Liste les notifications transactionnelles pour le diagnostic support.
 * Zéro fuite de secret : aucun token d'invitation brut ni secret n'est retourné.
 */
export async function listNotificationsSupport(
  db: DatabaseClient | DbExecutor,
  options?: ListNotificationsSupportOptions,
): Promise<readonly NotificationSupportListItem[]> {
  const limit = Math.max(1, Math.min(options?.limit ?? 50, 100));
  const offset = Math.max(0, options?.offset ?? 0);

  const conditions = [];

  if (options?.organizationId) {
    conditions.push(eq(notifications.organizationId, options.organizationId));
  }

  if (options?.bookingId) {
    conditions.push(eq(notifications.bookingId, options.bookingId));
  }

  if (options?.status) {
    conditions.push(sql`${notifications.status} = ${options.status}`);
  }

  if (options?.template) {
    conditions.push(sql`${notifications.template} = ${options.template}`);
  }

  if (options?.recipient) {
    conditions.push(ilike(notifications.recipient, `%${options.recipient.trim()}%`));
  }

  if (options?.failedOnly) {
    conditions.push(
      sql`(${notifications.status} = 'FAILED' OR ${notifications.requiresManualReview} = true)`,
    );
  }

  const rows = await db
    .select({
      id: notifications.id,
      organizationId: notifications.organizationId,
      bookingId: notifications.bookingId,
      template: notifications.template,
      recipient: notifications.recipient,
      status: notifications.status,
      attemptCount: notifications.attemptCount,
      scheduledFor: notifications.scheduledFor,
      nextAttemptAt: notifications.nextAttemptAt,
      sentAt: notifications.sentAt,
      failedAt: notifications.failedAt,
      failureCode: notifications.failureCode,
      requiresManualReview: notifications.requiresManualReview,
      createdAt: notifications.createdAt,
      orgLegalName: organizations.legalName,
    })
    .from(notifications)
    .leftJoin(organizations, eq(notifications.organizationId, organizations.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    organizationName: r.orgLegalName ?? null,
    bookingId: r.bookingId,
    template: r.template,
    recipient: r.recipient,
    status: r.status,
    attemptCount: r.attemptCount,
    scheduledFor: r.scheduledFor,
    nextAttemptAt: r.nextAttemptAt,
    sentAt: r.sentAt,
    failedAt: r.failedAt,
    failureCode: r.failureCode,
    requiresManualReview: r.requiresManualReview ?? false,
    createdAt: r.createdAt,
  }));
}
