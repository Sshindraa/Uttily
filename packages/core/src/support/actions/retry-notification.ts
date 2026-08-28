import { eq } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { auditLog, notifications } from '@uttily/database';
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
 * Use case Support : Relance d'une notification transactionnelle en échec.
 * Ré-enfile la notification en PENDING de façon transactionnelle avec trace d'audit.
 */
export async function retryNotificationSupport(
  db: DatabaseClient,
  input: RetryNotificationInput,
): Promise<{ ok: true; notificationId: string }> {
  const { notificationId, actorUserId, reason } = input;

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

    if (notif.status === 'SENT') {
      throw new NotificationActionError(
        'SUPPORT_ACTION_INVALID_STATE',
        'Cette notification a déjà été envoyée avec succès.',
      );
    }

    const now = new Date();

    // 1. Remise en file PENDING
    await tx
      .update(notifications)
      .set({
        status: 'PENDING',
        nextAttemptAt: now,
        leaseToken: null,
        leaseUntil: null,
        failureCode: null,
        requiresManualReview: false,
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
        reason: reason?.trim() || 'Relance manuelle support',
        previousStatus: notif.status,
        previousFailureCode: notif.failureCode,
        recipient: notif.recipient,
        template: notif.template,
      },
    });

    return { ok: true, notificationId };
  });
}
