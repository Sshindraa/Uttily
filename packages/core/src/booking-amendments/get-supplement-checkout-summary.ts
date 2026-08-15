import { and, eq } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  bookingAmendments,
  bookings,
  locations,
  amendmentPayments,
  amendmentPaymentAttempts,
} from '@uttily/database';
import type {
  GetSupplementCheckoutInput,
  GetSupplementCheckoutOptions,
  GetSupplementCheckoutResult,
} from './types-amendment';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NON_TERMINAL_ATTEMPT_STATUSES = [
  'PENDING_PROVIDER',
  'REQUIRES_PAYMENT_METHOD',
  'REQUIRES_ACTION',
  'PROCESSING',
] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isValidIanaTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.trim().length === 0) {
    return false;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read model fermé et tenant-safe pour le checkout de supplément client (G7M-C5-C).
 *
 * Strictement en lecture seule : zéro écriture en base de données.
 * Résout le tuple amendment → booking → location → payment → attempts sous
 * l'autorité du customer authentifié.
 */
export async function getSupplementCheckoutSummary(
  db: DatabaseClient,
  input: GetSupplementCheckoutInput,
  options?: GetSupplementCheckoutOptions,
): Promise<GetSupplementCheckoutResult> {
  if (
    !isNonEmptyString(input.amendmentId) ||
    !UUID_REGEX.test(input.amendmentId) ||
    !isNonEmptyString(input.customerUserId) ||
    !UUID_REGEX.test(input.customerUserId)
  ) {
    return { kind: 'NOT_FOUND' };
  }

  let asOf: Date;
  if (options?.asOf !== undefined) {
    if (!isValidDate(options.asOf)) {
      return { kind: 'INVALID_STATE' };
    }
    asOf = options.asOf;
  } else {
    asOf = new Date();
  }

  const rows = await db
    .select({
      amendmentId: bookingAmendments.id,
      organizationId: bookingAmendments.organizationId,
      bookingId: bookingAmendments.bookingId,
      amendmentType: bookingAmendments.type,
      amendmentStatus: bookingAmendments.status,
      holdDeadline: bookingAmendments.holdDeadline,
      customerUserId: bookings.customerUserId,
      locationTimeZone: locations.timeZone,
    })
    .from(bookingAmendments)
    .innerJoin(
      bookings,
      and(
        eq(bookings.id, bookingAmendments.bookingId),
        eq(bookings.organizationId, bookingAmendments.organizationId),
      ),
    )
    .innerJoin(
      locations,
      and(
        eq(locations.id, bookings.locationId),
        eq(locations.organizationId, bookings.organizationId),
      ),
    )
    .where(
      and(
        eq(bookingAmendments.id, input.amendmentId),
        eq(bookings.customerUserId, input.customerUserId),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    return { kind: 'NOT_FOUND' };
  }

  const row = rows[0]!;

  if (row.amendmentType !== 'SUPPLEMENT') {
    return { kind: 'NOT_FOUND' };
  }

  if (!isValidIanaTimeZone(row.locationTimeZone)) {
    return { kind: 'INVALID_STATE' };
  }

  const paymentRows = await db
    .select({
      id: amendmentPayments.id,
      organizationId: amendmentPayments.organizationId,
      bookingId: amendmentPayments.bookingId,
      amendmentId: amendmentPayments.amendmentId,
      customerUserId: amendmentPayments.customerUserId,
      amountMinor: amendmentPayments.amountMinor,
      currency: amendmentPayments.currency,
      status: amendmentPayments.status,
    })
    .from(amendmentPayments)
    .where(
      and(
        eq(amendmentPayments.amendmentId, row.amendmentId),
        eq(amendmentPayments.organizationId, row.organizationId),
      ),
    )
    .limit(1);

  if (paymentRows.length === 0) {
    return { kind: 'INVALID_STATE' };
  }

  const payment = paymentRows[0]!;

  if (
    payment.organizationId !== row.organizationId ||
    payment.bookingId !== row.bookingId ||
    payment.amendmentId !== row.amendmentId ||
    payment.customerUserId !== input.customerUserId ||
    payment.currency !== 'EUR' ||
    !Number.isSafeInteger(payment.amountMinor) ||
    payment.amountMinor <= 0
  ) {
    return { kind: 'INVALID_STATE' };
  }

  // Traiter l'expiration avant tout état payé : un amendement EXPIRED reste EXPIRED même avec paiement SUCCEEDED
  if (row.amendmentStatus === 'EXPIRED') {
    return { kind: 'EXPIRED' };
  }

  if (row.amendmentStatus === 'READY_TO_APPLY' || row.amendmentStatus === 'APPLIED') {
    if (payment.status !== 'SUCCEEDED') {
      return { kind: 'INVALID_STATE' };
    }

    const attempts = await db
      .select({
        id: amendmentPaymentAttempts.id,
        organizationId: amendmentPaymentAttempts.organizationId,
        amendmentPaymentId: amendmentPaymentAttempts.amendmentPaymentId,
        status: amendmentPaymentAttempts.status,
        providerPaymentIntentId: amendmentPaymentAttempts.providerPaymentIntentId,
        providerStatus: amendmentPaymentAttempts.providerStatus,
      })
      .from(amendmentPaymentAttempts)
      .where(
        and(
          eq(amendmentPaymentAttempts.amendmentPaymentId, payment.id),
          eq(amendmentPaymentAttempts.organizationId, row.organizationId),
        ),
      );

    const hasActiveAttempt = attempts.some((a) =>
      (NON_TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(a.status),
    );
    if (hasActiveAttempt) {
      return { kind: 'INVALID_STATE' };
    }

    const hasCoherentSucceededAttempt = attempts.some(
      (a) =>
        a.status === 'SUCCEEDED' &&
        isNonEmptyString(a.providerPaymentIntentId) &&
        a.providerStatus === 'succeeded',
    );

    if (!hasCoherentSucceededAttempt) {
      return { kind: 'INVALID_STATE' };
    }

    return { kind: 'PAID' };
  }

  if (row.amendmentStatus === 'CANCELLED' || row.amendmentStatus === 'FAILED') {
    return { kind: 'INVALID_STATE' };
  }

  if (row.amendmentStatus === 'HOLD_PENDING') {
    if (!row.holdDeadline || !isValidDate(row.holdDeadline)) {
      return { kind: 'INVALID_STATE' };
    }

    if (asOf.getTime() >= row.holdDeadline.getTime()) {
      return { kind: 'EXPIRED' };
    }

    // Un paiement SUCCEEDED sur un amendement encore HOLD_PENDING est incohérent
    if (
      payment.status === 'SUCCEEDED' ||
      payment.status === 'FAILED' ||
      payment.status === 'CANCELLED'
    ) {
      return { kind: 'INVALID_STATE' };
    }

    const attempts = await db
      .select({
        id: amendmentPaymentAttempts.id,
        organizationId: amendmentPaymentAttempts.organizationId,
        amendmentPaymentId: amendmentPaymentAttempts.amendmentPaymentId,
        status: amendmentPaymentAttempts.status,
        providerPaymentIntentId: amendmentPaymentAttempts.providerPaymentIntentId,
        providerStatus: amendmentPaymentAttempts.providerStatus,
      })
      .from(amendmentPaymentAttempts)
      .where(
        and(
          eq(amendmentPaymentAttempts.amendmentPaymentId, payment.id),
          eq(amendmentPaymentAttempts.organizationId, row.organizationId),
        ),
      );

    const activeAttempts = attempts.filter((a) =>
      (NON_TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(a.status),
    );

    if (activeAttempts.length !== 1) {
      return { kind: 'INVALID_STATE' };
    }

    const attempt = activeAttempts[0]!;
    if (
      attempt.organizationId !== row.organizationId ||
      attempt.amendmentPaymentId !== payment.id
    ) {
      return { kind: 'INVALID_STATE' };
    }

    if (payment.status === 'PENDING_PROVIDER') {
      if (
        attempt.status !== 'PENDING_PROVIDER' ||
        isNonEmptyString(attempt.providerPaymentIntentId) ||
        isNonEmptyString(attempt.providerStatus)
      ) {
        return { kind: 'INVALID_STATE' };
      }
      return {
        kind: 'PAYABLE',
        amountMinor: payment.amountMinor,
        currency: 'EUR',
        holdDeadline: row.holdDeadline.toISOString(),
        timeZone: row.locationTimeZone,
      };
    }

    if (payment.status === 'REQUIRES_PAYMENT_METHOD') {
      if (
        attempt.status !== 'REQUIRES_PAYMENT_METHOD' ||
        !isNonEmptyString(attempt.providerPaymentIntentId) ||
        attempt.providerStatus !== 'requires_payment_method'
      ) {
        return { kind: 'INVALID_STATE' };
      }
      return {
        kind: 'PAYABLE',
        amountMinor: payment.amountMinor,
        currency: 'EUR',
        holdDeadline: row.holdDeadline.toISOString(),
        timeZone: row.locationTimeZone,
      };
    }

    if (payment.status === 'REQUIRES_ACTION') {
      if (
        attempt.status !== 'REQUIRES_ACTION' ||
        !isNonEmptyString(attempt.providerPaymentIntentId) ||
        attempt.providerStatus !== 'requires_action'
      ) {
        return { kind: 'INVALID_STATE' };
      }
      return {
        kind: 'PAYABLE',
        amountMinor: payment.amountMinor,
        currency: 'EUR',
        holdDeadline: row.holdDeadline.toISOString(),
        timeZone: row.locationTimeZone,
      };
    }

    if (payment.status === 'PROCESSING') {
      if (attempt.status !== 'PROCESSING') {
        return { kind: 'INVALID_STATE' };
      }
      const hasPi = isNonEmptyString(attempt.providerPaymentIntentId);
      const provStatus = attempt.providerStatus;

      if (!hasPi && !provStatus) {
        return { kind: 'PROCESSING' };
      }

      if (hasPi && (provStatus === 'requires_payment_method' || provStatus === 'requires_action')) {
        return {
          kind: 'PAYABLE',
          amountMinor: payment.amountMinor,
          currency: 'EUR',
          holdDeadline: row.holdDeadline.toISOString(),
          timeZone: row.locationTimeZone,
        };
      }

      if (hasPi && (provStatus === 'processing' || provStatus === 'succeeded')) {
        return { kind: 'PROCESSING' };
      }

      return { kind: 'INVALID_STATE' };
    }

    return { kind: 'INVALID_STATE' };
  }

  return { kind: 'INVALID_STATE' };
}
