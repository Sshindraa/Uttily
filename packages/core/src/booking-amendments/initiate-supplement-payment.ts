import { and, asc, eq, isNull, lte, ne, or } from 'drizzle-orm';
import {
  amendmentPaymentAttempts,
  amendmentPayments,
  bookingAmendments,
  bookings,
  lockOrganization,
  type DatabaseTransaction,
} from '@uttily/database';
import type {
  CreatePaymentIntentParams,
  PaymentIntentResult,
  PaymentIntentStatus,
} from '../payments/types';
import {
  calculateSupplementCommission,
  SupplementCommissionCalculationError,
} from './supplement-commission';
import {
  parseMarketplaceFeeDeltaSnapshot,
  parseMarketplaceFeeSnapshot,
  MarketplaceFeeError,
} from '../marketplace-fees';
import type { MarketplaceFeeDeltaSnapshot } from '../marketplace-fees';
import type {
  InitiateSupplementPaymentDependencies,
  InitiateSupplementPaymentInput,
  InitiateSupplementPaymentOptions,
  InitiateSupplementPaymentResult,
  InitiateSupplementPaymentSuccess,
} from './initiate-supplement-payment-types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROCESSING_DEADLINE_MS = 30 * 60_000;

const NON_TERMINAL_ATTEMPT_STATUSES = [
  'PENDING_PROVIDER',
  'REQUIRES_PAYMENT_METHOD',
  'REQUIRES_ACTION',
  'PROCESSING',
] as const;

const TERMINAL_ATTEMPT_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;

type NonTerminalAttemptStatus = (typeof NON_TERMINAL_ATTEMPT_STATUSES)[number];

const AMENDMENT_PAYMENT_PROTOCOL_VERSION = 'booking-amendment-payment-v1' as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isTerminalStatus(value: string): boolean {
  return (TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(value);
}

function isNonTerminalStatus(value: string): value is NonTerminalAttemptStatus {
  return (NON_TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(value);
}

function validateInput(
  input: InitiateSupplementPaymentInput,
  options: InitiateSupplementPaymentOptions | undefined,
): Date | null {
  if (
    !isNonEmptyString(input.organizationId) ||
    !UUID_REGEX.test(input.organizationId) ||
    !isNonEmptyString(input.amendmentId) ||
    !UUID_REGEX.test(input.amendmentId) ||
    !isNonEmptyString(input.customerUserId) ||
    !UUID_REGEX.test(input.customerUserId) ||
    (input.environment !== 'TEST' && input.environment !== 'LIVE')
  ) {
    return null;
  }

  if (options?.now !== undefined && !isValidDate(options.now)) {
    return null;
  }
  if (
    options?.afterProviderNow !== undefined &&
    typeof options.afterProviderNow !== 'function' &&
    !isValidDate(options.afterProviderNow)
  ) {
    return null;
  }
  return options?.now === undefined ? new Date() : new Date(options.now.getTime());
}

function captureProjectionAt(options: InitiateSupplementPaymentOptions | undefined): Date | null {
  const override = options?.afterProviderNow ?? options?.now;
  try {
    const value =
      override === undefined ? new Date() : typeof override === 'function' ? override() : override;
    return isValidDate(value) ? new Date(value.getTime()) : null;
  } catch {
    return null;
  }
}

function processingDeadline(startedAt: Date, holdDeadline: Date): Date | null {
  const technicalTimestamp = startedAt.getTime() + PROCESSING_DEADLINE_MS;
  const timestamp = Math.min(technicalTimestamp, holdDeadline.getTime());
  if (!Number.isSafeInteger(timestamp)) return null;
  const deadline = new Date(timestamp);
  return isValidDate(deadline) ? deadline : null;
}

function providerStatusIsSupported(status: PaymentIntentStatus): boolean {
  return (
    status === 'requires_payment_method' ||
    status === 'requires_action' ||
    status === 'processing' ||
    status === 'succeeded' ||
    status === 'canceled'
  );
}

function expectedApplicationFee(commissionAmountMinor: number): number | null {
  return commissionAmountMinor === 0 ? null : commissionAmountMinor;
}

function providerFeeMatches(actual: number | null, expectedCommissionMinor: number): boolean {
  const expected = expectedApplicationFee(expectedCommissionMinor);
  return actual === expected || (expected === null && actual === 0);
}

interface LocalTakeover {
  readonly kind: 'TAKEOVER';
  readonly startedAt: Date;
  readonly organizationId: string;
  readonly amendmentId: string;
  readonly bookingId: string;
  readonly amendmentPaymentId: string;
  readonly amendmentPaymentAttemptId: string;
  readonly providerPaymentIntentId: string | null;
  readonly providerIdempotencyKey: string;
  readonly amountMinor: number;
  readonly totalOriginalMinor: number;
  readonly commissionOriginalMinor: number;
  readonly marketplaceFeeDeltaSnapshot: MarketplaceFeeDeltaSnapshot | null;
  readonly platformApplicationFeeDeltaAmountMinor: number;
  readonly connectedAccountId: string;
  readonly onBehalfOfAccountId: string | null;
  readonly environment: 'TEST' | 'LIVE';
  readonly processingDeadlineAt: Date;
}

type TransactionAResult =
  LocalTakeover | { readonly kind: 'IN_PROGRESS' } | InitiateSupplementPaymentResult;

/**
 * Résout le booking avant de l'acquérir en FOR UPDATE. Cette lecture ne prend
 * aucun verrou : elle permet de respecter l'ordre global org → booking →
 * amendment avec une entrée qui ne contient que l'amendmentId.
 */
async function resolveBookingId(
  tx: DatabaseTransaction,
  amendmentId: string,
  organizationId: string,
): Promise<string | null> {
  const rows = await tx
    .select({
      bookingId: bookingAmendments.bookingId,
      organizationId: bookingAmendments.organizationId,
    })
    .from(bookingAmendments)
    .where(eq(bookingAmendments.id, amendmentId))
    .limit(1);
  if (rows.length === 0 || rows[0]!.organizationId !== organizationId) return null;
  return rows[0]!.bookingId;
}

async function lockCommonRows(
  tx: DatabaseTransaction,
  input: InitiateSupplementPaymentInput,
  bookingId: string,
  amendmentPaymentAttemptId?: string,
): Promise<
  | {
      readonly booking: NonNullable<Awaited<ReturnType<typeof loadBooking>>>;
      readonly amendment: NonNullable<Awaited<ReturnType<typeof loadAmendment>>>;
      readonly payment: NonNullable<Awaited<ReturnType<typeof loadPayment>>>;
      readonly attempt: NonNullable<Awaited<ReturnType<typeof loadAttempt>>>;
    }
  | InitiateSupplementPaymentResult
> {
  const booking = await loadBooking(tx, bookingId);
  if (booking === null) return { kind: 'NOT_FOUND' };

  const amendment = await loadAmendment(tx, input.amendmentId);
  if (amendment === null) return { kind: 'NOT_FOUND' };

  const payment = await loadPayment(tx, amendment.id);
  if (payment === null) return { kind: 'INVALID_STATE' };

  const attempt = await loadAttempt(tx, payment.id, amendmentPaymentAttemptId);
  if (attempt === null) return { kind: 'INVALID_STATE' };

  if (
    booking.organizationId !== input.organizationId ||
    amendment.organizationId !== input.organizationId ||
    amendment.bookingId !== booking.id ||
    payment.organizationId !== input.organizationId ||
    payment.bookingId !== booking.id ||
    payment.amendmentId !== amendment.id ||
    attempt.organizationId !== input.organizationId ||
    attempt.amendmentPaymentId !== payment.id
  ) {
    return { kind: 'INVALID_STATE' };
  }

  return { booking, amendment, payment, attempt };
}

async function loadBooking(tx: DatabaseTransaction, bookingId: string) {
  const rows = await tx
    .select()
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .for('update')
    .limit(1);
  return rows[0] ?? null;
}

async function loadAmendment(tx: DatabaseTransaction, amendmentId: string) {
  const rows = await tx
    .select()
    .from(bookingAmendments)
    .where(eq(bookingAmendments.id, amendmentId))
    .for('update')
    .limit(1);
  return rows[0] ?? null;
}

async function loadPayment(tx: DatabaseTransaction, amendmentId: string) {
  const rows = await tx
    .select()
    .from(amendmentPayments)
    .where(eq(amendmentPayments.amendmentId, amendmentId))
    .for('update')
    .limit(1);
  return rows[0] ?? null;
}

async function loadAttempt(
  tx: DatabaseTransaction,
  amendmentPaymentId: string,
  attemptId?: string,
) {
  const rows = await tx
    .select()
    .from(amendmentPaymentAttempts)
    .where(
      attemptId
        ? and(
            eq(amendmentPaymentAttempts.id, attemptId),
            eq(amendmentPaymentAttempts.amendmentPaymentId, amendmentPaymentId),
          )
        : eq(amendmentPaymentAttempts.amendmentPaymentId, amendmentPaymentId),
    )
    .orderBy(asc(amendmentPaymentAttempts.attemptNumber))
    .for('update');

  if (attemptId !== undefined) return rows[0] ?? null;
  const active = rows.filter((row) => isNonTerminalStatus(row.status));
  return active.length === 1 ? active[0]! : null;
}

function validatePersistedPaymentShape(
  booking: Awaited<ReturnType<typeof loadBooking>>,
  amendment: Awaited<ReturnType<typeof loadAmendment>>,
  payment: Awaited<ReturnType<typeof loadPayment>>,
  attempt: Awaited<ReturnType<typeof loadAttempt>>,
  allowTerminal = false,
): boolean {
  if (!booking || !amendment || !payment || !attempt) return false;
  if (
    booking.currency !== 'EUR' ||
    payment.currency !== 'EUR' ||
    !Number.isSafeInteger(payment.amountMinor) ||
    payment.amountMinor <= 0 ||
    !Number.isSafeInteger(booking.totalAmountMinor) ||
    booking.totalAmountMinor < 0 ||
    !Number.isSafeInteger(booking.commissionAmountMinor) ||
    booking.commissionAmountMinor < 0 ||
    booking.commissionAmountMinor > booking.totalAmountMinor ||
    !isNonEmptyString(payment.connectedAccountId) ||
    (payment.onBehalfOfAccountId !== null && !isNonEmptyString(payment.onBehalfOfAccountId)) ||
    !isNonEmptyString(attempt.providerIdempotencyKey)
  ) {
    return false;
  }
  if (
    attempt.providerPaymentIntentId !== null &&
    !isNonEmptyString(attempt.providerPaymentIntentId)
  ) {
    return false;
  }
  if (attempt.providerPaymentIntentId === null && attempt.providerStatus !== null) return false;
  if (
    (payment.processingStartedAt === null) !== (payment.processingDeadlineAt === null) ||
    (payment.processingStartedAt !== null &&
      payment.processingDeadlineAt !== null &&
      (payment.processingDeadlineAt.getTime() <= payment.processingStartedAt.getTime() ||
        amendment.holdDeadline === null ||
        payment.processingDeadlineAt.getTime() > amendment.holdDeadline.getTime()))
  ) {
    return false;
  }
  if (allowTerminal && isTerminalStatus(payment.status) && isTerminalStatus(attempt.status)) {
    return payment.status === attempt.status;
  }
  return (
    isNonTerminalStatus(payment.status) &&
    isNonTerminalStatus(attempt.status) &&
    payment.status === attempt.status
  );
}

async function executeTransactionA(
  tx: DatabaseTransaction,
  input: InitiateSupplementPaymentInput,
  now: Date,
): Promise<TransactionAResult> {
  await lockOrganization(tx, input.organizationId);

  const bookingId = await resolveBookingId(tx, input.amendmentId, input.organizationId);
  if (bookingId === null) return { kind: 'NOT_FOUND' };

  const locked = await lockCommonRows(tx, input, bookingId);
  if ('kind' in locked) return locked;
  const { booking, amendment, payment, attempt } = locked;

  if (booking.customerUserId !== input.customerUserId) return { kind: 'FORBIDDEN' };
  if (amendment.type !== 'SUPPLEMENT' || amendment.status !== 'HOLD_PENDING') {
    return { kind: 'INVALID_STATE' };
  }
  if (amendment.holdDeadline === null || !isValidDate(amendment.holdDeadline)) {
    return { kind: 'INVALID_STATE' };
  }
  if (now.getTime() >= amendment.holdDeadline.getTime()) return { kind: 'HOLD_EXPIRED' };
  if (payment.environment !== input.environment) return { kind: 'ENVIRONMENT_MISMATCH' };
  if (!validatePersistedPaymentShape(booking, amendment, payment, attempt)) {
    return { kind: 'INVALID_STATE' };
  }

  try {
    if (booking.marketplaceFeeSnapshot !== null) {
      const bookingSnapshot = parseMarketplaceFeeSnapshot(booking.marketplaceFeeSnapshot);
      const deltaSnapshot = parseMarketplaceFeeDeltaSnapshot(payment.marketplaceFeeDeltaSnapshot);
      if (
        deltaSnapshot.old.ruleVersion !== bookingSnapshot.ruleVersion ||
        deltaSnapshot.old.customerTotalAmountMinor !== bookingSnapshot.customerTotalAmountMinor ||
        deltaSnapshot.next.customerTotalAmountMinor - deltaSnapshot.old.customerTotalAmountMinor !==
          payment.amountMinor
      ) {
        return { kind: 'INVALID_STATE' };
      }
    } else {
      calculateSupplementCommission(
        payment.amountMinor,
        booking.totalAmountMinor,
        booking.commissionAmountMinor,
      );
    }
  } catch (error) {
    if (
      error instanceof SupplementCommissionCalculationError ||
      error instanceof MarketplaceFeeError
    ) {
      return { kind: 'INVALID_STATE' };
    }
    throw error;
  }

  const providerPaymentIntentId = attempt.providerPaymentIntentId;
  const deadline = processingDeadline(now, amendment.holdDeadline);
  if (deadline === null) return { kind: 'INVALID_STATE' };
  if (deadline.getTime() <= now.getTime()) return { kind: 'HOLD_EXPIRED' };

  const processingActive =
    payment.status === 'PROCESSING' &&
    providerPaymentIntentId === null &&
    payment.processingDeadlineAt !== null &&
    payment.processingDeadlineAt.getTime() > now.getTime();
  if (processingActive) return { kind: 'IN_PROGRESS' };

  const needsTakeover =
    providerPaymentIntentId === null ||
    payment.status !== 'PROCESSING' ||
    payment.processingStartedAt === null ||
    payment.processingDeadlineAt === null ||
    payment.processingDeadlineAt.getTime() <= now.getTime();

  if (needsTakeover) {
    const claimedPayment = await tx
      .update(amendmentPayments)
      .set({
        status: 'PROCESSING',
        processingStartedAt: now,
        processingDeadlineAt: deadline,
        updatedAt: now,
      })
      .where(
        and(
          eq(amendmentPayments.id, payment.id),
          or(
            ne(amendmentPayments.status, 'PROCESSING'),
            isNull(amendmentPayments.processingDeadlineAt),
            lte(amendmentPayments.processingDeadlineAt, now),
          ),
        ),
      )
      .returning({ id: amendmentPayments.id });
    if (claimedPayment.length === 0) return { kind: 'IN_PROGRESS' };

    await tx
      .update(amendmentPaymentAttempts)
      .set({ status: 'PROCESSING', reconcileAfter: now, updatedAt: now })
      .where(eq(amendmentPaymentAttempts.id, attempt.id));
  }

  return {
    kind: 'TAKEOVER',
    startedAt: now,
    organizationId: input.organizationId,
    amendmentId: amendment.id,
    bookingId: booking.id,
    amendmentPaymentId: payment.id,
    amendmentPaymentAttemptId: attempt.id,
    providerPaymentIntentId,
    providerIdempotencyKey: attempt.providerIdempotencyKey,
    amountMinor: payment.amountMinor,
    totalOriginalMinor: booking.totalAmountMinor,
    commissionOriginalMinor: booking.commissionAmountMinor,
    marketplaceFeeDeltaSnapshot:
      booking.marketplaceFeeSnapshot === null
        ? null
        : parseMarketplaceFeeDeltaSnapshot(payment.marketplaceFeeDeltaSnapshot),
    platformApplicationFeeDeltaAmountMinor:
      booking.marketplaceFeeSnapshot === null
        ? calculateSupplementCommission(
            payment.amountMinor,
            booking.totalAmountMinor,
            booking.commissionAmountMinor,
          )
        : parseMarketplaceFeeDeltaSnapshot(payment.marketplaceFeeDeltaSnapshot)
            .platformApplicationFeeDeltaAmountMinor,
    connectedAccountId: payment.connectedAccountId,
    onBehalfOfAccountId: payment.onBehalfOfAccountId,
    environment: payment.environment,
    processingDeadlineAt: needsTakeover ? deadline : payment.processingDeadlineAt!,
  };
}

function buildCreateParams(txResult: LocalTakeover): CreatePaymentIntentParams {
  return {
    amountMinor: txResult.amountMinor,
    currency: 'EUR',
    connectedAccountId: txResult.connectedAccountId,
    onBehalfOfAccountId: txResult.onBehalfOfAccountId,
    applicationFeeAmountMinor: expectedApplicationFee(
      txResult.platformApplicationFeeDeltaAmountMinor,
    ),
    idempotencyKey: txResult.providerIdempotencyKey,
    metadata: {
      payment_type: 'AMENDMENT',
      amendment_payment_attempt_id: txResult.amendmentPaymentAttemptId,
      amendment_id: txResult.amendmentId,
      organization_id: txResult.organizationId,
      environment: txResult.environment,
      protocol_version: AMENDMENT_PAYMENT_PROTOCOL_VERSION,
    },
  };
}

/**
 * Vérifie et projette la réponse provider. La fonction est appelée dans une
 * transaction neuve, après que l'appel externe est terminé.
 */
async function executeTransactionB(
  tx: DatabaseTransaction,
  input: InitiateSupplementPaymentInput,
  txResult: LocalTakeover,
  providerResult: PaymentIntentResult,
  projectionAt: Date,
): Promise<InitiateSupplementPaymentResult> {
  await lockOrganization(tx, input.organizationId);

  const locked = await lockCommonRows(
    tx,
    input,
    txResult.bookingId,
    txResult.amendmentPaymentAttemptId,
  );
  if ('kind' in locked) return locked;
  const { booking, amendment, payment, attempt } = locked;

  if (booking.customerUserId !== input.customerUserId) return { kind: 'FORBIDDEN' };
  if (amendment.type !== 'SUPPLEMENT' || amendment.status !== 'HOLD_PENDING') {
    return { kind: 'INVALID_STATE' };
  }
  if (amendment.holdDeadline === null || !isValidDate(amendment.holdDeadline)) {
    return { kind: 'INVALID_STATE' };
  }
  if (projectionAt.getTime() >= amendment.holdDeadline.getTime()) {
    return { kind: 'HOLD_EXPIRED' };
  }
  if (payment.environment !== input.environment || payment.environment !== txResult.environment) {
    return { kind: 'ENVIRONMENT_MISMATCH' };
  }
  if (
    payment.id !== txResult.amendmentPaymentId ||
    payment.bookingId !== txResult.bookingId ||
    payment.amountMinor !== txResult.amountMinor ||
    payment.currency !== 'EUR' ||
    payment.connectedAccountId !== txResult.connectedAccountId ||
    payment.onBehalfOfAccountId !== txResult.onBehalfOfAccountId ||
    !validatePersistedPaymentShape(booking, amendment, payment, attempt, true) ||
    (txResult.marketplaceFeeDeltaSnapshot !== null &&
      JSON.stringify(payment.marketplaceFeeDeltaSnapshot) !==
        JSON.stringify(txResult.marketplaceFeeDeltaSnapshot))
  ) {
    return { kind: 'PROVIDER_STATE_INCONSISTENT' };
  }
  if (!providerStatusIsSupported(providerResult.status) || !isNonEmptyString(providerResult.id)) {
    return { kind: 'PROVIDER_STATE_INCONSISTENT' };
  }
  if (
    !Number.isSafeInteger(providerResult.amountMinor) ||
    providerResult.amountMinor !== payment.amountMinor ||
    providerResult.currency !== 'EUR' ||
    providerResult.environment !== input.environment ||
    providerResult.connectedAccountId !== payment.connectedAccountId ||
    !providerFeeMatches(
      providerResult.applicationFeeAmountMinor,
      txResult.platformApplicationFeeDeltaAmountMinor,
    ) ||
    providerResult.onBehalfOfAccountId !== payment.onBehalfOfAccountId ||
    !isNonEmptyString(providerResult.clientSecret)
  ) {
    return { kind: 'PROVIDER_STATE_INCONSISTENT' };
  }
  if (
    attempt.providerPaymentIntentId !== null &&
    attempt.providerPaymentIntentId !== providerResult.id
  ) {
    return { kind: 'PROVIDER_STATE_INCONSISTENT' };
  }

  const paymentTerminal = isTerminalStatus(payment.status);
  const attemptTerminal = isTerminalStatus(attempt.status);
  if (paymentTerminal !== attemptTerminal) return { kind: 'PROVIDER_STATE_INCONSISTENT' };

  if (paymentTerminal && attemptTerminal) {
    if (attempt.providerPaymentIntentId !== providerResult.id) {
      return { kind: 'PROVIDER_STATE_INCONSISTENT' };
    }
  } else {
    // C2 ne projette jamais SUCCEEDED/CANCELLED localement. Le webhook C3
    // reste l'autorité des états terminaux ; providerStatus est le snapshot
    // de la réponse synchrone, même lorsqu'elle est non terminale.
    await tx
      .update(amendmentPaymentAttempts)
      .set({
        providerPaymentIntentId: providerResult.id,
        providerStatus: providerResult.status,
        reconcileAfter:
          providerResult.status === 'processing'
            ? (payment.processingDeadlineAt ?? amendment.holdDeadline)
            : null,
        updatedAt: projectionAt,
      })
      .where(eq(amendmentPaymentAttempts.id, attempt.id));
  }

  const clientSecret = providerResult.clientSecret;
  if (!isNonEmptyString(clientSecret)) return { kind: 'PROVIDER_STATE_INCONSISTENT' };

  const success: InitiateSupplementPaymentSuccess = {
    kind: 'SUCCESS',
    amendmentId: amendment.id,
    amendmentPaymentId: payment.id,
    amendmentPaymentAttemptId: attempt.id,
    providerPaymentIntentId: providerResult.id,
    providerStatus: providerResult.status,
    clientSecret,
  };
  return success;
}

/**
 * Initie le PaymentIntent d'un supplément C2.
 *
 * Transaction A et Transaction B sont toujours séparées de l'appel provider.
 * Les seules données envoyées à Stripe proviennent des snapshots persistants
 * de l'amendement, du paiement et de la réservation.
 */
export async function initiateSupplementPayment(
  db: InitiateSupplementPaymentDependencies['db'],
  provider: InitiateSupplementPaymentDependencies['provider'],
  input: InitiateSupplementPaymentInput,
  options?: InitiateSupplementPaymentOptions,
): Promise<InitiateSupplementPaymentResult> {
  const startedAt = validateInput(input, options);
  if (startedAt === null) return { kind: 'INVALID_INPUT' };
  if (provider.environment !== input.environment) return { kind: 'ENVIRONMENT_MISMATCH' };

  const transactionA = await db.transaction(async (tx) =>
    executeTransactionA(tx, input, startedAt),
  );
  if (transactionA.kind !== 'TAKEOVER') return transactionA;

  let providerResult: PaymentIntentResult;
  try {
    if (transactionA.providerPaymentIntentId !== null) {
      providerResult = await provider.retrievePaymentIntent(transactionA.providerPaymentIntentId);
    } else {
      providerResult = await provider.createPaymentIntent(buildCreateParams(transactionA));
    }
  } catch {
    // Les erreurs provider sont volontairement fermées. La prise de contrôle
    // locale PROCESSING reste durable et récupérable avec la même clé.
    return { kind: 'PROVIDER_ERROR' };
  }

  const projectionAt = captureProjectionAt(options);
  if (projectionAt === null || projectionAt.getTime() < transactionA.startedAt.getTime()) {
    return { kind: 'INVALID_INPUT' };
  }

  return db.transaction(async (tx) =>
    executeTransactionB(tx, input, transactionA, providerResult, projectionAt),
  );
}
