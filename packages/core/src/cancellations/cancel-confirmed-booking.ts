import { and, eq, inArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { DatabaseClient } from '@uttily/database';
import {
  bookingCancellations,
  bookingItems,
  bookings,
  inventoryBlocks,
  outboxEvents,
  refunds,
} from '@uttily/database';
import { CatalogError } from '../catalog/errors';
import { reserveKey, lockKey, completeKey, failKey } from '../idempotency/idempotency';
import { previewBookingCancellation } from './preview-booking-cancellation';
import type { CancelConfirmedBookingInput, CancelConfirmedBookingResult } from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function computeCancelBookingFingerprint(input: CancelConfirmedBookingInput): string {
  const payload = JSON.stringify({
    org: input.organizationId,
    booking: input.bookingId,
    actor: input.actorUserId,
    reason: input.actorReason,
  });
  return createHash('sha256').update(payload).digest('hex');
}

export async function cancelConfirmedBooking(
  db: DatabaseClient,
  input: CancelConfirmedBookingInput,
): Promise<CancelConfirmedBookingResult> {
  if (!UUID_REGEX.test(input.organizationId)) {
    throw new CatalogError('VALIDATION', 'organizationId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(input.bookingId)) {
    throw new CatalogError('VALIDATION', 'bookingId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(input.actorUserId)) {
    throw new CatalogError('VALIDATION', 'actorUserId doit être un UUID valide.');
  }
  if (!input.idempotencyKey || input.idempotencyKey.trim().length === 0) {
    throw new CatalogError('VALIDATION', 'idempotencyKey obligatoire.');
  }

  const now = input.now ?? new Date();
  const fingerprint = computeCancelBookingFingerprint(input);

  // 1. Idempotency pre-check
  const reservation = await reserveKey(db, {
    organizationId: input.organizationId,
    operation: 'CANCEL_CONFIRMED_BOOKING',
    key: input.idempotencyKey,
    requestFingerprint: fingerprint,
  });

  if (reservation.kind === 'REPLAY') {
    return reservation.record.responseBody as CancelConfirmedBookingResult;
  }

  if (reservation.kind === 'CONFLICT') {
    throw new CatalogError(
      'CONFLICT_IDEMPOTENCY',
      "La clé d'idempotence a déjà été utilisée avec des paramètres différents.",
    );
  }

  // 2. Transaction métier d'annulation
  try {
    const result = await db.transaction(async (tx) => {
      await lockKey(tx, reservation.record.id);

      // Verrouillage SELECT FOR UPDATE de la réservation
      const lockedBookings = await tx
        .select()
        .from(bookings)
        .where(
          and(eq(bookings.id, input.bookingId), eq(bookings.organizationId, input.organizationId)),
        )
        .for('update');

      if (lockedBookings.length === 0) {
        throw new CatalogError('NOT_FOUND', 'Réservation introuvable.');
      }

      const booking = lockedBookings[0]!;

      // Invariant : Seules les réservations CONFIRMED ou READY_FOR_PICKUP peuvent être annulées
      if (booking.status !== 'CONFIRMED' && booking.status !== 'READY_FOR_PICKUP') {
        throw new CatalogError(
          'BLOCK_INVALID_TRANSITION',
          `Impossible d'annuler la réservation dans l'état "${booking.status}". Seules les réservations confirmées ou prêtes peuvent être annulées.`,
        );
      }

      // Évaluation des règles de remboursement sur le snapshot immuable
      const preview = await previewBookingCancellation(tx, input.organizationId, input.bookingId, {
        actorReason: input.actorReason,
        now,
      });

      if (!preview.allowed) {
        throw new CatalogError(
          'BLOCK_INVALID_TRANSITION',
          preview.reasonDisallowed ?? "L'annulation n'est pas autorisée.",
        );
      }

      // 3. Mise à jour du statut de la réservation à CANCELLED
      await tx
        .update(bookings)
        .set({
          status: 'CANCELLED',
          updatedAt: sql`now()`,
        })
        .where(eq(bookings.id, input.bookingId));

      // 4. Libération immédiate des blocs d'inventaire
      const items = await tx
        .select({ bookingBlockId: bookingItems.bookingBlockId })
        .from(bookingItems)
        .where(eq(bookingItems.bookingId, input.bookingId));

      const blockIds = items.map((i) => i.bookingBlockId).filter(Boolean);
      if (blockIds.length > 0) {
        await tx
          .update(inventoryBlocks)
          .set({
            status: 'RELEASED',
            updatedAt: sql`now()`,
          })
          .where(and(inArray(inventoryBlocks.id, blockIds), eq(inventoryBlocks.status, 'ACTIVE')));
      }

      await tx
        .update(inventoryBlocks)
        .set({
          status: 'RELEASED',
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(inventoryBlocks.sourceId, input.bookingId), eq(inventoryBlocks.status, 'ACTIVE')),
        );

      // 5. Création du remboursement PENDING si applicable
      let refundId: string | null = null;
      if (preview.refundAmountMinor > 0 && booking.paymentId) {
        const refundReasonValue =
          input.actorReason === 'PAYMENT_COMPENSATION'
            ? 'AMENDMENT_COMPENSATION'
            : input.actorReason;

        const refundRows = await tx
          .insert(refunds)
          .values({
            organizationId: input.organizationId,
            paymentId: booking.paymentId,
            reason: refundReasonValue,
            status: 'PENDING',
            amountMinor: preview.refundAmountMinor,
            currency: 'EUR',
            reverseTransfer: true,
            refundApplicationFee: preview.commissionRefundedMinor > 0,
            providerIdempotencyKey: `${input.idempotencyKey}:refund`,
            requestedAt: now,
          })
          .returning({ id: refunds.id });

        refundId = refundRows[0]!.id;
      }

      // 6. Insertion de la trace d'annulation
      const cancellationRows = await tx
        .insert(bookingCancellations)
        .values({
          organizationId: input.organizationId,
          bookingId: input.bookingId,
          cancelledByUserId: input.actorUserId,
          actorReason: input.actorReason,
          policyCode: preview.policyCode,
          policySnapshot: booking.cancellationPolicySnapshot,
          grossPaidMinor: preview.paidAmountMinor,
          refundAmountMinor: preview.refundAmountMinor,
          retainedAmountMinor: preview.retainedAmountMinor,
          originalCommissionMinor: preview.originalCommissionMinor,
          commissionRefundedMinor: preview.commissionRefundedMinor,
          finalCommissionMinor: preview.finalCommissionMinor,
          finalMerchantRevenueMinor: preview.finalMerchantRevenueMinor,
          currency: 'EUR',
          explanationCode: preview.explanationCode,
          inventoryReleased: true,
          refundId,
          occurredAt: now,
        })
        .returning({ id: bookingCancellations.id });

      const cancellationId = cancellationRows[0]!.id;

      // 7. Événement Outbox pour notification et exécution worker asynchrone
      await tx.insert(outboxEvents).values({
        organizationId: input.organizationId,
        aggregateType: 'booking',
        aggregateId: input.bookingId,
        eventType: 'booking.cancelled',
        eventVersion: 'v1',
        availableAt: now,
        idempotencyKey: `${input.idempotencyKey}:outbox`,
        payload: {
          bookingId: input.bookingId,
          cancellationId,
          refundId,
          refundAmountMinor: preview.refundAmountMinor,
          retainedAmountMinor: preview.retainedAmountMinor,
          actorReason: input.actorReason,
        },
      });

      const outcome: CancelConfirmedBookingResult = {
        cancellationId,
        bookingId: input.bookingId,
        status: 'CANCELLED',
        refundId,
        refundAmountMinor: preview.refundAmountMinor,
        retainedAmountMinor: preview.retainedAmountMinor,
        finalMerchantRevenueMinor: preview.finalMerchantRevenueMinor,
        inventoryReleased: true,
      };

      await completeKey(tx, reservation.record.id, {
        resourceId: cancellationId,
        responseBody: outcome,
        responseStatusCode: 200,
      });

      return outcome;
    });

    return result;
  } catch (error) {
    await db
      .transaction(async (tx) => {
        await failKey(tx, reservation.record.id, {
          responseBody: {
            error: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
          },
          responseStatusCode: 500,
        });
      })
      .catch(() => undefined);
    throw error;
  }
}
