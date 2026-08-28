import { eq } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { auditLog, notifications } from '@uttily/database';
import { validateManualNotificationRetry } from '../../notifications/manual-retry-policy';
import type { SupportActionContext } from '../types';

export interface RetryNotificationInput extends SupportActionContext {
  readonly notificationId: string;
}

export class NotificationActionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'NotificationActionError';
    this.code = code;
  }
}

/**
 * Use case Support : Relance sécurisée d'une notification transactionnelle en échec (Chantier 16.1).
 *
 * Invariants :
 * - Seul FAILED est éligible à une relance manuelle.
 * - PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED est strictement interdit (fail-closed, risque de doublon).
 * - Sémantique explicite : reset de status=PENDING, scheduledFor=now, nextAttemptAt=now,
 *   failedAt=null, failureCode=null, requiresManualReview=false, providerFirstAttemptStartedAt=null, attemptCount=0.
 * - Traçabilité complète dans audit_log avec les valeurs antérieures.
 */
export async function retryNotificationSupport(
  db: DatabaseClient,
  input: RetryNotificationInput,
): Promise<{ ok: true; notificationId: string }> {
  const { notificationId, actorUserId, reason } = input;

  if (!reason || reason.trim().length === 0) {
    throw new NotificationActionError(
      'SUPPORT_ACTION_INVALID_STATE',
      'Un motif explicite est obligatoire pour relancer une notification.',
    );
  }

  return db.transaction(async (tx) => {
    const [notif] = await tx
      .select()
      .from(notifications)
      .where(eq(notifications.id, notificationId))
      .for('update')
      .limit(1);

    if (!notif) {
      throw new NotificationActionError('NOT_FOUND', 'Notification introuvable.');
    }

    const validation = validateManualNotificationRetry(notif);
    if (!validation.allowed) {
      throw new NotificationActionError('SUPPORT_ACTION_INVALID_STATE', validation.reason);
    }

    const now = new Date();

    // 1. Remise en file PENDING avec sémantique explicite de nouveau cycle
    await tx
      .update(notifications)
      .set({
        status: 'PENDING',
        scheduledFor: now,
        nextAttemptAt: now,
        leaseToken: null,
        leaseUntil: null,
        failureCode: null,
        failedAt: null,
        requiresManualReview: false,
        providerFirstAttemptStartedAt: null,
        attemptCount: 0,
        updatedAt: now,
      })
      .where(eq(notifications.id, notificationId));

    // 2. Audit append-only
    await tx.insert(auditLog).values({
      actorUserId,
      action: 'SUPPORT_NOTIFICATION_RETRY',
      targetType: 'notification',
      targetId: notificationId,
      metadata: {
        reason: reason.trim(),
        previousStatus: notif.status,
        previousFailureCode: notif.failureCode,
        previousAttemptCount: notif.attemptCount,
        previousFailedAt: notif.failedAt ? notif.failedAt.toISOString() : null,
        previousRequiresManualReview: notif.requiresManualReview,
        recipient: notif.recipient,
        template: notif.template,
      },
    });

    return { ok: true, notificationId };
  });
}
