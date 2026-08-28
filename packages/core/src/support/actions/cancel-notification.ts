import { eq } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { auditLog, notifications } from '@uttily/database';
import type { SupportActionContext } from '../types';
import { NotificationActionError } from './retry-notification';

export interface CancelNotificationInput extends SupportActionContext {
  readonly notificationId: string;
}

/**
 * Use case Support : Annulation d'une notification en attente ou en erreur.
 */
export async function cancelNotificationSupport(
  db: DatabaseClient,
  input: CancelNotificationInput,
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
        'Impossible d\u2019annuler une notification déjà envoyée.',
      );
    }

    const now = new Date();

    // 1. Passage en CANCELLED
    await tx
      .update(notifications)
      .set({
        status: 'CANCELLED',
        leaseToken: null,
        leaseUntil: null,
        updatedAt: now,
      })
      .where(eq(notifications.id, notificationId));

    // 2. Audit append-only
    await tx.insert(auditLog).values({
      actorUserId,
      action: 'SUPPORT_NOTIFICATION_CANCEL',
      targetType: 'notification',
      targetId: notificationId,
      metadata: {
        reason: reason?.trim() || 'Annulation manuelle support',
        previousStatus: notif.status,
        recipient: notif.recipient,
        template: notif.template,
      },
    });

    return { ok: true, notificationId };
  });
}
