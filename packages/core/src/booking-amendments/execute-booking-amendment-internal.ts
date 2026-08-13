/**
 * @uttily/core — Moteur transactionnel partagé pour amendements de réservation (G7M-B2-A, G7M-B2-B1).
 *
 * Exécute de manière atomique, tenant-safe et idempotente les mutations d'amendement
 * (NEUTRAL ou REFUND) sur une réservation CONFIRMED.
 *
 * Verrous ADR-023 :
 * lockOrganization → lockKey → bookings FOR UPDATE → booking_amendments FOR UPDATE →
 * inventory_blocks FOR UPDATE (ORDER BY id) → payments FOR UPDATE (si REFUND).
 */

import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, not, sql, exists, sum } from 'drizzle-orm';
import type { DatabaseClient, DatabaseTransaction } from '@uttily/database';
import { lockOrganization } from '@uttily/database';
import {
  bookings,
  bookingAmendments,
  bookingAmendmentLines,
  bookingAmendmentAllocations,
  inventoryBlocks,
  inventoryItems,
  locations,
  organizationMemberships,
  outboxEvents,
  payments,
  productVariants,
  products,
  refunds,
} from '@uttily/database';
import {
  BOOKING_AMENDED_AGGREGATE_TYPE,
  BOOKING_AMENDED_EVENT_TYPE,
  BOOKING_AMENDED_EVENT_VERSION,
  REFUND_REQUESTED_AGGREGATE_TYPE,
  REFUND_REQUESTED_EVENT_TYPE,
  REFUND_REQUESTED_EVENT_VERSION,
} from '@uttily/contracts';
import { reserveKey, lockKey, completeKey, failKey } from '../idempotency/idempotency';
import { requireMembership, AuthorizationError, LOCATION_MANAGERS } from '../identity/permissions';
import { getMembership } from '../identity/memberships';
import type { AuthenticatedUser } from '../identity/types';
import { quoteFlexiblePricing } from '../pricing-plans/quote-flexible-pricing';
import { FlexiblePricingError } from '../pricing-plans/errors';
import {
  localDateTimeStringToUtc,
  localDateTimeToUtc,
  parseLocalDateTimeString,
  type LocalDateTime,
} from '../pricing-plans/local-to-utc';
import { getEffectiveBooking } from './get-effective-booking';
import type { EffectiveLine, EffectiveAllocation } from './types';
import type {
  NeutralAmendmentCommand,
  NeutralAmendmentDesiredLine,
  NeutralAmendmentIntent,
  NeutralAmendmentResult,
  RefundAmendmentResult,
} from './types-amendment';
import { NeutralAmendmentError, RefundAmendmentError } from './types-amendment';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AmendmentClassification = 'NEUTRAL' | 'REFUND';

/**
 * Erreur interne typée pour casser un savepoint et propager un résultat métier.
 */
export class BusinessSignal<T = NeutralAmendmentResult | RefundAmendmentResult> {
  readonly result: T;
  constructor(result: T) {
    this.result = result;
  }
}

function parseLocalDateTime(localDateStr: string, timeStr: string): LocalDateTime {
  const [year, month, day] = localDateStr.split('-').map(Number);
  const [hour, minute, second] = timeStr.split(':').map(Number);
  return {
    year: year!,
    month: month!,
    day: day!,
    hour: hour!,
    minute: minute!,
    second: second ?? 0,
  };
}

export function isExclusionViolation(err: unknown, constraintName: string): boolean {
  let current: unknown = err;
  while (typeof current === 'object' && current !== null) {
    const pgErr = current as {
      code?: string;
      constraint_name?: string;
      constraint?: string;
      cause?: unknown;
    };
    if (pgErr.code === '23P01') {
      const name = pgErr.constraint_name ?? pgErr.constraint;
      if (name === constraintName) return true;
    }
    if (pgErr.cause === current) break;
    current = pgErr.cause;
  }
  return false;
}

export function validateCommand(command: NeutralAmendmentCommand): string | null {
  if (typeof command !== 'object' || command === null) {
    return 'command doit être un objet.';
  }
  if (!UUID_REGEX.test(command.bookingId)) {
    return 'bookingId invalide (UUID attendu).';
  }
  if (
    !Number.isSafeInteger(command.expectedLastAppliedAmendmentNumber) ||
    command.expectedLastAppliedAmendmentNumber < 0
  ) {
    return 'expectedLastAppliedAmendmentNumber doit être un entier sûr >= 0.';
  }
  if (typeof command.idempotencyKey !== 'string' || command.idempotencyKey.trim().length === 0) {
    return 'idempotencyKey requis (string non vide).';
  }
  if (!command.intent || typeof command.intent !== 'object') {
    return 'intent est requis.';
  }

  if (command.intent.kind === 'TIME_RANGE') {
    if (typeof command.intent.startAt !== 'string' || typeof command.intent.endAt !== 'string') {
      return 'intent.startAt et intent.endAt doivent être des chaînes ISO locales.';
    }
    try {
      parseLocalDateTimeString(command.intent.startAt);
      parseLocalDateTimeString(command.intent.endAt);
    } catch (err) {
      return err instanceof Error ? err.message : 'intent TIME_RANGE invalide.';
    }
    if (!(command.intent.endAt > command.intent.startAt)) {
      return 'newCustomerEndAt doit être strictement après newCustomerStartAt.';
    }
  } else if (command.intent.kind === 'DAY_RANGE') {
    if (
      !command.intent.startDate ||
      !/^\d{4}-\d{2}-\d{2}$/.test(command.intent.startDate) ||
      !command.intent.endDateExclusive ||
      !/^\d{4}-\d{2}-\d{2}$/.test(command.intent.endDateExclusive)
    ) {
      return 'intent.startDate et intent.endDateExclusive doivent être au format YYYY-MM-DD.';
    }
    if (!(command.intent.endDateExclusive > command.intent.startDate)) {
      return 'newCustomerEndAt doit être strictement après newCustomerStartAt.';
    }
  } else {
    return 'intent.kind invalide.';
  }

  if (!Array.isArray(command.desiredLines) || command.desiredLines.length === 0) {
    return 'desiredLines doit être un tableau non vide.';
  }

  const seenLogicalLineIds = new Set<string>();
  const seenVariantIds = new Set<string>();

  for (let i = 0; i < command.desiredLines.length; i++) {
    const line = command.desiredLines[i]!;
    if (!UUID_REGEX.test(line.variantId)) {
      return `desiredLines[${i}].variantId invalide (UUID attendu).`;
    }

    if (line.logicalLineId !== undefined) {
      if (!UUID_REGEX.test(line.logicalLineId)) {
        return `desiredLines[${i}].logicalLineId invalide (UUID attendu).`;
      }
      if (seenLogicalLineIds.has(line.logicalLineId)) {
        return `desiredLines[${i}].logicalLineId en double: ${line.logicalLineId}.`;
      }
      seenLogicalLineIds.add(line.logicalLineId);
    }

    if (seenVariantIds.has(line.variantId)) {
      return `desiredLines[${i}].variantId en double dans desiredLines: ${line.variantId}.`;
    }
    seenVariantIds.add(line.variantId);

    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      return `desiredLines[${i}].quantity doit être un entier strictement positif.`;
    }
  }

  return null;
}

export function computeAmendmentFingerprint(
  command: NeutralAmendmentCommand,
  version: 'amendment-neutral-v2' | 'amendment-refund-v1' = 'amendment-neutral-v2',
): string {
  const sortedLines = [...command.desiredLines].sort((a, b) => {
    if (a.variantId !== b.variantId) {
      return a.variantId < b.variantId ? -1 : 1;
    }
    const aLid = a.logicalLineId ?? '';
    const bLid = b.logicalLineId ?? '';
    return aLid < bLid ? -1 : aLid > bLid ? 1 : 0;
  });

  const intentCanonical =
    command.intent.kind === 'TIME_RANGE'
      ? { kind: 'TIME_RANGE', startAt: command.intent.startAt, endAt: command.intent.endAt }
      : {
          kind: 'DAY_RANGE',
          startDate: command.intent.startDate,
          endDateExclusive: command.intent.endDateExclusive,
        };

  const canonical = {
    booking_id: command.bookingId,
    desired_lines: sortedLines.map((l) => ({
      logical_line_id: l.logicalLineId ?? null,
      quantity: l.quantity,
      variant_id: l.variantId,
    })),
    expected_last_applied_amendment_number: command.expectedLastAppliedAmendmentNumber,
    intent: intentCanonical,
    v: version,
  };

  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

export type LineAction = 'ADD' | 'MODIFY' | 'REMOVE' | 'UNCHANGED';

export interface LineDiffEntry {
  action: LineAction;
  logicalLineId: string;
  variantId: string;
  originType: 'ORIGINAL' | 'AMENDMENT';
  sourceBookingLineId: string | null;
  beforeQuantity: number;
  beforeUnitPriceAmountMinor: number;
  beforeLineTotalAmountMinor: number;
  afterQuantity: number;
  afterUnitPriceAmountMinor: number;
  afterLineTotalAmountMinor: number;
}

export function computeLineDiff(
  effectiveLines: readonly EffectiveLine[],
  desiredLines: readonly NeutralAmendmentDesiredLine[],
): LineDiffEntry[] {
  const effectiveByLogicalId = new Map<string, EffectiveLine>();
  const effectiveVariantIds = new Set<string>();
  for (const el of effectiveLines) {
    effectiveByLogicalId.set(el.logicalLineId, el);
    effectiveVariantIds.add(el.variantId);
  }

  const desiredLogicalIds = new Set<string>();
  const matchedEffectiveIds = new Set<string>();
  const entries: LineDiffEntry[] = [];

  for (const desired of desiredLines) {
    if (desired.logicalLineId !== undefined) {
      const existing = effectiveByLogicalId.get(desired.logicalLineId);
      if (!existing) {
        throw new BusinessSignal({
          kind: 'INVALID_INPUT',
          message: `logicalLineId ${desired.logicalLineId} introuvable dans l'état effectif.`,
        });
      }
      if (existing.variantId !== desired.variantId) {
        throw new BusinessSignal({
          kind: 'INVALID_INPUT',
          message: `logicalLineId ${desired.logicalLineId} ne correspond pas à la variante ${desired.variantId}.`,
        });
      }
      desiredLogicalIds.add(desired.logicalLineId);
      matchedEffectiveIds.add(existing.id);

      const action: LineAction = existing.quantity === desired.quantity ? 'UNCHANGED' : 'MODIFY';
      entries.push({
        action,
        logicalLineId: desired.logicalLineId,
        variantId: desired.variantId,
        originType: existing.originType,
        sourceBookingLineId: existing.sourceBookingLineId,
        beforeQuantity: existing.quantity,
        beforeUnitPriceAmountMinor: existing.unitPriceAmountMinor,
        beforeLineTotalAmountMinor: existing.lineTotalAmountMinor,
        afterQuantity: desired.quantity,
        afterUnitPriceAmountMinor: 0,
        afterLineTotalAmountMinor: 0,
      });
    } else {
      if (effectiveVariantIds.has(desired.variantId)) {
        throw new BusinessSignal({
          kind: 'INVALID_INPUT',
          message: `La variante ${desired.variantId} est déjà présente dans l'état effectif. Fournir le logicalLineId existant.`,
        });
      }
      const newLogicalId = randomUUID();
      entries.push({
        action: 'ADD',
        logicalLineId: newLogicalId,
        variantId: desired.variantId,
        originType: 'AMENDMENT',
        sourceBookingLineId: null,
        beforeQuantity: 0,
        beforeUnitPriceAmountMinor: 0,
        beforeLineTotalAmountMinor: 0,
        afterQuantity: desired.quantity,
        afterUnitPriceAmountMinor: 0,
        afterLineTotalAmountMinor: 0,
      });
    }
  }

  for (const [logicalId, existing] of effectiveByLogicalId) {
    if (!desiredLogicalIds.has(logicalId) && !matchedEffectiveIds.has(existing.id)) {
      entries.push({
        action: 'REMOVE',
        logicalLineId: logicalId,
        variantId: existing.variantId,
        originType: existing.originType,
        sourceBookingLineId: existing.sourceBookingLineId,
        beforeQuantity: existing.quantity,
        beforeUnitPriceAmountMinor: existing.unitPriceAmountMinor,
        beforeLineTotalAmountMinor: existing.lineTotalAmountMinor,
        afterQuantity: 0,
        afterUnitPriceAmountMinor: 0,
        afterLineTotalAmountMinor: 0,
      });
    }
  }

  return entries;
}

export type DeltaClassification = 'NEUTRAL' | 'REFUND' | 'SUPPLEMENT';

export function classifyDelta(deltaMinor: number): DeltaClassification {
  if (deltaMinor < 0) return 'REFUND';
  if (deltaMinor > 0) return 'SUPPLEMENT';
  return 'NEUTRAL';
}

function extractReplayResult(
  record: { resourceId: string | null; responseBody: unknown },
  expectedClassification: AmendmentClassification,
): NeutralAmendmentResult | RefundAmendmentResult | null {
  const body = record.responseBody;
  if (typeof body !== 'object' || body === null) return null;
  const obj = body as Record<string, unknown>;
  const kind = obj['kind'];

  if (expectedClassification === 'NEUTRAL') {
    if (
      (kind === 'SUCCESS' || kind === 'REPLAY') &&
      typeof obj['amendmentId'] === 'string' &&
      typeof obj['amendmentNumber'] === 'number'
    ) {
      return {
        kind: 'REPLAY',
        amendmentId: obj['amendmentId'] as string,
        amendmentNumber: obj['amendmentNumber'] as number,
      };
    }
  } else {
    if (
      (kind === 'SUCCESS' || kind === 'REPLAY') &&
      typeof obj['amendmentId'] === 'string' &&
      typeof obj['amendmentNumber'] === 'number' &&
      typeof obj['refundId'] === 'string' &&
      typeof obj['refundAmountMinor'] === 'number'
    ) {
      return {
        kind: 'REPLAY',
        amendmentId: obj['amendmentId'] as string,
        amendmentNumber: obj['amendmentNumber'] as number,
        refundId: obj['refundId'] as string,
        refundAmountMinor: obj['refundAmountMinor'] as number,
      };
    }
  }

  if (
    kind === 'NOT_FOUND' ||
    kind === 'FORBIDDEN' ||
    kind === 'BOOKING_NOT_CONFIRMED' ||
    kind === 'ACTIVE_AMENDMENT_EXISTS' ||
    kind === 'IDEMPOTENCY_CONFLICT'
  ) {
    return { kind } as NeutralAmendmentResult | RefundAmendmentResult;
  }
  if (
    kind === 'STALE_EFFECTIVE_BOOKING' &&
    typeof obj['expected'] === 'number' &&
    typeof obj['actual'] === 'number'
  ) {
    return {
      kind: 'STALE_EFFECTIVE_BOOKING',
      expected: obj['expected'] as number,
      actual: obj['actual'] as number,
    };
  }
  if (kind === 'INVALID_INPUT' && typeof obj['message'] === 'string') {
    return { kind: 'INVALID_INPUT', message: obj['message'] };
  }
  if (kind === 'AVAILABILITY_CONFLICT' && typeof obj['message'] === 'string') {
    return { kind: 'AVAILABILITY_CONFLICT', message: obj['message'] };
  }
  if (kind === 'FINANCIAL_ACTION_REQUIRED' && typeof obj['deltaMinor'] === 'number') {
    return {
      kind: 'FINANCIAL_ACTION_REQUIRED',
      classification: obj['classification'] as 'NEUTRAL' | 'REFUND' | 'SUPPLEMENT',
      deltaMinor: obj['deltaMinor'] as number,
    } as NeutralAmendmentResult | RefundAmendmentResult;
  }
  return null;
}

function buildIntentSnapshot(intent: NeutralAmendmentIntent): Record<string, unknown> {
  if (intent.kind === 'TIME_RANGE') {
    return {
      kind: 'TIME_RANGE',
      startAt: intent.startAt,
      endAt: intent.endAt,
    };
  }
  return {
    kind: 'DAY_RANGE',
    startDate: intent.startDate,
    endDateExclusive: intent.endDateExclusive,
  };
}

export async function executeBookingAmendmentInternal(
  db: DatabaseClient,
  authenticatedActor: AuthenticatedUser,
  organizationId: string,
  command: NeutralAmendmentCommand,
  expectedClassification: AmendmentClassification,
  options?: { now?: Date },
): Promise<NeutralAmendmentResult | RefundAmendmentResult> {
  if (!UUID_REGEX.test(authenticatedActor.id)) {
    return { kind: 'FORBIDDEN' };
  }
  const validationError = validateCommand(command);
  if (validationError !== null) {
    return { kind: 'INVALID_INPUT', message: validationError };
  }
  if (!UUID_REGEX.test(organizationId)) {
    return { kind: 'INVALID_INPUT', message: 'organizationId invalide (UUID attendu).' };
  }

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

  const operation =
    expectedClassification === 'NEUTRAL' ? 'booking-amendment-neutral' : 'booking-amendment-refund';
  const fingerprintVersion =
    expectedClassification === 'NEUTRAL' ? 'amendment-neutral-v2' : 'amendment-refund-v1';

  const fingerprint = computeAmendmentFingerprint(command, fingerprintVersion);

  const reservation = await reserveKey(db, {
    organizationId,
    operation,
    key: command.idempotencyKey,
    requestFingerprint: fingerprint,
  });

  if (reservation.kind === 'REPLAY') {
    const replay = extractReplayResult(reservation.record, expectedClassification);
    if (replay) return replay;
    return { kind: 'IDEMPOTENCY_CONFLICT' };
  }
  if (reservation.kind === 'CONFLICT') {
    return { kind: 'IDEMPOTENCY_CONFLICT' };
  }

  return await db.transaction(async (tx) => {
    await lockOrganization(tx, organizationId);

    const lock = await lockKey(tx, reservation.record.id);
    if (lock.kind === 'REPLAY') {
      const replay = extractReplayResult(lock.record, expectedClassification);
      if (replay) return replay;
      return { kind: 'IDEMPOTENCY_CONFLICT' };
    }

    {
      const txMembershipRows = await tx
        .select({ role: organizationMemberships.role, status: organizationMemberships.status })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.organizationId, organizationId),
            eq(organizationMemberships.userId, authenticatedActor.id),
          ),
        )
        .limit(1);
      if (txMembershipRows.length === 0 || txMembershipRows[0]!.status !== 'ACTIVE') {
        await failKey(tx, reservation.record.id, {
          responseStatusCode: 200,
          responseBody: { kind: 'FORBIDDEN' },
        });
        return { kind: 'FORBIDDEN' };
      }
      const roleRank: Record<string, number> = { STAFF: 0, MANAGER: 1, ADMIN: 2, OWNER: 3 };
      if ((roleRank[txMembershipRows[0]!.role] ?? -1) < 1) {
        await failKey(tx, reservation.record.id, {
          responseStatusCode: 200,
          responseBody: { kind: 'FORBIDDEN' },
        });
        return { kind: 'FORBIDDEN' };
      }
    }

    let businessResult: NeutralAmendmentResult | RefundAmendmentResult;
    try {
      businessResult = await tx.transaction(async (sp) => {
        return await executeBusinessLogic(
          sp,
          organizationId,
          command,
          authenticatedActor,
          expectedClassification,
          options?.now ?? new Date(),
        );
      });
    } catch (error) {
      if (error instanceof BusinessSignal) {
        await failKey(tx, reservation.record.id, {
          responseStatusCode: 200,
          responseBody: error.result,
        });
        return error.result;
      }
      if (isExclusionViolation(error, 'no_overlapping_blocks')) {
        const conflictResult = {
          kind: 'AVAILABILITY_CONFLICT',
          message: "Conflit de disponibilité d'inventaire.",
        };
        await failKey(tx, reservation.record.id, {
          responseStatusCode: 200,
          responseBody: conflictResult,
        });
        return conflictResult;
      }
      throw error;
    }

    if (businessResult.kind === 'SUCCESS') {
      await completeKey(tx, reservation.record.id, {
        resourceId: businessResult.amendmentId,
        responseStatusCode: 200,
        responseBody: businessResult,
      });
    } else {
      await failKey(tx, reservation.record.id, {
        responseStatusCode: 200,
        responseBody: businessResult,
      });
    }

    return businessResult;
  });
}

async function executeBusinessLogic(
  sp: DatabaseTransaction,
  organizationId: string,
  command: NeutralAmendmentCommand,
  authenticatedActor: AuthenticatedUser,
  expectedClassification: AmendmentClassification,
  now: Date,
): Promise<NeutralAmendmentResult | RefundAmendmentResult> {
  const bookingLockRows = await sp
    .select({ id: bookings.id, paymentId: bookings.paymentId })
    .from(bookings)
    .where(and(eq(bookings.id, command.bookingId), eq(bookings.organizationId, organizationId)))
    .for('update')
    .limit(1);

  if (bookingLockRows.length === 0) {
    throw new BusinessSignal({ kind: 'NOT_FOUND' });
  }
  const localPaymentId = bookingLockRows[0]!.paymentId;

  await sp
    .select({ id: bookingAmendments.id })
    .from(bookingAmendments)
    .where(
      and(
        eq(bookingAmendments.bookingId, command.bookingId),
        eq(bookingAmendments.organizationId, organizationId),
      ),
    )
    .for('update')
    .limit(1);

  const effectiveResult = await getEffectiveBooking(sp, organizationId, command.bookingId);
  if (effectiveResult.kind === 'NOT_FOUND') {
    throw new BusinessSignal({ kind: 'NOT_FOUND' });
  }
  const effectiveBooking = effectiveResult.booking;

  if (effectiveBooking.booking.status !== 'CONFIRMED') {
    throw new BusinessSignal({ kind: 'BOOKING_NOT_CONFIRMED' });
  }

  const activeAmendments = await sp
    .select({ id: bookingAmendments.id })
    .from(bookingAmendments)
    .where(
      and(
        eq(bookingAmendments.bookingId, command.bookingId),
        eq(bookingAmendments.organizationId, organizationId),
        inArray(bookingAmendments.status, ['HOLD_PENDING', 'READY_TO_APPLY']),
      ),
    )
    .limit(1);

  if (activeAmendments.length > 0) {
    throw new BusinessSignal({ kind: 'ACTIVE_AMENDMENT_EXISTS' });
  }

  const actual = effectiveBooking.lastAppliedAmendmentNumber;
  if (command.expectedLastAppliedAmendmentNumber !== actual) {
    throw new BusinessSignal({
      kind: 'STALE_EFFECTIVE_BOOKING',
      expected: command.expectedLastAppliedAmendmentNumber,
      actual,
    });
  }

  const locRows = await sp
    .select({
      prepBufferMinutes: locations.prepBufferMinutes,
      cleanupBufferMinutes: locations.cleanupBufferMinutes,
      timeZone: locations.timeZone,
    })
    .from(locations)
    .where(and(eq(locations.id, effectiveBooking.booking.locationId), isNull(locations.deletedAt)))
    .limit(1);

  if (locRows.length === 0) {
    const ErrorClass =
      expectedClassification === 'NEUTRAL' ? NeutralAmendmentError : RefundAmendmentError;
    throw new ErrorClass(
      'INTERNAL',
      `Location ${effectiveBooking.booking.locationId} introuvable.`,
    );
  }
  const loc = locRows[0]!;
  const timeZone = loc.timeZone;

  let quoteResult;
  try {
    quoteResult = await quoteFlexiblePricing(sp, {
      organizationId,
      locationId: effectiveBooking.booking.locationId,
      locale: 'fr-FR',
      intent: command.intent,
      lines: command.desiredLines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    });
  } catch (err) {
    if (err instanceof FlexiblePricingError) {
      throw new BusinessSignal({
        kind: 'INVALID_INPUT',
        message: err.message,
      });
    }
    throw err;
  }

  let newCustomerStartAt: Date;
  let newCustomerEndAt: Date;

  if (command.intent.kind === 'TIME_RANGE') {
    newCustomerStartAt = localDateTimeStringToUtc(command.intent.startAt, timeZone);
    newCustomerEndAt = localDateTimeStringToUtc(command.intent.endAt, timeZone);
  } else {
    let minStartUtc: Date | null = null;
    let maxEndUtc: Date | null = null;

    for (const quoteLine of quoteResult.lines) {
      if (quoteLine.planType === 'DAILY' && quoteLine.dayRangeBoundaries) {
        const firstDay = quoteLine.dayRangeBoundaries.firstDay;
        const lastDay = quoteLine.dayRangeBoundaries.lastDay;

        const firstStartUtc = localDateTimeToUtc(
          parseLocalDateTime(firstDay.localDate, firstDay.startTime),
          timeZone,
        );
        const lastEndUtc = localDateTimeToUtc(
          parseLocalDateTime(lastDay.localDate, lastDay.endTime),
          timeZone,
        );

        if (minStartUtc === null || firstStartUtc.getTime() < minStartUtc.getTime()) {
          minStartUtc = firstStartUtc;
        }
        if (maxEndUtc === null || lastEndUtc.getTime() > maxEndUtc.getTime()) {
          maxEndUtc = lastEndUtc;
        }
      }
    }

    if (minStartUtc === null || maxEndUtc === null) {
      throw new BusinessSignal({
        kind: 'INVALID_INPUT',
        message: 'DAY_RANGE : impossible de dériver les dates client.',
      });
    }
    newCustomerStartAt = minStartUtc;
    newCustomerEndAt = maxEndUtc;
  }

  const newBlockedStartAt = new Date(
    newCustomerStartAt.getTime() - loc.prepBufferMinutes * 60 * 1000,
  );
  const newBlockedEndAt = new Date(
    newCustomerEndAt.getTime() + loc.cleanupBufferMinutes * 60 * 1000,
  );

  const variantIds = [...new Set(command.desiredLines.map((l) => l.variantId))];
  const variantDataMap = new Map<
    string,
    {
      snapshot: {
        productName: string;
        variantName: string;
        skuSuffix: string | null;
        attributes: Record<string, unknown>;
      };
    }
  >();

  for (const variantId of variantIds) {
    const variantData = await sp
      .select({ variant: productVariants, product: products })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(and(eq(productVariants.id, variantId), eq(products.organizationId, organizationId)))
      .limit(1);

    if (variantData.length === 0) {
      throw new BusinessSignal({
        kind: 'INVALID_INPUT',
        message: `Variante ${variantId} introuvable dans l'organisation.`,
      });
    }

    const { variant, product } = variantData[0]!;
    if (product.publicationStatus !== 'PUBLISHED' || product.deletedAt !== null) {
      throw new BusinessSignal({
        kind: 'INVALID_INPUT',
        message: `Produit ${product.name} non valide.`,
      });
    }
    if (!variant.isActive || variant.deletedAt !== null) {
      throw new BusinessSignal({
        kind: 'INVALID_INPUT',
        message: `Variante ${variant.name} inactive ou supprimée.`,
      });
    }

    variantDataMap.set(variantId, {
      snapshot: {
        productName: product.name,
        variantName: variant.name,
        skuSuffix: variant.skuSuffix,
        attributes: (variant.attributes ?? {}) as Record<string, unknown>,
      },
    });
  }

  const financialSnapshotBefore = {
    totalAmountMinor: effectiveBooking.effectiveTotalAmountMinor,
    currency: 'EUR' as const,
  };
  const financialSnapshotAfter = {
    totalAmountMinor: quoteResult.totalAmountMinor,
    currency: 'EUR' as const,
  };

  const delta = financialSnapshotAfter.totalAmountMinor - financialSnapshotBefore.totalAmountMinor;
  const deltaClass = classifyDelta(delta);

  if (expectedClassification === 'NEUTRAL') {
    if (deltaClass === 'REFUND') {
      throw new BusinessSignal({
        kind: 'FINANCIAL_ACTION_REQUIRED',
        classification: 'REFUND',
        deltaMinor: Math.abs(delta),
      });
    }
    if (deltaClass === 'SUPPLEMENT') {
      throw new BusinessSignal({
        kind: 'FINANCIAL_ACTION_REQUIRED',
        classification: 'SUPPLEMENT',
        deltaMinor: delta,
      });
    }
  } else if (expectedClassification === 'REFUND') {
    if (deltaClass === 'NEUTRAL') {
      throw new BusinessSignal({
        kind: 'FINANCIAL_ACTION_REQUIRED',
        classification: 'NEUTRAL',
        deltaMinor: 0,
      });
    }
    if (deltaClass === 'SUPPLEMENT') {
      throw new BusinessSignal({
        kind: 'FINANCIAL_ACTION_REQUIRED',
        classification: 'SUPPLEMENT',
        deltaMinor: delta,
      });
    }
  }

  const lineDiff = computeLineDiff(effectiveBooking.lines, command.desiredLines);

  const quoteLineMap = new Map<string, (typeof quoteResult.lines)[number]>();
  for (const ql of quoteResult.lines) {
    quoteLineMap.set(ql.variantId, ql);
  }

  let nonRemoveSum = 0;
  for (const entry of lineDiff) {
    if (entry.action !== 'REMOVE') {
      const ql = quoteLineMap.get(entry.variantId);
      if (!ql) {
        const ErrorClass =
          expectedClassification === 'NEUTRAL' ? NeutralAmendmentError : RefundAmendmentError;
        throw new ErrorClass(
          'INTERNAL',
          `Ligne de devis introuvable pour la variante ${entry.variantId}.`,
        );
      }
      entry.afterUnitPriceAmountMinor = ql.unitPriceAmountMinor;
      entry.afterLineTotalAmountMinor = ql.lineTotalAmountMinor;
      nonRemoveSum += ql.lineTotalAmountMinor;

      if (
        entry.action === 'UNCHANGED' &&
        (entry.beforeUnitPriceAmountMinor !== entry.afterUnitPriceAmountMinor ||
          entry.beforeLineTotalAmountMinor !== entry.afterLineTotalAmountMinor)
      ) {
        entry.action = 'MODIFY';
      }
    } else {
      entry.afterQuantity = 0;
      entry.afterUnitPriceAmountMinor = 0;
      entry.afterLineTotalAmountMinor = 0;
    }
  }

  if (nonRemoveSum !== quoteResult.totalAmountMinor) {
    const ErrorClass =
      expectedClassification === 'NEUTRAL' ? NeutralAmendmentError : RefundAmendmentError;
    throw new ErrorClass(
      'INTERNAL',
      `Incohérence des totaux : la somme des lignes (${nonRemoveSum}) ne correspond pas au total du devis (${quoteResult.totalAmountMinor}).`,
    );
  }

  const allocationPlan = await computeAllocationPlan(
    sp,
    organizationId,
    command.bookingId,
    effectiveBooking.allocations,
    lineDiff,
    newCustomerStartAt,
    newCustomerEndAt,
    newBlockedStartAt,
    newBlockedEndAt,
    expectedClassification,
  );

  if (allocationPlan.conflict) {
    throw new BusinessSignal({ kind: 'AVAILABILITY_CONFLICT', message: allocationPlan.conflict });
  }

  const allBlockIds = new Set<string>();
  for (const alloc of allocationPlan.allocations) {
    if (alloc.sourceBookingBlockId) allBlockIds.add(alloc.sourceBookingBlockId);
  }
  if (allBlockIds.size > 0) {
    await sp
      .select({ id: inventoryBlocks.id })
      .from(inventoryBlocks)
      .where(inArray(inventoryBlocks.id, [...allBlockIds]))
      .orderBy(asc(inventoryBlocks.id))
      .for('update');
  }

  // --- TRAITEMENT SPÉCIFIQUE REFUND : LOCK PAIEMENT & VERIFICATION DU CAP CUMULATIF ---
  let refundId: string | undefined;
  const refundAmountMinor = Math.abs(delta);

  if (expectedClassification === 'REFUND') {
    const paymentLockRows = await sp
      .select({
        id: payments.id,
        amountMinor: payments.amountMinor,
        organizationId: payments.organizationId,
        status: payments.status,
        currency: payments.currency,
      })
      .from(payments)
      .where(eq(payments.id, localPaymentId))
      .for('update')
      .limit(1);

    if (paymentLockRows.length === 0) {
      throw new BusinessSignal({
        kind: 'INVALID_INPUT',
        message: 'Paiement initial introuvable.',
      });
    }
    const initialPayment = paymentLockRows[0]!;

    if (
      initialPayment.organizationId !== organizationId ||
      initialPayment.status !== 'SUCCEEDED' ||
      initialPayment.currency !== 'EUR' ||
      typeof initialPayment.amountMinor !== 'number' ||
      !Number.isSafeInteger(initialPayment.amountMinor) ||
      initialPayment.amountMinor < 0
    ) {
      throw new BusinessSignal({
        kind: 'INVALID_INPUT',
        message: 'Invariants du paiement initial non satisfaits.',
      });
    }

    const existingRefundSumRows = await sp
      .select({ total: sum(refunds.amountMinor) })
      .from(refunds)
      .where(
        and(
          eq(refunds.paymentId, initialPayment.id),
          inArray(refunds.status, [
            'PENDING',
            'SUBMITTED',
            'SUCCEEDED',
            'FAILED_REQUIRES_MANUAL_ACTION',
            'SETTLED_OFF_PLATFORM',
          ]),
        ),
      );

    const rawSum = existingRefundSumRows[0]?.total;
    const existingRefundTotal = Number(rawSum ?? 0);

    if (
      typeof existingRefundTotal !== 'number' ||
      !Number.isSafeInteger(existingRefundTotal) ||
      existingRefundTotal < 0
    ) {
      throw new BusinessSignal({
        kind: 'INVALID_INPUT',
        message: 'Somme des remboursements invalide.',
      });
    }

    if (existingRefundTotal + refundAmountMinor > initialPayment.amountMinor) {
      throw new BusinessSignal({
        kind: 'INVALID_INPUT',
        message: `Dépassement du montant du paiement initial : demandé ${refundAmountMinor}, déjà engagé/remboursé ${existingRefundTotal}, capturé ${initialPayment.amountMinor}.`,
      });
    }
  }

  const amendmentNumber = actual + 1;
  const insertedAmendments = await sp
    .insert(bookingAmendments)
    .values({
      organizationId,
      bookingId: command.bookingId,
      amendmentNumber,
      type: expectedClassification,
      status: 'READY_TO_APPLY',
      financialSnapshotBefore,
      financialSnapshotAfter,
      newCustomerStartAt,
      newCustomerEndAt,
      newBlockedStartAt,
      newBlockedEndAt,
      holdDeadline: null,
      createdBy: authenticatedActor.id,
    })
    .returning({ id: bookingAmendments.id });

  const amendmentId = insertedAmendments[0]!.id;

  const logicalLineIdToActualId = new Map<string, string>();
  const intentSnapshot = buildIntentSnapshot(command.intent);

  for (const entry of lineDiff) {
    const vd = variantDataMap.get(entry.variantId);
    const variantSnapshot = vd?.snapshot ?? {
      productName: '',
      variantName: '',
      skuSuffix: null,
      attributes: {},
    };

    const ql = quoteLineMap.get(entry.variantId);
    if (entry.action !== 'REMOVE' && !ql) {
      const ErrorClass =
        expectedClassification === 'NEUTRAL' ? NeutralAmendmentError : RefundAmendmentError;
      throw new ErrorClass(
        'INTERNAL',
        `Ligne de devis introuvable pour la variante ${entry.variantId}.`,
      );
    }

    const pricingSnapshot = {
      algorithmVersion: quoteResult.algorithmVersion,
      roundingRuleVersion: quoteResult.roundingRuleVersion,
      resolvedLocale: quoteResult.resolvedLocale,
      intentSnapshot,
      planId: ql?.pricingPlanId ?? null,
      planVersion: ql?.planVersion ?? null,
      planType: ql?.planType ?? null,
      publicLabel: ql?.publicLabel ?? null,
      billableUnitCount: ql?.billableUnitCount ?? null,
      requestedDurationMinutes:
        command.intent.kind === 'DAY_RANGE' ? null : (ql?.requestedDurationMinutes ?? null),
      billedDurationMinutes: ql?.billedDurationMinutes ?? null,
      coveredDurationMinutes: ql?.coveredDurationMinutes ?? null,
      billedDays: ql?.billedDays ?? null,
      selectedWindow: ql?.windowSnapshot ?? null,
      discountThresholdDays: ql?.discountThresholdDays ?? null,
      discountPercent: ql?.discountPercent ?? null,
      amountBeforeDiscountMinor: ql?.amountBeforeDiscountMinor ?? null,
      amountAfterDiscountMinor: ql?.amountAfterDiscountMinor ?? null,
    };

    const insertedLine = await sp
      .insert(bookingAmendmentLines)
      .values({
        amendmentId,
        organizationId,
        logicalLineId: entry.logicalLineId,
        originType: entry.originType,
        sourceBookingLineId: entry.sourceBookingLineId,
        variantId: entry.variantId,
        action: entry.action,
        beforeQuantity: entry.beforeQuantity,
        beforeUnitPriceAmountMinor: entry.beforeUnitPriceAmountMinor,
        beforeLineTotalAmountMinor: entry.beforeLineTotalAmountMinor,
        afterQuantity: entry.afterQuantity,
        afterUnitPriceAmountMinor: entry.afterUnitPriceAmountMinor,
        afterLineTotalAmountMinor: entry.afterLineTotalAmountMinor,
        pricingSnapshot,
        variantSnapshot,
      })
      .returning({ id: bookingAmendmentLines.id });

    logicalLineIdToActualId.set(entry.logicalLineId, insertedLine[0]!.id);
  }

  for (const alloc of allocationPlan.allocations) {
    const actualLineId = logicalLineIdToActualId.get(alloc.amendmentLineId);
    if (actualLineId) {
      alloc.amendmentLineId = actualLineId;
    }
  }

  const newBlocksToInsert: Array<{
    inventoryItemId: string;
    allocationIndex: number;
  }> = [];

  for (let i = 0; i < allocationPlan.allocations.length; i++) {
    const alloc = allocationPlan.allocations[i]!;
    const insertedAlloc = await sp
      .insert(bookingAmendmentAllocations)
      .values({
        amendmentId,
        amendmentLineId: alloc.amendmentLineId,
        organizationId,
        inventoryItemId: alloc.inventoryItemId,
        action: alloc.action,
        sourceBookingBlockId: alloc.sourceBookingBlockId,
        appliedBookingBlockId: null,
        status: 'PROPOSED',
        effectiveCustomerStartAt: newCustomerStartAt,
        effectiveCustomerEndAt: newCustomerEndAt,
        effectiveBlockedStartAt: newBlockedStartAt,
        effectiveBlockedEndAt: newBlockedEndAt,
      })
      .returning({ id: bookingAmendmentAllocations.id });

    alloc.allocationId = insertedAlloc[0]!.id;

    if (alloc.action === 'ADD' || alloc.action === 'REPLACE') {
      newBlocksToInsert.push({ inventoryItemId: alloc.inventoryItemId, allocationIndex: i });
    }
  }

  for (const alloc of allocationPlan.allocations) {
    if ((alloc.action === 'REMOVE' || alloc.action === 'REPLACE') && alloc.sourceBookingBlockId) {
      await sp
        .update(inventoryBlocks)
        .set({ status: 'RELEASED', updatedAt: now })
        .where(eq(inventoryBlocks.id, alloc.sourceBookingBlockId));
    }
  }

  for (const nb of newBlocksToInsert) {
    const alloc = allocationPlan.allocations[nb.allocationIndex]!;
    const insertedBlock = await sp
      .insert(inventoryBlocks)
      .values({
        organizationId,
        inventoryItemId: nb.inventoryItemId,
        type: 'BOOKING',
        status: 'ACTIVE',
        customerStartAt: newCustomerStartAt,
        customerEndAt: newCustomerEndAt,
        blockedStartAt: newBlockedStartAt,
        blockedEndAt: newBlockedEndAt,
        sourceId: command.bookingId,
      })
      .returning({ id: inventoryBlocks.id });

    alloc.newBlockId = insertedBlock[0]!.id;
  }

  for (const alloc of allocationPlan.allocations) {
    if (alloc.action === 'REMOVE') {
      await sp
        .update(bookingAmendmentAllocations)
        .set({ status: 'RELEASED' })
        .where(eq(bookingAmendmentAllocations.id, alloc.allocationId!));
    } else {
      const appliedBlockId = alloc.newBlockId ?? alloc.sourceBookingBlockId;
      await sp
        .update(bookingAmendmentAllocations)
        .set({
          status: 'CONVERTED',
          appliedBookingBlockId: appliedBlockId,
        })
        .where(eq(bookingAmendmentAllocations.id, alloc.allocationId!));
    }
  }

  await sp
    .update(bookingAmendments)
    .set({ status: 'APPLIED', appliedAt: now, updatedAt: now })
    .where(eq(bookingAmendments.id, amendmentId));

  // --- INSERTION DU REFUND ET EVENT REFUND_REQUESTED ---
  if (expectedClassification === 'REFUND') {
    refundId = randomUUID();
    const providerIdempotencyKey = `refund_amendment_${refundId}`;
    await sp.insert(refunds).values({
      id: refundId,
      organizationId,
      paymentId: localPaymentId,
      amendmentPaymentId: null,
      reason: 'BOOKING_MODIFICATION',
      status: 'PENDING',
      amountMinor: refundAmountMinor,
      currency: 'EUR',
      reverseTransfer: true,
      refundApplicationFee: true,
      requestedAt: now,
      providerIdempotencyKey,
    });

    await sp
      .insert(outboxEvents)
      .values({
        organizationId,
        aggregateType: REFUND_REQUESTED_AGGREGATE_TYPE,
        aggregateId: refundId,
        eventType: REFUND_REQUESTED_EVENT_TYPE,
        eventVersion: REFUND_REQUESTED_EVENT_VERSION,
        payload: {
          organizationId,
          bookingId: command.bookingId,
          amendmentId,
          refundId,
        },
        status: 'PENDING',
        attemptCount: 0,
        availableAt: now,
        idempotencyKey: `refund_requested_${refundId}`,
      })
      .onConflictDoNothing({ target: [outboxEvents.idempotencyKey] });
  }

  // --- INSERTION BOOKING_AMENDED.v1 (clé d'idempotence stricte booking_amended_${amendmentId}) ---
  await sp
    .insert(outboxEvents)
    .values({
      organizationId,
      aggregateType: BOOKING_AMENDED_AGGREGATE_TYPE,
      aggregateId: command.bookingId,
      eventType: BOOKING_AMENDED_EVENT_TYPE,
      eventVersion: BOOKING_AMENDED_EVENT_VERSION,
      payload: { organizationId, bookingId: command.bookingId, amendmentId },
      status: 'PENDING',
      attemptCount: 0,
      availableAt: now,
      idempotencyKey: `booking_amended_${amendmentId}`,
    })
    .onConflictDoNothing({ target: [outboxEvents.idempotencyKey] });

  if (expectedClassification === 'REFUND') {
    return {
      kind: 'SUCCESS',
      amendmentId,
      amendmentNumber,
      refundId: refundId!,
      refundAmountMinor,
    };
  }

  return { kind: 'SUCCESS', amendmentId, amendmentNumber };
}

interface AllocationPlanEntry {
  action: 'RETAIN' | 'ADD' | 'REMOVE' | 'REPLACE';
  amendmentLineId: string;
  inventoryItemId: string;
  sourceBookingBlockId: string | null;
  datesChanged: boolean;
  allocationId?: string;
  newBlockId?: string;
}

interface AllocationPlan {
  allocations: AllocationPlanEntry[];
  conflict: string | null;
}

async function computeAllocationPlan(
  sp: DatabaseTransaction,
  organizationId: string,
  bookingId: string,
  effectiveAllocations: readonly EffectiveAllocation[],
  lineDiff: LineDiffEntry[],
  newCustomerStartAt: Date,
  newCustomerEndAt: Date,
  newBlockedStartAt: Date,
  newBlockedEndAt: Date,
  expectedClassification: AmendmentClassification,
): Promise<AllocationPlan> {
  const desiredQtyByVariant = new Map<string, number>();
  const variantToLineId = new Map<string, string>();
  for (const entry of lineDiff) {
    if (entry.action !== 'REMOVE') {
      const current = desiredQtyByVariant.get(entry.variantId) ?? 0;
      desiredQtyByVariant.set(entry.variantId, current + entry.afterQuantity);
      variantToLineId.set(entry.variantId, entry.logicalLineId);
    }
  }

  const logicalLineToVariant = new Map<string, string>();
  for (const entry of lineDiff) {
    logicalLineToVariant.set(entry.logicalLineId, entry.variantId);
  }

  const effectiveAllocsByVariant = new Map<string, EffectiveAllocation[]>();
  for (const ea of effectiveAllocations) {
    const variantId = logicalLineToVariant.get(ea.logicalLineId);
    if (variantId) {
      const arr = effectiveAllocsByVariant.get(variantId) ?? [];
      arr.push(ea);
      effectiveAllocsByVariant.set(variantId, arr);
    }
  }

  const allocations: AllocationPlanEntry[] = [];

  for (const [variantId, desiredQty] of desiredQtyByVariant) {
    const currentAllocs = effectiveAllocsByVariant.get(variantId) ?? [];
    const amendmentLineId = variantToLineId.get(variantId)!;

    const retainedCount = Math.min(currentAllocs.length, desiredQty);
    for (let i = 0; i < retainedCount; i++) {
      const ea = currentAllocs[i]!;
      const sourceBlockId = await findSourceBlockId(
        sp,
        organizationId,
        bookingId,
        ea,
        expectedClassification,
      );
      const datesChanged =
        ea.effectiveCustomerStartAt.getTime() !== newCustomerStartAt.getTime() ||
        ea.effectiveCustomerEndAt.getTime() !== newCustomerEndAt.getTime();

      allocations.push({
        action: datesChanged ? 'REPLACE' : 'RETAIN',
        amendmentLineId,
        inventoryItemId: ea.inventoryItemId,
        sourceBookingBlockId: sourceBlockId,
        datesChanged,
      });
    }

    const addCount = desiredQty - retainedCount;
    if (addCount > 0) {
      const availableItems = await sp
        .select({
          id: inventoryItems.id,
        })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.organizationId, organizationId),
            eq(inventoryItems.productVariantId, variantId),
            eq(inventoryItems.status, 'ACTIVE'),
            isNull(inventoryItems.deletedAt),
            inArray(inventoryItems.condition, ['NEW', 'GOOD', 'FAIR']),
            not(
              exists(
                sp
                  .select({ one: inventoryBlocks })
                  .from(inventoryBlocks)
                  .where(
                    and(
                      eq(inventoryBlocks.inventoryItemId, inventoryItems.id),
                      inArray(inventoryBlocks.status, ['ACTIVE', 'PAYMENT_PROCESSING']),
                      isNull(inventoryBlocks.deletedAt),
                      sql`tstzrange(${inventoryBlocks.blockedStartAt}, ${inventoryBlocks.blockedEndAt}) && tstzrange(${newBlockedStartAt.toISOString()}, ${newBlockedEndAt.toISOString()})`,
                    ),
                  ),
              ),
            ),
          ),
        )
        .orderBy(inventoryItems.id)
        .for('update', { skipLocked: true })
        .limit(addCount);

      if (availableItems.length < addCount) {
        return {
          allocations: [],
          conflict: `Stock insuffisant pour la variante ${variantId}: demandé ${addCount}, disponible ${availableItems.length}.`,
        };
      }

      for (const item of availableItems) {
        allocations.push({
          action: 'ADD',
          amendmentLineId,
          inventoryItemId: item.id,
          sourceBookingBlockId: null,
          datesChanged: false,
        });
      }
    }
  }

  for (const [variantId, currentAllocs] of effectiveAllocsByVariant) {
    const desiredQty = desiredQtyByVariant.get(variantId) ?? 0;
    const retainedCount = Math.min(currentAllocs.length, desiredQty);
    const removeStart = retainedCount;

    let amendmentLineId: string | null = null;
    for (const entry of lineDiff) {
      if (entry.variantId === variantId && entry.action === 'REMOVE') {
        amendmentLineId = entry.logicalLineId;
        break;
      }
    }
    if (!amendmentLineId) {
      for (const entry of lineDiff) {
        if (entry.variantId === variantId) {
          amendmentLineId = entry.logicalLineId;
          break;
        }
      }
    }

    for (let i = removeStart; i < currentAllocs.length; i++) {
      const ea = currentAllocs[i]!;
      const sourceBlockId = await findSourceBlockId(
        sp,
        organizationId,
        bookingId,
        ea,
        expectedClassification,
      );
      allocations.push({
        action: 'REMOVE',
        amendmentLineId: amendmentLineId!,
        inventoryItemId: ea.inventoryItemId,
        sourceBookingBlockId: sourceBlockId,
        datesChanged: false,
      });
    }
  }

  return { allocations, conflict: null };
}

async function findSourceBlockId(
  sp: DatabaseTransaction,
  organizationId: string,
  bookingId: string,
  effectiveAllocation: EffectiveAllocation,
  expectedClassification: AmendmentClassification,
): Promise<string> {
  const bookingItemRows = await sp
    .select({ bookingBlockId: inventoryBlocks.id })
    .from(inventoryBlocks)
    .innerJoin(sql`booking_items`, sql`booking_items.booking_block_id = ${inventoryBlocks.id}`)
    .where(
      and(
        eq(inventoryBlocks.sourceId, bookingId),
        eq(inventoryBlocks.organizationId, organizationId),
        eq(inventoryBlocks.status, 'ACTIVE'),
        eq(sql`booking_items.id`, effectiveAllocation.id),
      ),
    )
    .limit(1);

  if (bookingItemRows.length > 0) {
    return bookingItemRows[0]!.bookingBlockId;
  }

  const amendmentAllocRows = await sp
    .select({ appliedBookingBlockId: bookingAmendmentAllocations.appliedBookingBlockId })
    .from(bookingAmendmentAllocations)
    .where(
      and(
        eq(bookingAmendmentAllocations.id, effectiveAllocation.id),
        eq(bookingAmendmentAllocations.organizationId, organizationId),
        eq(bookingAmendmentAllocations.status, 'CONVERTED'),
      ),
    )
    .limit(1);

  if (amendmentAllocRows.length > 0 && amendmentAllocRows[0]!.appliedBookingBlockId) {
    return amendmentAllocRows[0]!.appliedBookingBlockId!;
  }

  const ErrorClass =
    expectedClassification === 'NEUTRAL' ? NeutralAmendmentError : RefundAmendmentError;
  throw new ErrorClass(
    'INTERNAL',
    `Block source introuvable pour l'allocation ${effectiveAllocation.id}.`,
  );
}
