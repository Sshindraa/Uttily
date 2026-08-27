import { and, eq, lte, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { notifications } from '@uttily/database';
import { renderNotificationRecord } from './load-notification-data';
import type { ProcessNotificationBatchResult, ProcessNotificationOptions } from './types';
import type { NotificationEmailSender } from './sender';

export interface ProcessDueNotificationsDependencies {
  readonly db: DatabaseClient;
  readonly emailSender: NotificationEmailSender;
}

export async function processDueNotifications(
  deps: ProcessDueNotificationsDependencies,
  options?: ProcessNotificationOptions,
): Promise<ProcessNotificationBatchResult> {
  const batchLimit = Math.max(1, Math.min(options?.batchLimit ?? 20, 100));
  const now = options?.now ?? new Date();

  // 1. Revendiquer un lot de notifications dues de manière concurrente sûre (SKIP LOCKED)
  const claimedNotifications = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(notifications)
      .where(and(eq(notifications.status, 'PENDING'), lte(notifications.scheduledFor, now)))
      .orderBy(notifications.scheduledFor, notifications.id)
      .limit(batchLimit)
      .for('update', { skipLocked: true });

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    await tx
      .update(notifications)
      .set({
        status: 'SENDING',
        attemptCount: sql`${notifications.attemptCount} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          sql`${notifications.id} IN (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        ),
      );

    return rows;
  });

  const result = {
    claimedCount: claimedNotifications.length,
    sentCount: 0,
    failedCount: 0,
    cancelledCount: 0,
  };

  if (claimedNotifications.length === 0) return result;

  // 2. Traiter chaque notification
  for (const item of claimedNotifications) {
    try {
      // Vérifier si la notification est devenue CANCELLED pendant l'attente
      const freshRows = await deps.db
        .select({ status: notifications.status })
        .from(notifications)
        .where(eq(notifications.id, item.id));

      if (freshRows[0]?.status === 'CANCELLED') {
        result.cancelledCount++;
        continue;
      }

      // Rendu dynamique du template avec les données fraîches de PostgreSQL
      const rendered = await renderNotificationRecord(deps.db, item);

      // Appel au fournisseur d'email avec la clé d'idempotence
      const sendResult = await deps.emailSender.send({
        recipient: item.recipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey: item.idempotencyKey,
      });

      // Mettre à jour en base comme SENT
      await deps.db
        .update(notifications)
        .set({
          status: 'SENT',
          providerMessageId: sendResult.messageId,
          sentAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(notifications.id, item.id));

      result.sentCount++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'UNKNOWN_ERROR';

      await deps.db
        .update(notifications)
        .set({
          status: 'FAILED',
          failureCode: errorMessage.slice(0, 255),
          failedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(notifications.id, item.id));

      result.failedCount++;
    }
  }

  return result;
}
