import { and, eq, gte, lte, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '@uttily/database';
import { bookings, notifications, organizationInvitations, organizations } from '@uttily/database';
import { renderNotificationRecord } from './load-notification-data';
import {
  NotificationSendError,
  type ProcessNotificationBatchResult,
  type ProcessNotificationOptions,
} from './types';
import type { NotificationEmailSender } from './sender';

export interface ProcessDueNotificationsDependencies {
  readonly db: DatabaseClient;
  readonly emailSender: NotificationEmailSender;
}

const DEFAULT_LEASE_DURATION_SECONDS = 60;
const MAX_TRANSIENT_ATTEMPTS = 5;
const RESEND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 heures

const ALLOWED_PICKUP_REMINDER_BOOKING_STATUSES = ['CONFIRMED', 'READY_FOR_PICKUP'] as const;
const ALLOWED_RETURN_REMINDER_BOOKING_STATUSES = ['ACTIVE'] as const;

export async function processDueNotifications(
  deps: ProcessDueNotificationsDependencies,
  options?: ProcessNotificationOptions,
): Promise<ProcessNotificationBatchResult> {
  const batchLimit = Math.max(1, Math.min(options?.batchLimit ?? 20, 100));
  const now = options?.now ?? new Date();
  const leaseDurationSec = options?.leaseDurationSeconds ?? DEFAULT_LEASE_DURATION_SECONDS;
  const leaseUntil = new Date(now.getTime() + leaseDurationSec * 1000);
  const leaseToken = randomUUID();

  // 1. Revendiquer un lot de notifications dues de manière concurrente sûre (SKIP LOCKED)
  const claimedNotifications = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(notifications)
      .where(
        or(
          and(
            eq(notifications.status, 'PENDING'),
            lte(notifications.scheduledFor, now),
            or(sql`${notifications.nextAttemptAt} IS NULL`, lte(notifications.nextAttemptAt, now)),
          ),
          and(
            eq(notifications.status, 'SENDING'),
            sql`${notifications.leaseUntil} IS NOT NULL`,
            lte(notifications.leaseUntil, now),
          ),
        ),
      )
      .orderBy(notifications.scheduledFor, notifications.id)
      .limit(batchLimit)
      .for('update', { skipLocked: true });

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    await tx
      .update(notifications)
      .set({
        status: 'SENDING',
        leaseToken,
        leaseUntil,
        attemptCount: sql`${notifications.attemptCount} + 1`,
        providerFirstAttemptStartedAt: sql`COALESCE(${notifications.providerFirstAttemptStartedAt}, ${now})`,
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

  let sentCount = 0;
  let failedCount = 0;
  let retriedCount = 0;
  let cancelledCount = 0;
  let leaseLostCount = 0;

  if (claimedNotifications.length === 0) {
    return {
      claimedCount: 0,
      sentCount: 0,
      failedCount: 0,
      retriedCount: 0,
      cancelledCount: 0,
      leaseLostCount: 0,
    };
  }

  // 2. Traiter chaque notification individuellement
  for (const item of claimedNotifications) {
    try {
      // 2a. Vérifier l'état actuel de la notification (si annulée entre temps par un autre flux)
      const freshRows = await deps.db
        .select({ status: notifications.status })
        .from(notifications)
        .where(eq(notifications.id, item.id));

      if (freshRows[0]?.status === 'CANCELLED') {
        cancelledCount++;
        continue;
      }

      // 2b. Cutoff 24h pré-appel : si une tentative précédente a eu lieu et a dépassé la fenêtre d'idempotence Resend (24h),
      // ne JAMAIS faire de nouvel appel réseau aveugle. Basculer directement en requiresManualReview.
      if (item.providerFirstAttemptStartedAt) {
        const elapsedSinceFirst = now.getTime() - item.providerFirstAttemptStartedAt.getTime();
        if (elapsedSinceFirst > RESEND_IDEMPOTENCY_WINDOW_MS) {
          const updated = await deps.db
            .update(notifications)
            .set({
              status: 'FAILED',
              requiresManualReview: true,
              leaseToken: null,
              leaseUntil: null,
              failureCode: 'PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED',
              failedAt: sql`now()`,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(notifications.id, item.id),
                eq(notifications.status, 'SENDING'),
                eq(notifications.leaseToken, leaseToken),
                gte(notifications.leaseUntil, now),
              ),
            )
            .returning({ id: notifications.id });

          if (updated.length === 0) {
            leaseLostCount++;
          } else {
            failedCount++;
          }
          continue;
        }
      }

      // 2c. Send-time eligibility check strict en allowlist pour les rappels de réservation
      if (
        item.bookingId &&
        (item.template === 'PICKUP_REMINDER_CUSTOMER' ||
          item.template === 'RETURN_REMINDER_CUSTOMER')
      ) {
        const bookingRows = await deps.db
          .select({ status: bookings.status })
          .from(bookings)
          .where(eq(bookings.id, item.bookingId));

        const bookingStatus = bookingRows[0]?.status;

        let isEligible = false;
        if (item.template === 'PICKUP_REMINDER_CUSTOMER') {
          isEligible =
            bookingStatus !== undefined &&
            (ALLOWED_PICKUP_REMINDER_BOOKING_STATUSES as readonly string[]).includes(bookingStatus);
        } else if (item.template === 'RETURN_REMINDER_CUSTOMER') {
          isEligible =
            bookingStatus !== undefined &&
            (ALLOWED_RETURN_REMINDER_BOOKING_STATUSES as readonly string[]).includes(bookingStatus);
        }

        if (!isEligible) {
          const updated = await deps.db
            .update(notifications)
            .set({
              status: 'CANCELLED',
              leaseToken: null,
              leaseUntil: null,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(notifications.id, item.id),
                eq(notifications.status, 'SENDING'),
                eq(notifications.leaseToken, leaseToken),
                gte(notifications.leaseUntil, now),
              ),
            )
            .returning({ id: notifications.id });

          if (updated.length === 0) {
            leaseLostCount++;
          } else {
            cancelledCount++;
          }
          continue;
        }
      }

      // 2c-bis. Send-time eligibility check strict pour les invitations d'équipe (Chantier 15.2)
      if (item.template === 'ORGANIZATION_INVITATION') {
        const meta = (item.metadata ?? {}) as { invitationId?: string };
        const invitationId = meta.invitationId || item.idempotencyKey?.replace(/^invitation:/, '');

        let isInvitationEligible = false;
        if (invitationId) {
          const invRows = await deps.db
            .select({
              status: organizationInvitations.status,
              expiresAt: organizationInvitations.expiresAt,
              orgStatus: organizations.status,
            })
            .from(organizationInvitations)
            .innerJoin(organizations, eq(organizationInvitations.organizationId, organizations.id))
            .where(eq(organizationInvitations.id, invitationId))
            .limit(1);

          const inv = invRows[0];
          if (
            inv &&
            inv.status === 'PENDING' &&
            inv.expiresAt > now &&
            inv.orgStatus === 'ACTIVE'
          ) {
            isInvitationEligible = true;
          }
        }

        if (!isInvitationEligible) {
          const updated = await deps.db
            .update(notifications)
            .set({
              status: 'CANCELLED',
              leaseToken: null,
              leaseUntil: null,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(notifications.id, item.id),
                eq(notifications.status, 'SENDING'),
                eq(notifications.leaseToken, leaseToken),
                gte(notifications.leaseUntil, now),
              ),
            )
            .returning({ id: notifications.id });

          if (updated.length === 0) {
            leaseLostCount++;
          } else {
            cancelledCount++;
          }
          continue;
        }
      }

      // 2d. Rendu dynamique du template avec les données fraîches de PostgreSQL
      const rendered = await renderNotificationRecord(deps.db, item);

      // 2e. Appel au fournisseur d'email avec la clé d'idempotence
      const sendResult = await deps.emailSender.send({
        recipient: item.recipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey: item.idempotencyKey,
      });

      // 2f. Fencing strict : Mettre à jour en base comme SENT uniquement si le lease nous appartient toujours
      const updated = await deps.db
        .update(notifications)
        .set({
          status: 'SENT',
          providerMessageId: sendResult.messageId,
          leaseToken: null,
          leaseUntil: null,
          sentAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(notifications.id, item.id),
            eq(notifications.status, 'SENDING'),
            eq(notifications.leaseToken, leaseToken),
            gte(notifications.leaseUntil, now),
          ),
        )
        .returning({ id: notifications.id });

      if (updated.length === 0) {
        leaseLostCount++;
      } else {
        sentCount++;
      }
    } catch (err) {
      const currentAttempt = item.attemptCount + 1;
      const firstAttemptStartedAt = item.providerFirstAttemptStartedAt ?? now;
      const elapsedSinceFirstAttempt = now.getTime() - firstAttemptStartedAt.getTime();

      let category: 'TRANSIENT' | 'DETERMINISTIC' | 'UNCERTAIN' = 'TRANSIENT';
      let failureCode = 'UNKNOWN_ERROR';

      if (err instanceof NotificationSendError) {
        category = err.category;
        failureCode = err.code;
      } else if (err instanceof Error) {
        failureCode = err.message.slice(0, 255);
      }

      // Classification & politique de retry avec fencing strict
      if (category === 'DETERMINISTIC') {
        // Échec définitif : ne pas retenter
        const updated = await deps.db
          .update(notifications)
          .set({
            status: 'FAILED',
            leaseToken: null,
            leaseUntil: null,
            failureCode,
            failedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(notifications.id, item.id),
              eq(notifications.status, 'SENDING'),
              eq(notifications.leaseToken, leaseToken),
              gte(notifications.leaseUntil, now),
            ),
          )
          .returning({ id: notifications.id });

        if (updated.length === 0) {
          leaseLostCount++;
        } else {
          failedCount++;
        }
      } else if (
        category === 'UNCERTAIN' &&
        elapsedSinceFirstAttempt > RESEND_IDEMPOTENCY_WINDOW_MS
      ) {
        // Fenêtre d'idempotence Resend (24h) dépassée en état incertain -> Manual Review obligatoire
        const updated = await deps.db
          .update(notifications)
          .set({
            status: 'FAILED',
            requiresManualReview: true,
            leaseToken: null,
            leaseUntil: null,
            failureCode: 'PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED',
            failedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(notifications.id, item.id),
              eq(notifications.status, 'SENDING'),
              eq(notifications.leaseToken, leaseToken),
              gte(notifications.leaseUntil, now),
            ),
          )
          .returning({ id: notifications.id });

        if (updated.length === 0) {
          leaseLostCount++;
        } else {
          failedCount++;
        }
      } else if (currentAttempt >= MAX_TRANSIENT_ATTEMPTS) {
        // Trop de retentatives -> Passage en FAILED + manual review
        const updated = await deps.db
          .update(notifications)
          .set({
            status: 'FAILED',
            requiresManualReview: true,
            leaseToken: null,
            leaseUntil: null,
            failureCode: 'MAX_RETRIES_EXCEEDED',
            failedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(notifications.id, item.id),
              eq(notifications.status, 'SENDING'),
              eq(notifications.leaseToken, leaseToken),
              gte(notifications.leaseUntil, now),
            ),
          )
          .returning({ id: notifications.id });

        if (updated.length === 0) {
          leaseLostCount++;
        } else {
          failedCount++;
        }
      } else {
        // Erreur transitoire ou incertaine dans la fenêtre -> Backoff exponentiel
        const backoffSeconds = Math.min(3600, Math.pow(2, currentAttempt) * 10);
        const nextAttemptAt = new Date(now.getTime() + backoffSeconds * 1000);

        const updated = await deps.db
          .update(notifications)
          .set({
            status: 'PENDING',
            leaseToken: null,
            leaseUntil: null,
            nextAttemptAt,
            failureCode,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(notifications.id, item.id),
              eq(notifications.status, 'SENDING'),
              eq(notifications.leaseToken, leaseToken),
              gte(notifications.leaseUntil, now),
            ),
          )
          .returning({ id: notifications.id });

        if (updated.length === 0) {
          leaseLostCount++;
        } else {
          retriedCount++;
        }
      }
    }
  }

  return {
    claimedCount: claimedNotifications.length,
    sentCount,
    failedCount,
    retriedCount,
    cancelledCount,
    leaseLostCount,
  };
}
