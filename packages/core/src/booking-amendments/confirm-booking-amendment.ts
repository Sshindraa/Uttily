/**
 * @uttily/core — confirmBookingAmendment (G7M-C5-B, ADR-023 §3-9, §11-13, §15).
 *
 * Orchestrateur canonique de confirmation de modification de réservation :
 * 1. Authentification et contrôle de membership strict (OWNER / ADMIN / MANAGER).
 * 2. Validation fail-closed des entrées et des 3 champs de liaison obligatoire à la preview :
 *    - expectedClassification ∈ { NEUTRAL, REFUND, SUPPLEMENT }
 *    - expectedDeltaAmountMinor (entier sûr)
 *    - expectedNextTotalAmountMinor (entier sûr >= 0)
 * 3. Vérification d'idempotence préalable sécurisée :
 *    - filtrage strict par les opérations autorisées (booking-amendment-neutral, booking-amendment-refund, booking-amendment-supplement) ;
 *    - ignorance des clés d'opérations étrangères ;
 *    - détection d'état incohérent si plusieurs records d'amendement existent pour la même clé (INVALID_STATE) ;
 *    - validation runtime stricte des champs du responseBody persisté (INVALID_STATE si corrompu/incomplet).
 * 4. Recalcul autoritaire de la prévisualisation côté serveur via previewBookingAmendment.
 * 5. Comparaison stricte et détection de dérive (PREVIEW_CHANGED).
 * 6. Dispatch transactionnel vers la mutation canonique (NEUTRAL, REFUND, SUPPLEMENT).
 * 7. Normalisation sans fuite technique (aucun refundId, amendmentPaymentId, amendmentPaymentAttemptId ni clientSecret).
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { idempotencyRecords } from '@uttily/database';
import { lockKey } from '../idempotency/idempotency';
import type { AuthenticatedUser } from '../identity/types';
import { getMembership } from '../identity/memberships';
import { requireMembership, LOCATION_MANAGERS, AuthorizationError } from '../identity/permissions';
import { previewBookingAmendment } from './preview-booking-amendment';
import { createNeutralBookingAmendment } from './create-neutral-booking-amendment';
import { createRefundBookingAmendment } from './create-refund-booking-amendment';
import { createSupplementBookingAmendment } from './create-supplement-booking-amendment';
import {
  validateCommandPayload,
  computeAmendmentFingerprint,
} from './execute-booking-amendment-internal';
import type {
  ConfirmBookingAmendmentCommand,
  ConfirmBookingAmendmentResult,
} from './types-amendment';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_AMENDMENT_OPERATIONS = [
  'booking-amendment-neutral',
  'booking-amendment-refund',
  'booking-amendment-supplement',
] as const;

type AllowedAmendmentOperation = (typeof ALLOWED_AMENDMENT_OPERATIONS)[number];

function extractIdempotencyReplay(
  rec: {
    operation: string;
    requestFingerprint: string;
    status: string;
    responseBody: unknown;
  },
  command: ConfirmBookingAmendmentCommand,
): ConfirmBookingAmendmentResult | null {
  if (!ALLOWED_AMENDMENT_OPERATIONS.includes(rec.operation as AllowedAmendmentOperation)) {
    return null;
  }

  let expectedFingerprintVersion:
    'amendment-neutral-v2' | 'amendment-refund-v1' | 'amendment-supplement-v1';

  if (rec.operation === 'booking-amendment-neutral') {
    expectedFingerprintVersion = 'amendment-neutral-v2';
  } else if (rec.operation === 'booking-amendment-refund') {
    expectedFingerprintVersion = 'amendment-refund-v1';
  } else {
    expectedFingerprintVersion = 'amendment-supplement-v1';
  }

  const currentFingerprint = computeAmendmentFingerprint(
    {
      bookingId: command.bookingId,
      expectedLastAppliedAmendmentNumber: command.expectedLastAppliedAmendmentNumber,
      intent: command.intent,
      desiredLines: command.desiredLines,
      idempotencyKey: command.idempotencyKey,
    },
    expectedFingerprintVersion,
  );

  if (rec.requestFingerprint !== currentFingerprint) {
    return { kind: 'IDEMPOTENCY_CONFLICT' };
  }

  if (rec.status === 'COMPLETED') {
    const body = rec.responseBody;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { kind: 'INVALID_STATE' };
    }

    const b = body as Record<string, unknown>;

    if (typeof b.amendmentId !== 'string' || !UUID_REGEX.test(b.amendmentId)) {
      return { kind: 'INVALID_STATE' };
    }

    if (
      typeof b.amendmentNumber !== 'number' ||
      !Number.isSafeInteger(b.amendmentNumber) ||
      b.amendmentNumber <= 0
    ) {
      return { kind: 'INVALID_STATE' };
    }

    if (rec.operation === 'booking-amendment-neutral') {
      return {
        kind: 'APPLIED_NEUTRAL',
        amendmentId: b.amendmentId,
        amendmentNumber: b.amendmentNumber,
        bookingId: command.bookingId,
        isReplay: true,
      };
    }

    if (rec.operation === 'booking-amendment-refund') {
      if (
        typeof b.refundAmountMinor !== 'number' ||
        !Number.isSafeInteger(b.refundAmountMinor) ||
        b.refundAmountMinor <= 0
      ) {
        return { kind: 'INVALID_STATE' };
      }

      return {
        kind: 'APPLIED_REFUND',
        amendmentId: b.amendmentId,
        amendmentNumber: b.amendmentNumber,
        bookingId: command.bookingId,
        refundAmountMinor: b.refundAmountMinor,
        currency: 'EUR',
        isReplay: true,
      };
    }

    if (rec.operation === 'booking-amendment-supplement') {
      if (
        typeof b.supplementAmountMinor !== 'number' ||
        !Number.isSafeInteger(b.supplementAmountMinor) ||
        b.supplementAmountMinor <= 0
      ) {
        return { kind: 'INVALID_STATE' };
      }

      if (typeof b.holdDeadline !== 'string' || Number.isNaN(Date.parse(b.holdDeadline))) {
        return { kind: 'INVALID_STATE' };
      }

      return {
        kind: 'PAYMENT_REQUIRED',
        amendmentId: b.amendmentId,
        amendmentNumber: b.amendmentNumber,
        bookingId: command.bookingId,
        supplementAmountMinor: b.supplementAmountMinor,
        currency: 'EUR',
        holdDeadline: b.holdDeadline,
        isReplay: true,
      };
    }
  }

  return null;
}

export async function confirmBookingAmendment(
  db: DatabaseClient,
  authenticatedActor: AuthenticatedUser,
  organizationId: string,
  command: ConfirmBookingAmendmentCommand,
  options?: { now?: Date },
): Promise<ConfirmBookingAmendmentResult> {
  // 1. Validation de l'acteur et de l'organisation
  if (
    typeof authenticatedActor !== 'object' ||
    authenticatedActor === null ||
    typeof authenticatedActor.id !== 'string' ||
    !UUID_REGEX.test(authenticatedActor.id)
  ) {
    return { kind: 'FORBIDDEN' };
  }

  if (typeof organizationId !== 'string' || !UUID_REGEX.test(organizationId)) {
    return { kind: 'INVALID_INPUT', message: 'organizationId invalide (UUID attendu).' };
  }

  if (typeof command !== 'object' || command === null) {
    return { kind: 'INVALID_INPUT', message: 'command doit être un objet.' };
  }

  if (typeof command.idempotencyKey !== 'string' || !UUID_REGEX.test(command.idempotencyKey)) {
    return { kind: 'INVALID_INPUT', message: 'idempotencyKey invalide (UUID attendu).' };
  }

  // Validation fail-closed des 3 champs de liaison à la prévisualisation
  if (
    command.expectedClassification !== 'NEUTRAL' &&
    command.expectedClassification !== 'REFUND' &&
    command.expectedClassification !== 'SUPPLEMENT'
  ) {
    return {
      kind: 'INVALID_INPUT',
      message: 'expectedClassification invalide (NEUTRAL, REFUND ou SUPPLEMENT attendu).',
    };
  }

  if (
    typeof command.expectedDeltaAmountMinor !== 'number' ||
    !Number.isSafeInteger(command.expectedDeltaAmountMinor)
  ) {
    return {
      kind: 'INVALID_INPUT',
      message: 'expectedDeltaAmountMinor doit être un entier valide.',
    };
  }

  if (
    typeof command.expectedNextTotalAmountMinor !== 'number' ||
    !Number.isSafeInteger(command.expectedNextTotalAmountMinor) ||
    command.expectedNextTotalAmountMinor < 0
  ) {
    return {
      kind: 'INVALID_INPUT',
      message: 'expectedNextTotalAmountMinor doit être un entier positif ou nul.',
    };
  }

  const payloadError = validateCommandPayload(
    command.bookingId,
    command.expectedLastAppliedAmendmentNumber,
    command.intent,
    command.desiredLines,
  );
  if (payloadError !== null) {
    return { kind: 'INVALID_INPUT', message: payloadError };
  }

  // 2. Contrôle de membership
  let membership;
  try {
    membership = await getMembership(db, organizationId, authenticatedActor.id);
  } catch {
    return { kind: 'FORBIDDEN' };
  }

  try {
    requireMembership(membership, LOCATION_MANAGERS);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { kind: 'FORBIDDEN' };
    }
    throw error;
  }

  // 3. Vérification d'idempotence préalable (REPLAY ou IDEMPOTENCY_CONFLICT avant tout appel preview)
  const existingRecords = await db
    .select({
      id: idempotencyRecords.id,
      operation: idempotencyRecords.operation,
      requestFingerprint: idempotencyRecords.requestFingerprint,
      status: idempotencyRecords.status,
      responseBody: idempotencyRecords.responseBody,
    })
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.organizationId, organizationId),
        eq(idempotencyRecords.key, command.idempotencyKey),
        inArray(idempotencyRecords.operation, [...ALLOWED_AMENDMENT_OPERATIONS]),
      ),
    );

  if (existingRecords.length > 1) {
    return { kind: 'INVALID_STATE' };
  }

  if (existingRecords.length === 1) {
    const rec = existingRecords[0]!;
    const replay = extractIdempotencyReplay(rec, command);
    if (replay) return replay;

    if (rec.status === 'PENDING') {
      const lockResult = await db.transaction(async (tx) => {
        return await lockKey(tx, rec.id);
      });
      if (lockResult.kind === 'REPLAY') {
        const lockedReplay = extractIdempotencyReplay(lockResult.record, command);
        if (lockedReplay) return lockedReplay;
      }
    }
  }

  // 4. Recalcul autoritaire de la prévisualisation côté serveur
  let preview;
  try {
    preview = await previewBookingAmendment(db, authenticatedActor, organizationId, {
      bookingId: command.bookingId,
      expectedLastAppliedAmendmentNumber: command.expectedLastAppliedAmendmentNumber,
      intent: command.intent,
      desiredLines: command.desiredLines,
    });
  } catch (err) {
    // Si une transaction concurrente a committé pendant le calcul du preview
    const lateRecords = await db
      .select({
        id: idempotencyRecords.id,
        operation: idempotencyRecords.operation,
        requestFingerprint: idempotencyRecords.requestFingerprint,
        status: idempotencyRecords.status,
        responseBody: idempotencyRecords.responseBody,
      })
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.organizationId, organizationId),
          eq(idempotencyRecords.key, command.idempotencyKey),
          inArray(idempotencyRecords.operation, [...ALLOWED_AMENDMENT_OPERATIONS]),
        ),
      );

    if (lateRecords.length > 1) {
      return { kind: 'INVALID_STATE' };
    }

    if (lateRecords.length === 1) {
      const replay = extractIdempotencyReplay(lateRecords[0]!, command);
      if (replay) return replay;
    }
    throw err;
  }

  if (preview.kind !== 'SUCCESS') {
    // Vérifier si une transaction concurrente a réussi
    const lateRecords = await db
      .select({
        id: idempotencyRecords.id,
        operation: idempotencyRecords.operation,
        requestFingerprint: idempotencyRecords.requestFingerprint,
        status: idempotencyRecords.status,
        responseBody: idempotencyRecords.responseBody,
      })
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.organizationId, organizationId),
          eq(idempotencyRecords.key, command.idempotencyKey),
          inArray(idempotencyRecords.operation, [...ALLOWED_AMENDMENT_OPERATIONS]),
        ),
      );

    if (lateRecords.length > 1) {
      return { kind: 'INVALID_STATE' };
    }

    if (lateRecords.length === 1) {
      const replay = extractIdempotencyReplay(lateRecords[0]!, command);
      if (replay) return replay;
    }

    if (preview.kind === 'FORBIDDEN') return { kind: 'FORBIDDEN' };
    if (preview.kind === 'NOT_FOUND') return { kind: 'NOT_FOUND' };
    if (preview.kind === 'BOOKING_NOT_CONFIRMED') return { kind: 'BOOKING_NOT_CONFIRMED' };
    if (preview.kind === 'ACTIVE_AMENDMENT_EXISTS') return { kind: 'ACTIVE_AMENDMENT_EXISTS' };
    if (preview.kind === 'STALE_EFFECTIVE_BOOKING') {
      return {
        kind: 'STALE_EFFECTIVE_BOOKING',
        expected: preview.expected,
        actual: preview.actual,
      };
    }
    if (preview.kind === 'AVAILABILITY_CONFLICT') {
      return { kind: 'AVAILABILITY_CONFLICT', message: preview.message };
    }
    if (preview.kind === 'INVALID_INPUT') {
      return { kind: 'INVALID_INPUT', message: preview.message };
    }
    return { kind: 'INVALID_INPUT', message: 'Impossible de calculer la prévisualisation.' };
  }

  // 5. Comparaison stricte avec les valeurs issues de la prévisualisation (PREVIEW_CHANGED)
  if (command.expectedClassification !== preview.classification) {
    return { kind: 'PREVIEW_CHANGED' };
  }

  if (command.expectedDeltaAmountMinor !== preview.deltaAmountMinor) {
    return { kind: 'PREVIEW_CHANGED' };
  }

  if (command.expectedNextTotalAmountMinor !== preview.nextContractualTotalAmountMinor) {
    return { kind: 'PREVIEW_CHANGED' };
  }

  // 6. Dispatch vers la mutation correspondante selon la classification recalculée
  const mutationCommand = {
    bookingId: command.bookingId,
    expectedLastAppliedAmendmentNumber: command.expectedLastAppliedAmendmentNumber,
    intent: command.intent,
    desiredLines: command.desiredLines,
    idempotencyKey: command.idempotencyKey,
  };

  switch (preview.classification) {
    case 'NEUTRAL': {
      const mutResult = await createNeutralBookingAmendment(
        db,
        authenticatedActor,
        organizationId,
        mutationCommand,
        options,
      );

      if (mutResult.kind === 'SUCCESS' || mutResult.kind === 'REPLAY') {
        return {
          kind: 'APPLIED_NEUTRAL',
          amendmentId: mutResult.amendmentId,
          amendmentNumber: mutResult.amendmentNumber,
          bookingId: command.bookingId,
          isReplay: mutResult.kind === 'REPLAY',
        };
      }

      if (mutResult.kind === 'FINANCIAL_ACTION_REQUIRED') {
        return { kind: 'PREVIEW_CHANGED' };
      }

      return mutResult;
    }

    case 'REFUND': {
      const mutResult = await createRefundBookingAmendment(
        db,
        authenticatedActor,
        organizationId,
        mutationCommand,
        options,
      );

      if (mutResult.kind === 'SUCCESS' || mutResult.kind === 'REPLAY') {
        return {
          kind: 'APPLIED_REFUND',
          amendmentId: mutResult.amendmentId,
          amendmentNumber: mutResult.amendmentNumber,
          bookingId: command.bookingId,
          refundAmountMinor: mutResult.refundAmountMinor,
          currency: 'EUR',
          isReplay: mutResult.kind === 'REPLAY',
        };
      }

      if (mutResult.kind === 'FINANCIAL_ACTION_REQUIRED') {
        return { kind: 'PREVIEW_CHANGED' };
      }

      return mutResult;
    }

    case 'SUPPLEMENT': {
      const mutResult = await createSupplementBookingAmendment(
        db,
        authenticatedActor,
        organizationId,
        mutationCommand,
        options,
      );

      if (mutResult.kind === 'SUCCESS' || mutResult.kind === 'REPLAY') {
        return {
          kind: 'PAYMENT_REQUIRED',
          amendmentId: mutResult.amendmentId,
          amendmentNumber: mutResult.amendmentNumber,
          bookingId: command.bookingId,
          supplementAmountMinor: mutResult.supplementAmountMinor,
          currency: 'EUR',
          holdDeadline: mutResult.holdDeadline,
          isReplay: mutResult.kind === 'REPLAY',
        };
      }

      if (mutResult.kind === 'FINANCIAL_ACTION_REQUIRED') {
        return { kind: 'PREVIEW_CHANGED' };
      }

      return mutResult;
    }
  }
}
