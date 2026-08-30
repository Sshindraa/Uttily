/**
 * G7M-C1 — création locale durable d'un SUPPLEMENT avant Stripe.
 *
 * La transaction crée l'amendement, les snapshots, les allocations proposées,
 * les holds delta, l'intention de paiement et l'outbox. Aucun provider n'est
 * appelé ici ; C2 consommera ensuite l'état autoritatif.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DatabaseClient, DatabaseTransaction } from '@uttily/database';
import {
  amendmentPaymentAttempts,
  amendmentPayments,
  bookingAmendments,
  bookingAmendmentAllocations,
  bookingAmendmentLines,
  bookingAmendmentSegments,
  bookings,
  inventoryBlocks,
  locations,
  organizationMemberships,
  outboxEvents,
  payments,
} from '@uttily/database';
import {
  BOOKING_AMENDMENT_REQUESTED_AGGREGATE_TYPE,
  BOOKING_AMENDMENT_REQUESTED_EVENT_TYPE,
  BOOKING_AMENDMENT_REQUESTED_EVENT_VERSION,
} from '@uttily/contracts';
import { lockOrganization } from '@uttily/database';
import { reserveKey, lockKey, completeKey, failKey } from '../idempotency/idempotency';
import { AuthorizationError, LOCATION_MANAGERS, requireMembership } from '../identity/permissions';
import { getMembership } from '../identity/memberships';
import type { AuthenticatedUser } from '../identity/types';
import { quoteFlexiblePricing } from '../pricing-plans/quote-flexible-pricing';
import { FlexiblePricingError } from '../pricing-plans/errors';
import {
  localDateTimeStringToUtc,
  localDateTimeToUtc,
  type LocalDateTime,
} from '../pricing-plans/local-to-utc';
import {
  BusinessSignal,
  computeAllocationPlan,
  computeAmendmentFingerprint,
  computeLineDiff,
  isExclusionViolation,
  validateCommand,
} from './execute-booking-amendment-internal';
import { getEffectiveBooking } from './get-effective-booking';
import { subtractHalfOpenSegments } from './delta-segments';
import { calculateMarketplaceFeeDelta } from '../marketplace-fees';
import type { SupplementAmendmentCommand, SupplementAmendmentResult } from './types-amendment';
import { SupplementAmendmentError } from './types-amendment';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPPLEMENT_OPERATION = 'booking-amendment-supplement';

export function buildSupplementProviderIdempotencyKey(
  amendmentPaymentId: string,
  attemptNumber: number,
): string {
  return `pi_amendment_${amendmentPaymentId}_${attemptNumber}`;
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

function buildIntentSnapshot(
  intent: SupplementAmendmentCommand['intent'],
): Record<string, unknown> {
  return intent.kind === 'TIME_RANGE'
    ? { kind: 'TIME_RANGE', startAt: intent.startAt, endAt: intent.endAt }
    : { kind: 'DAY_RANGE', startDate: intent.startDate, endDateExclusive: intent.endDateExclusive };
}

function extractReplayResult(record: { responseBody: unknown }): SupplementAmendmentResult | null {
  const body = record.responseBody;
  if (typeof body !== 'object' || body === null) return null;
  const value = body as Record<string, unknown>;
  const kind = value['kind'];
  if (
    (kind === 'SUCCESS' || kind === 'REPLAY') &&
    typeof value['amendmentId'] === 'string' &&
    typeof value['amendmentNumber'] === 'number' &&
    typeof value['amendmentPaymentId'] === 'string' &&
    typeof value['amendmentPaymentAttemptId'] === 'string' &&
    typeof value['supplementAmountMinor'] === 'number' &&
    typeof value['holdDeadline'] === 'string'
  ) {
    return {
      kind: 'REPLAY',
      amendmentId: value['amendmentId'],
      amendmentNumber: value['amendmentNumber'],
      amendmentPaymentId: value['amendmentPaymentId'],
      amendmentPaymentAttemptId: value['amendmentPaymentAttemptId'],
      supplementAmountMinor: value['supplementAmountMinor'],
      holdDeadline: value['holdDeadline'],
    };
  }
  if (
    kind === 'NOT_FOUND' ||
    kind === 'FORBIDDEN' ||
    kind === 'BOOKING_NOT_CONFIRMED' ||
    kind === 'ACTIVE_AMENDMENT_EXISTS' ||
    kind === 'IDEMPOTENCY_CONFLICT'
  ) {
    return { kind } as SupplementAmendmentResult;
  }
  if (
    kind === 'STALE_EFFECTIVE_BOOKING' &&
    typeof value['expected'] === 'number' &&
    typeof value['actual'] === 'number'
  ) {
    return { kind, expected: value['expected'], actual: value['actual'] };
  }
  if (kind === 'INVALID_INPUT' && typeof value['message'] === 'string') {
    return { kind, message: value['message'] };
  }
  if (kind === 'AVAILABILITY_CONFLICT' && typeof value['message'] === 'string') {
    return { kind, message: value['message'] };
  }
  return null;
}

export async function createSupplementBookingAmendment(
  db: DatabaseClient,
  authenticatedActor: AuthenticatedUser,
  organizationId: string,
  command: SupplementAmendmentCommand,
  options?: { now?: Date },
): Promise<SupplementAmendmentResult> {
  if (!UUID_REGEX.test(authenticatedActor.id)) {
    return { kind: 'FORBIDDEN' };
  }
  if (!UUID_REGEX.test(organizationId)) {
    return { kind: 'INVALID_INPUT', message: 'organizationId invalide (UUID attendu).' };
  }
  const providedNow = options?.now;
  if (
    providedNow !== undefined &&
    (!(providedNow instanceof Date) || !Number.isFinite(providedNow.getTime()))
  ) {
    return { kind: 'INVALID_INPUT', message: 'now doit être une Date finie.' };
  }
  const now = providedNow ?? new Date();
  const nowMilliseconds = now.getTime();
  const holdDeadlineMilliseconds = nowMilliseconds + 10 * 60_000;
  if (
    !Number.isSafeInteger(nowMilliseconds) ||
    !Number.isSafeInteger(holdDeadlineMilliseconds) ||
    new Date(holdDeadlineMilliseconds).getTime() !== holdDeadlineMilliseconds
  ) {
    return { kind: 'INVALID_INPUT', message: 'now ne permet pas de représenter le holdDeadline.' };
  }
  const validationError = validateCommand(command);
  if (validationError) return { kind: 'INVALID_INPUT', message: validationError };

  let membership;
  try {
    membership = await getMembership(db, organizationId, authenticatedActor.id);
    requireMembership(membership, LOCATION_MANAGERS);
  } catch (error) {
    if (error instanceof AuthorizationError) return { kind: 'FORBIDDEN' };
    throw error;
  }

  const fingerprint = computeAmendmentFingerprint(command, 'amendment-supplement-v1');
  const reservation = await reserveKey(db, {
    organizationId,
    operation: SUPPLEMENT_OPERATION,
    key: command.idempotencyKey,
    requestFingerprint: fingerprint,
  });
  if (reservation.kind === 'REPLAY')
    return extractReplayResult(reservation.record) ?? { kind: 'IDEMPOTENCY_CONFLICT' };
  if (reservation.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };

  return db.transaction(async (tx) => {
    await lockOrganization(tx, organizationId);
    const lock = await lockKey(tx, reservation.record.id);
    if (lock.kind === 'REPLAY')
      return extractReplayResult(lock.record) ?? { kind: 'IDEMPOTENCY_CONFLICT' };

    const txMembership = await tx
      .select({ role: organizationMemberships.role, status: organizationMemberships.status })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, organizationId),
          eq(organizationMemberships.userId, authenticatedActor.id),
        ),
      )
      .limit(1);
    if (
      txMembership.length === 0 ||
      txMembership[0]!.status !== 'ACTIVE' ||
      !LOCATION_MANAGERS.includes(txMembership[0]!.role as never)
    ) {
      const result = { kind: 'FORBIDDEN' } as const;
      await failKey(tx, reservation.record.id, { responseStatusCode: 200, responseBody: result });
      return result;
    }

    try {
      const result = await tx.transaction((sp) =>
        persistSupplement(sp, organizationId, authenticatedActor, command, now),
      );
      await completeKey(tx, reservation.record.id, {
        resourceId: result.amendmentId,
        responseStatusCode: 200,
        responseBody: result,
      });
      return result;
    } catch (error) {
      if (error instanceof BusinessSignal) {
        await failKey(tx, reservation.record.id, {
          responseStatusCode: 200,
          responseBody: error.result,
        });
        return error.result as SupplementAmendmentResult;
      }
      if (isExclusionViolation(error, 'no_overlapping_blocks')) {
        const result = {
          kind: 'AVAILABILITY_CONFLICT',
          message: 'Conflit de disponibilité d’inventaire.',
        } as const;
        await failKey(tx, reservation.record.id, { responseStatusCode: 200, responseBody: result });
        return result;
      }
      throw error;
    }
  });
}

async function persistSupplement(
  sp: DatabaseTransaction,
  organizationId: string,
  actor: AuthenticatedUser,
  command: SupplementAmendmentCommand,
  now: Date,
): Promise<Extract<SupplementAmendmentResult, { kind: 'SUCCESS' }>> {
  const bookingRows = await sp
    .select({
      id: bookings.id,
      paymentId: bookings.paymentId,
      customerUserId: bookings.customerUserId,
      status: bookings.status,
      locationId: bookings.locationId,
    })
    .from(bookings)
    .where(and(eq(bookings.id, command.bookingId), eq(bookings.organizationId, organizationId)))
    .for('update')
    .limit(1);
  if (bookingRows.length === 0) throw new BusinessSignal({ kind: 'NOT_FOUND' });
  const booking = bookingRows[0]!;
  if (booking.status !== 'CONFIRMED') throw new BusinessSignal({ kind: 'BOOKING_NOT_CONFIRMED' });

  await sp
    .select({ id: bookingAmendments.id })
    .from(bookingAmendments)
    .where(
      and(
        eq(bookingAmendments.bookingId, command.bookingId),
        eq(bookingAmendments.organizationId, organizationId),
      ),
    )
    .for('update');
  const active = await sp
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
  if (active.length > 0) throw new BusinessSignal({ kind: 'ACTIVE_AMENDMENT_EXISTS' });

  const effectiveResult = await getEffectiveBooking(sp, organizationId, command.bookingId);
  if (effectiveResult.kind === 'NOT_FOUND') throw new BusinessSignal({ kind: 'NOT_FOUND' });
  const effective = effectiveResult.booking;
  if (command.expectedLastAppliedAmendmentNumber !== effective.lastAppliedAmendmentNumber) {
    throw new BusinessSignal({
      kind: 'STALE_EFFECTIVE_BOOKING',
      expected: command.expectedLastAppliedAmendmentNumber,
      actual: effective.lastAppliedAmendmentNumber,
    });
  }

  const locationRows = await sp
    .select({
      prepBufferMinutes: locations.prepBufferMinutes,
      cleanupBufferMinutes: locations.cleanupBufferMinutes,
      timeZone: locations.timeZone,
    })
    .from(locations)
    .where(and(eq(locations.id, booking.locationId), isNull(locations.deletedAt)))
    .limit(1);
  if (locationRows.length === 0)
    throw new SupplementAmendmentError('INTERNAL', 'Location introuvable.');
  const location = locationRows[0]!;
  let quoteResult;
  try {
    quoteResult = await quoteFlexiblePricing(sp, {
      organizationId,
      locationId: booking.locationId,
      locale: 'fr-FR',
      intent: command.intent,
      lines: command.desiredLines.map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity,
      })),
    });
  } catch (error) {
    if (error instanceof FlexiblePricingError)
      throw new BusinessSignal({ kind: 'INVALID_INPUT', message: error.message });
    throw error;
  }

  let customerStartAt: Date;
  let customerEndAt: Date;
  if (command.intent.kind === 'TIME_RANGE') {
    customerStartAt = localDateTimeStringToUtc(command.intent.startAt, location.timeZone);
    customerEndAt = localDateTimeStringToUtc(command.intent.endAt, location.timeZone);
  } else {
    let minStart: Date | null = null;
    let maxEnd: Date | null = null;
    for (const line of quoteResult.lines) {
      if (line.planType !== 'DAILY' || !line.dayRangeBoundaries) continue;
      const first = localDateTimeToUtc(
        parseLocalDateTime(
          line.dayRangeBoundaries.firstDay.localDate,
          line.dayRangeBoundaries.firstDay.startTime,
        ),
        location.timeZone,
      );
      const last = localDateTimeToUtc(
        parseLocalDateTime(
          line.dayRangeBoundaries.lastDay.localDate,
          line.dayRangeBoundaries.lastDay.endTime,
        ),
        location.timeZone,
      );
      if (!minStart || first < minStart) minStart = first;
      if (!maxEnd || last > maxEnd) maxEnd = last;
    }
    if (!minStart || !maxEnd)
      throw new BusinessSignal({
        kind: 'INVALID_INPUT',
        message: 'DAY_RANGE : impossible de dériver les dates client.',
      });
    customerStartAt = minStart;
    customerEndAt = maxEnd;
  }
  const blockedStartAt = new Date(customerStartAt.getTime() - location.prepBufferMinutes * 60_000);
  const blockedEndAt = new Date(customerEndAt.getTime() + location.cleanupBufferMinutes * 60_000);
  const marketplaceFeeDelta = effective.effectiveMarketplaceFeeSnapshot
    ? calculateMarketplaceFeeDelta({
        oldBaseAmountMinor: effective.effectiveMarketplaceFeeSnapshot.marketplaceFeeBaseAmountMinor,
        nextBaseAmountMinor: quoteResult.totalAmountMinor,
        ruleVersion: effective.effectiveMarketplaceFeeSnapshot.ruleVersion,
      })
    : null;
  const before = {
    totalAmountMinor: effective.effectiveTotalAmountMinor,
    currency: 'EUR' as const,
    ...(marketplaceFeeDelta ? { marketplaceFeeSnapshot: marketplaceFeeDelta.old } : {}),
  };
  const after = {
    totalAmountMinor:
      marketplaceFeeDelta?.next.customerTotalAmountMinor ?? quoteResult.totalAmountMinor,
    currency: 'EUR' as const,
    ...(marketplaceFeeDelta ? { marketplaceFeeSnapshot: marketplaceFeeDelta.next } : {}),
  };
  const delta = after.totalAmountMinor - before.totalAmountMinor;
  if (delta <= 0) {
    throw new BusinessSignal({
      kind: 'FINANCIAL_ACTION_REQUIRED',
      classification: delta === 0 ? 'NEUTRAL' : 'REFUND',
      deltaMinor: Math.abs(delta),
    });
  }

  const lineDiff = computeLineDiff(effective.lines, command.desiredLines);
  const quoteLineMap = new Map(quoteResult.lines.map((line) => [line.variantId, line]));
  const variantSnapshots = new Map<string, Record<string, unknown>>();
  for (const line of command.desiredLines) {
    const rows = await sp.execute(sql`
      SELECT pv.id, pv.name AS variant_name, pv.sku_suffix, pv.attributes, p.name AS product_name
      FROM product_variants pv JOIN products p ON p.id = pv.product_id
      WHERE pv.id = ${line.variantId} AND p.organization_id = ${organizationId}
        AND p.publication_status = 'PUBLISHED' AND p.deleted_at IS NULL
        AND pv.is_active = true AND pv.deleted_at IS NULL
      LIMIT 1
    `);
    if (rows.length === 0)
      throw new BusinessSignal({
        kind: 'INVALID_INPUT',
        message: 'Variante introuvable ou inactive.',
      });
    const row = rows[0] as {
      product_name: string;
      variant_name: string;
      sku_suffix: string | null;
      attributes: unknown;
    };
    variantSnapshots.set(line.variantId, {
      productName: row.product_name,
      variantName: row.variant_name,
      skuSuffix: row.sku_suffix,
      attributes: row.attributes ?? {},
    });
  }
  let lineTotal = 0;
  for (const entry of lineDiff) {
    if (entry.action === 'REMOVE') continue;
    const quoteLine = quoteLineMap.get(entry.variantId);
    if (!quoteLine) throw new SupplementAmendmentError('INTERNAL', 'Ligne de devis introuvable.');
    entry.afterUnitPriceAmountMinor = quoteLine.unitPriceAmountMinor;
    entry.afterLineTotalAmountMinor = quoteLine.lineTotalAmountMinor;
    lineTotal += quoteLine.lineTotalAmountMinor;
    if (
      entry.action === 'UNCHANGED' &&
      (entry.beforeUnitPriceAmountMinor !== entry.afterUnitPriceAmountMinor ||
        entry.beforeLineTotalAmountMinor !== entry.afterLineTotalAmountMinor)
    )
      entry.action = 'MODIFY';
  }
  if (lineTotal !== after.totalAmountMinor)
    throw new SupplementAmendmentError(
      'INTERNAL',
      'Incohérence entre les lignes et le total du devis.',
    );

  const plan = await computeAllocationPlan(
    sp,
    organizationId,
    command.bookingId,
    effective.allocations,
    lineDiff,
    customerStartAt,
    customerEndAt,
    blockedStartAt,
    blockedEndAt,
    'SUPPLEMENT',
  );
  if (plan.conflict)
    throw new BusinessSignal({ kind: 'AVAILABILITY_CONFLICT', message: plan.conflict });
  const sourceBlockIds = plan.allocations
    .map((allocation) => allocation.sourceBookingBlockId)
    .filter((id): id is string => id !== null);
  if (sourceBlockIds.length)
    await sp
      .select({ id: inventoryBlocks.id })
      .from(inventoryBlocks)
      .where(inArray(inventoryBlocks.id, sourceBlockIds))
      .orderBy(asc(inventoryBlocks.id))
      .for('update');

  const paymentRows = await sp
    .select()
    .from(payments)
    .where(and(eq(payments.id, booking.paymentId), eq(payments.organizationId, organizationId)))
    .for('update')
    .limit(1);
  if (
    paymentRows.length === 0 ||
    paymentRows[0]!.status !== 'SUCCEEDED' ||
    paymentRows[0]!.currency !== 'EUR'
  )
    throw new BusinessSignal({
      kind: 'INVALID_INPUT',
      message: 'Paiement initial introuvable ou invalide.',
    });
  const sourcePayment = paymentRows[0]!;
  const holdDeadline = new Date(now.getTime() + 10 * 60_000);
  const amendmentNumber = effective.lastAppliedAmendmentNumber + 1;
  const amendment = await sp
    .insert(bookingAmendments)
    .values({
      organizationId,
      bookingId: command.bookingId,
      amendmentNumber,
      type: 'SUPPLEMENT',
      status: 'HOLD_PENDING',
      financialSnapshotBefore: before,
      financialSnapshotAfter: after,
      newCustomerStartAt: customerStartAt,
      newCustomerEndAt: customerEndAt,
      newBlockedStartAt: blockedStartAt,
      newBlockedEndAt: blockedEndAt,
      holdDeadline,
      createdBy: actor.id,
      createdAt: now,
    })
    .returning({ id: bookingAmendments.id });
  const amendmentId = amendment[0]!.id;
  const lineIds = new Map<string, string>();
  const intentSnapshot = buildIntentSnapshot(command.intent);
  for (const entry of lineDiff) {
    const q = quoteLineMap.get(entry.variantId);
    const line = await sp
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
        pricingSnapshot: {
          algorithmVersion: quoteResult.algorithmVersion,
          roundingRuleVersion: quoteResult.roundingRuleVersion,
          resolvedLocale: quoteResult.resolvedLocale,
          intentSnapshot,
          planId: q?.pricingPlanId ?? null,
          planVersion: q?.planVersion ?? null,
          planType: q?.planType ?? null,
          publicLabel: q?.publicLabel ?? null,
          billableUnitCount: q?.billableUnitCount ?? null,
          requestedDurationMinutes: q?.requestedDurationMinutes ?? null,
          billedDurationMinutes: q?.billedDurationMinutes ?? null,
          coveredDurationMinutes: q?.coveredDurationMinutes ?? null,
          billedDays: q?.billedDays ?? null,
          selectedWindow: q?.windowSnapshot ?? null,
          discountThresholdDays: q?.discountThresholdDays ?? null,
          discountPercent: q?.discountPercent ?? null,
          amountBeforeDiscountMinor: q?.amountBeforeDiscountMinor ?? null,
          amountAfterDiscountMinor: q?.amountAfterDiscountMinor ?? null,
        },
        variantSnapshot: variantSnapshots.get(entry.variantId) ?? {},
      })
      .returning({ id: bookingAmendmentLines.id });
    lineIds.set(entry.logicalLineId, line[0]!.id);
  }

  for (const allocation of plan.allocations) {
    allocation.amendmentLineId = lineIds.get(allocation.amendmentLineId)!;
    const inserted = await sp
      .insert(bookingAmendmentAllocations)
      .values({
        amendmentId,
        amendmentLineId: allocation.amendmentLineId,
        organizationId,
        inventoryItemId: allocation.inventoryItemId,
        action: allocation.action,
        sourceBookingBlockId: allocation.sourceBookingBlockId,
        appliedBookingBlockId: null,
        status: 'PROPOSED',
        effectiveCustomerStartAt: customerStartAt,
        effectiveCustomerEndAt: customerEndAt,
        effectiveBlockedStartAt: blockedStartAt,
        effectiveBlockedEndAt: blockedEndAt,
      })
      .returning({ id: bookingAmendmentAllocations.id });
    const allocationId = inserted[0]!.id;
    if (allocation.action === 'REMOVE') continue;
    const ownBlocks = await sp
      .select({ start: inventoryBlocks.blockedStartAt, end: inventoryBlocks.blockedEndAt })
      .from(inventoryBlocks)
      .where(
        and(
          eq(inventoryBlocks.organizationId, organizationId),
          eq(inventoryBlocks.inventoryItemId, allocation.inventoryItemId),
          eq(inventoryBlocks.sourceId, command.bookingId),
          eq(inventoryBlocks.type, 'BOOKING'),
          eq(inventoryBlocks.status, 'ACTIVE'),
          isNull(inventoryBlocks.deletedAt),
        ),
      )
      .orderBy(asc(inventoryBlocks.blockedStartAt), asc(inventoryBlocks.blockedEndAt))
      .for('update');
    const deltaSegments = subtractHalfOpenSegments(
      { start: blockedStartAt, end: blockedEndAt },
      ownBlocks,
    );
    for (const segment of deltaSegments) {
      const hold = await sp
        .insert(inventoryBlocks)
        .values({
          organizationId,
          inventoryItemId: allocation.inventoryItemId,
          type: 'HOLD',
          status: 'ACTIVE',
          customerStartAt: segment.start,
          customerEndAt: segment.end,
          blockedStartAt: segment.start,
          blockedEndAt: segment.end,
          expiresAt: holdDeadline,
          sourceId: amendmentId,
        })
        .returning({ id: inventoryBlocks.id });
      await sp.insert(bookingAmendmentSegments).values({
        allocationId,
        organizationId,
        inventoryItemId: allocation.inventoryItemId,
        holdBlockId: hold[0]!.id,
        deltaStartAt: segment.start,
        deltaEndAt: segment.end,
        status: 'PROPOSED',
      });
    }
  }

  const amendmentPayment = await sp
    .insert(amendmentPayments)
    .values({
      organizationId,
      bookingId: command.bookingId,
      amendmentId,
      customerUserId: booking.customerUserId,
      amountMinor: delta,
      marketplaceFeeDeltaSnapshot: marketplaceFeeDelta,
      currency: sourcePayment.currency,
      environment: sourcePayment.environment,
      connectedAccountId: sourcePayment.connectedAccountId,
      onBehalfOfAccountId: sourcePayment.onBehalfOfAccountId,
      chargeModel: sourcePayment.chargeModel,
      settlementMerchantMode: sourcePayment.settlementMerchantMode,
      status: 'PENDING_PROVIDER',
    })
    .returning({ id: amendmentPayments.id });
  const amendmentPaymentId = amendmentPayment[0]!.id;
  const attempt = await sp
    .insert(amendmentPaymentAttempts)
    .values({
      organizationId,
      amendmentPaymentId,
      attemptNumber: 1,
      status: 'PENDING_PROVIDER',
      providerIdempotencyKey: buildSupplementProviderIdempotencyKey(amendmentPaymentId, 1),
    })
    .returning({ id: amendmentPaymentAttempts.id });
  const result: SupplementAmendmentResult = {
    kind: 'SUCCESS',
    amendmentId,
    amendmentNumber,
    amendmentPaymentId,
    amendmentPaymentAttemptId: attempt[0]!.id,
    supplementAmountMinor: delta,
    holdDeadline: holdDeadline.toISOString(),
  };
  await sp.insert(outboxEvents).values({
    organizationId,
    aggregateType: BOOKING_AMENDMENT_REQUESTED_AGGREGATE_TYPE,
    aggregateId: command.bookingId,
    eventType: BOOKING_AMENDMENT_REQUESTED_EVENT_TYPE,
    eventVersion: BOOKING_AMENDMENT_REQUESTED_EVENT_VERSION,
    payload: { organizationId, bookingId: command.bookingId, amendmentId },
    status: 'PENDING',
    attemptCount: 0,
    availableAt: now,
    idempotencyKey: `booking_amendment_requested_${amendmentId}`,
  });
  return result;
}
