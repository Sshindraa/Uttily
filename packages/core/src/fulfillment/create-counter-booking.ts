import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DatabaseClient, DatabaseTransaction } from '@uttily/database';
import {
  allocations,
  auditLog,
  bookingDraftLines,
  bookingDrafts,
  bookingItems,
  bookingLines,
  bookings,
  inventoryBlocks,
  inventoryItems,
  locations,
  organizations,
  outboxEvents,
  payments,
  products,
  productVariants,
  users,
} from '@uttily/database';
import { requireMembership } from '../identity/permissions';
import { FULFILLMENT_OPERATORS } from './operators';
import { getMembership } from '../identity/memberships';
import type { AuthenticatedUser } from '../identity/types';
import { CatalogError } from '../catalog/errors';
import { quoteFlexiblePricing } from '../pricing-plans/quote-flexible-pricing';
import { toLocalParts } from '../pricing-plans/time-utils';
import { calculateMarketplaceFeeSnapshotFromPricing } from '../marketplace-fees';
import { calculateBillableCivilDays } from '../pricing/civil-days';
import type { QuoteFlexiblePricingResult } from '../pricing-plans/types';

function safeMult(a: number, b: number): number {
  const res = a * b;
  if (!Number.isSafeInteger(res)) throw new Error('Dépassement de calcul');
  return res;
}

export interface CreateCounterBookingInput {
  organizationId: string;
  locationId: string;
  operator: AuthenticatedUser;
  channel: 'WALK_IN' | 'PHONE';
  customer: {
    fullName: string;
    email: string;
    phone?: string | undefined;
  };
  startAt: Date;
  endAt: Date;
  items: Array<{
    inventoryItemId: string;
  }>;
  payment: {
    method:
      'ON_SITE_CARD' | 'ON_SITE_CASH' | 'ON_SITE_CHECK' | 'ON_SITE_HOLIDAY_VOUCHER' | 'PAY_LATER';
    amountMinor?: number | undefined;
    reference?: string | undefined;
  };
  notes?: string | undefined;
  idempotencyKey: string;
}

export interface CreateCounterBookingResult {
  bookingId: string;
  bookingReference: string;
  totalAmountMinor: number;
  status: string;
  alreadyExisted?: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatLocalIso(d: Date, tz: string): string {
  const p = toLocalParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

export async function createCounterBooking(
  db: DatabaseClient,
  input: CreateCounterBookingInput,
): Promise<CreateCounterBookingResult> {
  // 1. Autorisation de l'opérateur
  const membership = await getMembership(db, input.organizationId, input.operator.id);
  requireMembership(membership, FULFILLMENT_OPERATORS);

  if (input.items.length === 0) {
    throw new CatalogError('VALIDATION', 'Veuillez sélectionner au moins un équipement.');
  }

  if (input.endAt <= input.startAt) {
    throw new CatalogError(
      'VALIDATION',
      'La date de fin doit être postérieure à la date de début.',
    );
  }

  const normalizedEmail = input.customer.email.trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw new CatalogError('VALIDATION', 'Veuillez fournir une adresse email client valide.');
  }

  const customerName = input.customer.fullName.trim();
  if (customerName.length < 2) {
    throw new CatalogError('VALIDATION', 'Le nom du client doit comporter au moins 2 caractères.');
  }

  return await db.transaction(async (tx: DatabaseTransaction) => {
    // 2. Vérification idempotence via auditLog
    const existingAudit = await tx
      .select({
        targetId: auditLog.targetId,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'BOOKING_CREATED_AT_COUNTER'),
          sql`${auditLog.metadata}->>'idempotencyKey' = ${input.idempotencyKey}`,
        ),
      )
      .limit(1);

    if (existingAudit.length > 0 && existingAudit[0]?.targetId) {
      const [existingBooking] = await tx
        .select({
          id: bookings.id,
          totalAmountMinor: bookings.totalAmountMinor,
          status: bookings.status,
        })
        .from(bookings)
        .where(eq(bookings.id, existingAudit[0].targetId))
        .limit(1);

      if (existingBooking) {
        return {
          bookingId: existingBooking.id,
          bookingReference: `#UT-${existingBooking.id.slice(0, 6).toUpperCase()}`,
          totalAmountMinor: existingBooking.totalAmountMinor,
          status: existingBooking.status,
          alreadyExisted: true,
        };
      }
    }

    // 3. Charger et vérifier l'établissement et ses marges de préparation
    const [location] = await tx
      .select({
        id: locations.id,
        organizationId: locations.organizationId,
        timeZone: locations.timeZone,
        prepBufferMinutes: locations.prepBufferMinutes,
        cleanupBufferMinutes: locations.cleanupBufferMinutes,
      })
      .from(locations)
      .where(
        and(
          eq(locations.id, input.locationId),
          eq(locations.organizationId, input.organizationId),
          isNull(locations.deletedAt),
        ),
      )
      .limit(1);

    if (!location) {
      throw new CatalogError('NOT_FOUND', 'Établissement introuvable ou inaccessible.');
    }

    const prepMs = (location.prepBufferMinutes ?? 30) * 60_000;
    const cleanupMs = (location.cleanupBufferMinutes ?? 30) * 60_000;
    const blockedStartAt = new Date(input.startAt.getTime() - prepMs);
    const blockedEndAt = new Date(input.endAt.getTime() + cleanupMs);

    // 4. Verrouillage déterministe des exemplaires (tri par UUID pour éviter les deadlocks)
    const sortedItemIds = [...new Set(input.items.map((i) => i.inventoryItemId))].sort();

    const lockedItems = await tx
      .select({
        id: inventoryItems.id,
        organizationId: inventoryItems.organizationId,
        currentLocationId: inventoryItems.currentLocationId,
        status: inventoryItems.status,
        condition: inventoryItems.condition,
        internalSku: inventoryItems.internalSku,
        variantId: inventoryItems.productVariantId,
      })
      .from(inventoryItems)
      .where(inArray(inventoryItems.id, sortedItemIds))
      .orderBy(asc(inventoryItems.id))
      .for('update');

    if (lockedItems.length !== sortedItemIds.length) {
      throw new CatalogError(
        'NOT_FOUND',
        'Un ou plusieurs équipements sélectionnés sont introuvables.',
      );
    }

    for (const item of lockedItems) {
      if (
        item.organizationId !== input.organizationId ||
        item.currentLocationId !== input.locationId
      ) {
        throw new CatalogError(
          'FORBIDDEN',
          `L'équipement ${item.internalSku} n'appartient pas à cet établissement.`,
        );
      }
      if (item.status !== 'ACTIVE') {
        throw new CatalogError(
          'VALIDATION',
          `L'équipement ${item.internalSku} n'est pas actif (${item.status}).`,
        );
      }
      if (item.condition === 'POOR' || item.condition === 'BROKEN') {
        throw new CatalogError(
          'VALIDATION',
          `L'équipement ${item.internalSku} est en état ${item.condition} et ne peut pas être loué.`,
        );
      }
    }

    // 5. Garde anti-surbooking transactionnelle
    const conflictingBlocks = await tx
      .select({
        inventoryItemId: inventoryBlocks.inventoryItemId,
      })
      .from(inventoryBlocks)
      .where(
        and(
          inArray(inventoryBlocks.inventoryItemId, sortedItemIds),
          inArray(inventoryBlocks.status, ['ACTIVE', 'PAYMENT_PROCESSING']),
          sql`tstzrange(${inventoryBlocks.blockedStartAt}, ${inventoryBlocks.blockedEndAt}) && tstzrange(${blockedStartAt.toISOString()}::timestamptz, ${blockedEndAt.toISOString()}::timestamptz)`,
        ),
      );

    if (conflictingBlocks.length > 0) {
      const conflictedId = conflictingBlocks[0]?.inventoryItemId;
      const conflictedSku =
        lockedItems.find((i) => i.id === conflictedId)?.internalSku ?? conflictedId;
      throw new CatalogError(
        'CONFLICT_BLOCK',
        `L'équipement ${conflictedSku} est indisponible sur ce créneau (réservé ou bloqué).`,
      );
    }

    // 6. Résolution ou création du compte client comptoir
    let customerUserId: string;
    const [existingUser] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

    if (existingUser) {
      customerUserId = existingUser.id;
    } else {
      const [newUser] = await tx
        .insert(users)
        .values({
          email: normalizedEmail,
          displayName: customerName,
          locale: 'fr',
          oidcProvider: 'counter',
          oidcSubject: `counter-${randomUUID()}`,
        })
        .returning({ id: users.id });
      if (!newUser) throw new Error('Échec de la création du client comptoir.');
      customerUserId = newUser.id;
    }

    // 7. Calcul du tarif pour les variantes sélectionnées
    const variantCounts = new Map<string, number>();
    for (const item of lockedItems) {
      variantCounts.set(item.variantId, (variantCounts.get(item.variantId) ?? 0) + 1);
    }

    const variantIds = Array.from(variantCounts.keys());
    const variantRows = await tx
      .select({
        variant: productVariants,
        product: products,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, variantIds));

    const variantDataMap = new Map(variantRows.map((r) => [r.variant.id, r]));

    // Essayer quoteFlexiblePricing
    const localStartStr = formatLocalIso(input.startAt, location.timeZone);
    const localEndStr = formatLocalIso(input.endAt, location.timeZone);

    let isFlexible = true;
    let quoteResult: QuoteFlexiblePricingResult | null = null;
    try {
      quoteResult = await quoteFlexiblePricing(tx as unknown as DatabaseClient, {
        organizationId: input.organizationId,
        locationId: input.locationId,
        locale: 'fr',
        intent: {
          kind: 'TIME_RANGE',
          startAt: localStartStr,
          endAt: localEndStr,
        },
        lines: variantIds.map((vId) => ({
          variantId: vId,
          quantity: variantCounts.get(vId) ?? 1,
        })),
      });
    } catch {
      isFlexible = false;
    }

    let subtotalAmountMinor = 0;
    let totalAmountMinor = 0;
    let billableUnit = 'DAY';
    let billableUnitCount = 1;

    if (isFlexible && quoteResult) {
      subtotalAmountMinor = quoteResult.subtotalAmountMinor;
      totalAmountMinor = quoteResult.totalAmountMinor;
      billableUnit = 'MINUTE';
      billableUnitCount = Math.max(
        1,
        Math.round((input.endAt.getTime() - input.startAt.getTime()) / 60_000),
      );
    } else {
      // Fallback legacy daily
      const civilDays = calculateBillableCivilDays(input.startAt, input.endAt, location.timeZone);
      billableUnit = 'DAY';
      billableUnitCount = civilDays;
      for (const [vId, qty] of variantCounts.entries()) {
        const vData = variantDataMap.get(vId);
        const dailyPrice = vData?.variant.dailyPriceAmountMinor ?? 5000;
        const lineTotal = safeMult(safeMult(dailyPrice, civilDays), qty);
        subtotalAmountMinor += lineTotal;
      }
      totalAmountMinor = subtotalAmountMinor;
    }

    const marketplaceFeeSnapshot = calculateMarketplaceFeeSnapshotFromPricing({
      subtotalAmountMinor,
      mandatoryFeesAmountMinor: 0,
    });
    const commissionAmountMinor = marketplaceFeeSnapshot.merchantFeeAmountMinor;
    const customerTotalAmountMinor = marketplaceFeeSnapshot.customerTotalAmountMinor;

    const [org] = await tx
      .select({
        defaultCancellationPolicyCode: organizations.defaultCancellationPolicyCode,
      })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .limit(1);

    const cancellationPolicySnapshot = {
      code: org?.defaultCancellationPolicyCode ?? 'FLEXIBLE',
      version: 'v1',
      source: 'ORGANIZATION_DEFAULT',
    };

    const termsAcceptanceSnapshot = {
      channel: input.channel,
      termsVersion: 'v1',
      counterOperatorId: input.operator.id,
      paymentMethod: input.payment.method,
      paymentReference: input.payment.reference ?? null,
      acceptedAt: new Date().toISOString(),
    };

    const expiresAt = new Date(Date.now() + 3600_000);

    // 8. Création de booking_drafts (status HELD)
    const [draft] = await tx
      .insert(bookingDrafts)
      .values({
        organizationId: input.organizationId,
        locationId: input.locationId,
        customerUserId,
        status: 'HELD',
        expiresAt,
        customerStartAt: input.startAt,
        customerEndAt: input.endAt,
        blockedStartAt,
        blockedEndAt,
        timezone: location.timeZone,
        prepBufferMinutes: location.prepBufferMinutes ?? 30,
        cleanupBufferMinutes: location.cleanupBufferMinutes ?? 30,
        currency: 'EUR',
        subtotalAmountMinor,
        mandatoryFeesAmountMinor: 0,
        totalAmountMinor,
        customerTotalAmountMinor,
        commissionAmountMinor,
        billableUnit,
        billableUnitCount,
        cancellationPolicySnapshot,
        marketplaceFeeSnapshot,
        pricingSnapshotVersion: isFlexible ? 'flexible-pricing-v1' : 'legacy-daily-v1',
        pricingAlgorithmVersion: isFlexible ? 'flexible-pricing-v1' : null,
        pricingRoundingRuleVersion: isFlexible ? 'half-up-v1' : null,
        pricingIntentType: isFlexible ? 'TIME_RANGE' : null,
        pricingIntentSnapshot: isFlexible
          ? { kind: 'TIME_RANGE', startAt: localStartStr, endAt: localEndStr }
          : null,
        pricingResolvedLocale: isFlexible ? 'fr' : null,
      })
      .returning();

    if (!draft) throw new Error('Échec de création du draft de réservation.');

    // 9. Création des blocs HOLD actifs
    const holdBlockMap = new Map<string, string>();
    for (const item of lockedItems) {
      const [holdBlock] = await tx
        .insert(inventoryBlocks)
        .values({
          organizationId: input.organizationId,
          inventoryItemId: item.id,
          type: 'HOLD',
          status: 'ACTIVE',
          expiresAt,
          customerStartAt: input.startAt,
          customerEndAt: input.endAt,
          blockedStartAt,
          blockedEndAt,
          sourceId: draft.id,
          createdBy: input.operator.id,
        })
        .returning();

      if (!holdBlock) throw new Error('Échec de création du bloc hold.');
      holdBlockMap.set(item.id, holdBlock.id);
    }

    // 10. Création des bookingDraftLines et allocations
    const draftLineMap = new Map<string, string>();
    for (const [vId, qty] of variantCounts.entries()) {
      const vData = variantDataMap.get(vId);
      const unitPrice =
        isFlexible && quoteResult
          ? Math.round(
              (quoteResult.lines.find((l) => l.variantId === vId)?.lineTotalAmountMinor ?? 0) / qty,
            )
          : (vData?.variant.dailyPriceAmountMinor ?? 5000);
      const lineTotal = unitPrice * qty;

      const [draftLine] = await tx
        .insert(bookingDraftLines)
        .values({
          draftId: draft.id,
          variantId: vId,
          quantity: qty,
          unitPriceAmountMinor: unitPrice,
          billableUnitCount,
          lineTotalAmountMinor: lineTotal,
          currency: 'EUR',
          variantSnapshot: {
            variantId: vId,
            productId: vData?.product.id,
            productName: vData?.product.name,
            skuSuffix: vData?.variant.skuSuffix ?? null,
            attributes: vData?.variant.attributes,
          },
        })
        .returning();

      if (!draftLine) throw new Error('Échec de création de la ligne draft.');
      draftLineMap.set(vId, draftLine.id);
    }

    const allocationIds: string[] = [];
    for (const item of lockedItems) {
      const dLineId = draftLineMap.get(item.variantId);
      const holdBlockId = holdBlockMap.get(item.id);
      if (dLineId && holdBlockId) {
        const [alloc] = await tx
          .insert(allocations)
          .values({
            draftLineId: dLineId,
            inventoryBlockId: holdBlockId,
            status: 'ALLOCATED',
          })
          .returning();
        if (alloc) allocationIds.push(alloc.id);
      }
    }

    // 11. Création de payments
    const isPaidOnSite = input.payment.method !== 'PAY_LATER';
    const [payment] = await tx
      .insert(payments)
      .values({
        organizationId: input.organizationId,
        draftId: draft.id,
        customerUserId,
        status: isPaidOnSite ? 'SUCCEEDED' : 'REQUIRES_PAYMENT_METHOD',
        amountMinor: customerTotalAmountMinor,
        currency: 'EUR',
        taxStatus: 'NOT_APPLICABLE',
        taxAmountMinor: 0,
        commissionAmountMinor,
        marketplaceFeeSnapshot,
        financialTermsVersion: 'v1',
        legalTermsVersion: 'v1',
        termsAcceptanceSnapshot,
        connectedAccountId: `counter-${input.organizationId}`,
        chargeModel: 'DESTINATION',
        settlementMerchantMode: 'PLATFORM',
        environment: 'TEST',
        succeededAt: isPaidOnSite ? new Date() : null,
      })
      .returning();

    if (!payment) throw new Error('Échec de création du paiement.');

    // 12. Création de bookings
    const [booking] = await tx
      .insert(bookings)
      .values({
        organizationId: input.organizationId,
        locationId: input.locationId,
        customerUserId,
        draftId: draft.id,
        paymentId: payment.id,
        status: 'CONFIRMED',
        customerStartAt: input.startAt,
        customerEndAt: input.endAt,
        blockedStartAt,
        blockedEndAt,
        timezone: location.timeZone,
        prepBufferMinutes: location.prepBufferMinutes ?? 30,
        cleanupBufferMinutes: location.cleanupBufferMinutes ?? 30,
        currency: 'EUR',
        subtotalAmountMinor,
        mandatoryFeesAmountMinor: 0,
        taxStatus: 'NOT_APPLICABLE',
        taxAmountMinor: 0,
        commissionAmountMinor,
        totalAmountMinor,
        customerTotalAmountMinor,
        marketplaceFeeSnapshot,
        billableUnit,
        billableUnitCount,
        cancellationPolicySnapshot,
        termsAcceptanceSnapshot,
        confirmedAt: new Date(),
        pricingSnapshotVersion: isFlexible ? 'flexible-pricing-v1' : 'legacy-daily-v1',
        pricingAlgorithmVersion: isFlexible ? 'flexible-pricing-v1' : null,
        pricingRoundingRuleVersion: isFlexible ? 'half-up-v1' : null,
        pricingIntentType: isFlexible ? 'TIME_RANGE' : null,
        pricingIntentSnapshot: isFlexible
          ? { kind: 'TIME_RANGE', startAt: localStartStr, endAt: localEndStr }
          : null,
        pricingResolvedLocale: isFlexible ? 'fr' : null,
      })
      .returning();

    if (!booking) throw new Error('Échec de création de la réservation.');

    // 13. Création de booking_lines et booking_items, conversion des holds vers BOOKING/ACTIVE
    for (const [vId, qty] of variantCounts.entries()) {
      const vData = variantDataMap.get(vId);
      const dLineId = draftLineMap.get(vId);
      const unitPrice =
        isFlexible && quoteResult
          ? Math.round(
              (quoteResult.lines.find((l) => l.variantId === vId)?.lineTotalAmountMinor ?? 0) / qty,
            )
          : (vData?.variant.dailyPriceAmountMinor ?? 5000);
      const lineTotal = unitPrice * qty;

      const [bLine] = await tx
        .insert(bookingLines)
        .values({
          bookingId: booking.id,
          variantId: vId,
          quantity: qty,
          unitPriceAmountMinor: unitPrice,
          billableUnitCount,
          lineTotalAmountMinor: lineTotal,
          currency: 'EUR',
          variantSnapshot: {
            variantId: vId,
            productId: vData?.product.id,
            productName: vData?.product.name,
            skuSuffix: vData?.variant.skuSuffix ?? null,
            attributes: vData?.variant.attributes,
          },
          sourceDraftLineId: isFlexible ? (dLineId ?? null) : null,
        })
        .returning();

      if (!bLine) throw new Error('Échec de création de la ligne de réservation.');

      const itemsForVariant = lockedItems.filter((i) => i.variantId === vId);
      for (const item of itemsForVariant) {
        const holdBlockId = holdBlockMap.get(item.id);
        if (holdBlockId) {
          // Convertir le bloc hold
          await tx
            .update(inventoryBlocks)
            .set({ status: 'CONVERTED' })
            .where(eq(inventoryBlocks.id, holdBlockId));

          // Créer le bloc BOOKING actif
          const [bookingBlock] = await tx
            .insert(inventoryBlocks)
            .values({
              organizationId: input.organizationId,
              inventoryItemId: item.id,
              type: 'BOOKING',
              status: 'ACTIVE',
              customerStartAt: input.startAt,
              customerEndAt: input.endAt,
              blockedStartAt,
              blockedEndAt,
              sourceId: booking.id,
              createdBy: input.operator.id,
            })
            .returning();

          if (!bookingBlock) throw new Error('Échec de création du bloc booking.');

          await tx.insert(bookingItems).values({
            bookingId: booking.id,
            bookingLineId: bLine.id,
            inventoryItemId: item.id,
            sourceHoldBlockId: holdBlockId,
            bookingBlockId: bookingBlock.id,
          });
        }
      }
    }

    // 14. Convertir les allocations et le brouillon
    if (allocationIds.length > 0) {
      await tx
        .update(allocations)
        .set({ status: 'CONVERTED' })
        .where(inArray(allocations.id, allocationIds));
    }

    await tx
      .update(bookingDrafts)
      .set({ status: 'CONVERTED' })
      .where(eq(bookingDrafts.id, draft.id));

    // 13. Insertion audit_log et outbox_events
    const skus = lockedItems.map((i) => i.internalSku);
    await tx.insert(auditLog).values({
      actorUserId: null,
      action: 'BOOKING_CREATED_AT_COUNTER',
      targetType: 'BOOKING',
      targetId: booking.id,
      metadata: {
        operatorId: input.operator.id,
        channel: input.channel,
        paymentMethod: input.payment.method,
        customerEmail: normalizedEmail,
        customerName,
        customerPhone: input.customer.phone ?? null,
        itemCount: lockedItems.length,
        skus,
        idempotencyKey: input.idempotencyKey,
        notes: input.notes ?? null,
      },
    });

    await tx.insert(outboxEvents).values({
      organizationId: input.organizationId,
      aggregateType: 'BOOKING',
      aggregateId: booking.id,
      eventType: 'BOOKING_CONFIRMED.v1',
      eventVersion: 'v1',
      payload: {
        bookingId: booking.id,
        channel: input.channel,
        customerUserId,
        totalAmountMinor,
        currency: 'EUR',
      },
      idempotencyKey: `counter-booking-confirmed-${input.idempotencyKey}`,
      availableAt: new Date(),
    });

    return {
      bookingId: booking.id,
      bookingReference: `#UT-${booking.id.slice(0, 6).toUpperCase()}`,
      totalAmountMinor: booking.totalAmountMinor,
      status: booking.status,
    };
  });
}
