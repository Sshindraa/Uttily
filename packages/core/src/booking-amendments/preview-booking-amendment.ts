/**
 * @uttily/core — Prévisualisation canonique de modification de réservation (G7M-C5-A).
 *
 * ADR-023 §6 & G7M-C5-A : calcul déterministe et strictement read-only d'un devis
 * de modification avant soumission :
 * - validation des entrées et autorisations ;
 * - vérification de l'état effectif et absence d'amendement actif ;
 * - diff des lignes existantes/souhaitées ;
 * - calcul de la nouvelle tarification et des dates effectives cibles ;
 * - classification (NEUTRAL, REFUND, SUPPLEMENT) et commission estimée ;
 * - vérification indicative de la disponibilité physique sans pose de verrous ni de holds ;
 * - fail-closed strict : aucun fallback inventé, aucune erreur masquée.
 */

import { and, eq, inArray, isNull, not, exists, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  bookings,
  bookingAmendments,
  inventoryBlocks,
  inventoryItems,
  locations,
  productVariants,
  products,
} from '@uttily/database';
import { requireMembership, AuthorizationError, LOCATION_MANAGERS } from '../identity/permissions';
import { getMembership } from '../identity/memberships';
import type { AuthenticatedUser } from '../identity/types';
import { quoteFlexiblePricing } from '../pricing-plans/quote-flexible-pricing';
import { FlexiblePricingError } from '../pricing-plans/errors';
import {
  localDateTimeStringToUtc,
  localDateTimeToUtc,
  type LocalDateTime,
} from '../pricing-plans/local-to-utc';
import { getEffectiveBooking } from './get-effective-booking';
import { calculateSupplementCommission } from './supplement-commission';
import {
  BusinessSignal,
  classifyDelta,
  computeLineDiff,
  findSourceBlockId,
  validateCommandPayload,
  type LineDiffEntry,
} from './execute-booking-amendment-internal';
import type { EffectiveAllocation, EffectiveBooking } from './types';
import type {
  PreviewBookingAmendmentCommand,
  PreviewBookingAmendmentResult,
  PreviewLineDiffEntry,
} from './types-amendment';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function checkPreviewAvailability(
  db: DatabaseClient,
  organizationId: string,
  bookingId: string,
  effectiveBooking: EffectiveBooking,
  lineDiff: readonly LineDiffEntry[],
  newCustomerStartAt: Date,
  newCustomerEndAt: Date,
  newBlockedStartAt: Date,
  newBlockedEndAt: Date,
): Promise<string | null> {
  const effectiveAllocsByVariant = new Map<string, EffectiveAllocation[]>();
  for (const line of effectiveBooking.lines) {
    const allocs = effectiveBooking.allocations.filter(
      (a) => a.logicalLineId === line.logicalLineId,
    );
    effectiveAllocsByVariant.set(line.variantId, allocs);
  }

  const desiredQtyByVariant = new Map<string, number>();
  for (const entry of lineDiff) {
    if (entry.action !== 'REMOVE') {
      desiredQtyByVariant.set(entry.variantId, entry.afterQuantity);
    }
  }

  for (const [variantId, desiredQty] of desiredQtyByVariant) {
    const currentAllocs = effectiveAllocsByVariant.get(variantId) ?? [];
    const retainedCount = Math.min(currentAllocs.length, desiredQty);

    for (let i = 0; i < retainedCount; i++) {
      const ea = currentAllocs[i]!;
      const datesChanged =
        ea.effectiveCustomerStartAt.getTime() !== newCustomerStartAt.getTime() ||
        ea.effectiveCustomerEndAt.getTime() !== newCustomerEndAt.getTime();

      if (datesChanged) {
        // FAIL-CLOSED : findSourceBlockId DOIT réussir pour une allocation retenue
        const sourceBlockId = await findSourceBlockId(db, organizationId, bookingId, ea, 'NEUTRAL');

        const conflictingBlocks = await db
          .select({ id: inventoryBlocks.id })
          .from(inventoryBlocks)
          .where(
            and(
              eq(inventoryBlocks.organizationId, organizationId),
              eq(inventoryBlocks.inventoryItemId, ea.inventoryItemId),
              inArray(inventoryBlocks.status, ['ACTIVE', 'PAYMENT_PROCESSING']),
              isNull(inventoryBlocks.deletedAt),
              not(eq(inventoryBlocks.id, sourceBlockId)),
              sql`tstzrange(${inventoryBlocks.blockedStartAt}, ${inventoryBlocks.blockedEndAt}) && tstzrange(${newBlockedStartAt.toISOString()}, ${newBlockedEndAt.toISOString()})`,
            ),
          )
          .limit(1);

        if (conflictingBlocks.length > 0) {
          return "Conflit de disponibilité d'inventaire.";
        }
      }
    }

    const addCount = desiredQty - retainedCount;
    if (addCount > 0) {
      const availableItems = await db
        .select({ id: inventoryItems.id })
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
                db
                  .select({ one: inventoryBlocks.id })
                  .from(inventoryBlocks)
                  .where(
                    and(
                      eq(inventoryBlocks.organizationId, organizationId),
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
        .limit(addCount);

      if (availableItems.length < addCount) {
        return 'Stock insuffisant pour satisfaire la quantité demandée.';
      }
    }
  }

  return null;
}

/**
 * Prévisualise une modification de réservation de manière déterministe et read-only.
 *
 * @param db Exécuteur DB read-only (DatabaseClient).
 * @param authenticatedActor Utilisateur authentifié initiateur.
 * @param organizationId Organisation propriétaire (tenant).
 * @param command Données de la modification souhaitée.
 * @returns Résultat de prévisualisation (SUCCESS avec détails ou échec typé).
 */
export async function previewBookingAmendment(
  db: DatabaseClient,
  authenticatedActor: AuthenticatedUser,
  organizationId: string,
  command: PreviewBookingAmendmentCommand,
): Promise<PreviewBookingAmendmentResult> {
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

  const validationError = validateCommandPayload(
    command.bookingId,
    command.expectedLastAppliedAmendmentNumber,
    command.intent,
    command.desiredLines,
  );
  if (validationError !== null) {
    return { kind: 'INVALID_INPUT', message: validationError };
  }

  // 1. Vérification d'autorisation (OWNER / ADMIN / MANAGER requis)
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

  // 2. Charger la réservation effective
  const effectiveResult = await getEffectiveBooking(db, organizationId, command.bookingId);
  if (effectiveResult.kind === 'NOT_FOUND') {
    return { kind: 'NOT_FOUND' };
  }
  const effectiveBooking = effectiveResult.booking;

  // 3. Vérifier le statut de réservation (CONFIRMED uniquement)
  if (effectiveBooking.booking.status !== 'CONFIRMED') {
    return { kind: 'BOOKING_NOT_CONFIRMED' };
  }

  // 4. Vérifier l'absence d'amendement actif (HOLD_PENDING ou READY_TO_APPLY)
  const activeAmendments = await db
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
    return { kind: 'ACTIVE_AMENDMENT_EXISTS' };
  }

  // 5. Optimistic locking
  const actual = effectiveBooking.lastAppliedAmendmentNumber;
  if (command.expectedLastAppliedAmendmentNumber !== actual) {
    return {
      kind: 'STALE_EFFECTIVE_BOOKING',
      expected: command.expectedLastAppliedAmendmentNumber,
      actual,
    };
  }

  // 6. Charger la location
  const locRows = await db
    .select({
      prepBufferMinutes: locations.prepBufferMinutes,
      cleanupBufferMinutes: locations.cleanupBufferMinutes,
      timeZone: locations.timeZone,
    })
    .from(locations)
    .where(and(eq(locations.id, effectiveBooking.booking.locationId), isNull(locations.deletedAt)))
    .limit(1);

  if (locRows.length === 0) {
    return {
      kind: 'INVALID_INPUT',
      message: 'Lieu de la réservation introuvable.',
    };
  }
  const loc = locRows[0]!;
  const timeZone = loc.timeZone;

  // 7. Valider les variantes et récupérer leurs noms (fail-closed strict, aucun fallback)
  const allVariantIds = [
    ...new Set([
      ...command.desiredLines.map((l) => l.variantId),
      ...effectiveBooking.lines.map((l) => l.variantId),
    ]),
  ];

  const variantDataMap = new Map<
    string,
    {
      productName: string;
      variantName: string;
    }
  >();

  for (const variantId of allVariantIds) {
    const variantData = await db
      .select({ variant: productVariants, product: products })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(and(eq(productVariants.id, variantId), eq(products.organizationId, organizationId)))
      .limit(1);

    if (variantData.length === 0) {
      return {
        kind: 'INVALID_INPUT',
        message: "Variante introuvable dans l'organisation.",
      };
    }

    const { variant, product } = variantData[0]!;
    const isDesired = command.desiredLines.some((l) => l.variantId === variantId);

    if (isDesired) {
      if (product.publicationStatus !== 'PUBLISHED' || product.deletedAt !== null) {
        return {
          kind: 'INVALID_INPUT',
          message: `Produit ${product.name} non valide.`,
        };
      }
      if (!variant.isActive || variant.deletedAt !== null) {
        return {
          kind: 'INVALID_INPUT',
          message: `Variante ${variant.name} inactive ou supprimée.`,
        };
      }
    }

    variantDataMap.set(variantId, {
      productName: product.name,
      variantName: variant.name,
    });
  }

  // 8. Calcul de la tarification flexible
  let quoteResult;
  try {
    quoteResult = await quoteFlexiblePricing(db, {
      organizationId,
      locationId: effectiveBooking.booking.locationId,
      locale: 'fr-FR',
      intent: command.intent,
      lines: command.desiredLines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    });
  } catch (err) {
    if (err instanceof FlexiblePricingError) {
      return {
        kind: 'INVALID_INPUT',
        message: err.message,
      };
    }
    throw err;
  }

  // 9. Calcul des dates client et buffers en UTC
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
      return {
        kind: 'INVALID_INPUT',
        message: 'DAY_RANGE : impossible de dériver les dates client.',
      };
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

  // 10. Calcul du diff de lignes
  let lineDiff: LineDiffEntry[];
  try {
    lineDiff = computeLineDiff(effectiveBooking.lines, command.desiredLines);
  } catch (err) {
    if (err instanceof BusinessSignal) {
      return err.result as PreviewBookingAmendmentResult;
    }
    throw err;
  }

  const quoteLineMap = new Map<string, (typeof quoteResult.lines)[number]>();
  for (const ql of quoteResult.lines) {
    quoteLineMap.set(ql.variantId, ql);
  }

  for (const entry of lineDiff) {
    if (entry.action !== 'REMOVE') {
      const ql = quoteLineMap.get(entry.variantId);
      if (!ql) {
        return {
          kind: 'INVALID_INPUT',
          message: 'Ligne de devis introuvable pour la variante demandée.',
        };
      }
      entry.afterUnitPriceAmountMinor = ql.unitPriceAmountMinor;
      entry.afterLineTotalAmountMinor = ql.lineTotalAmountMinor;

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

  // 11. Vérification indicative de la disponibilité physique (fail-closed strict)
  const availabilityConflict = await checkPreviewAvailability(
    db,
    organizationId,
    command.bookingId,
    effectiveBooking,
    lineDiff,
    newCustomerStartAt,
    newCustomerEndAt,
    newBlockedStartAt,
    newBlockedEndAt,
  );
  if (availabilityConflict !== null) {
    return { kind: 'AVAILABILITY_CONFLICT', message: availabilityConflict };
  }

  // 12. Calculs financiers et commission fail-closed
  const previousContractualTotalAmountMinor = effectiveBooking.effectiveTotalAmountMinor;
  const nextContractualTotalAmountMinor = quoteResult.totalAmountMinor;
  const deltaAmountMinor = nextContractualTotalAmountMinor - previousContractualTotalAmountMinor;
  const classification = classifyDelta(deltaAmountMinor);

  let supplementCommissionAmountMinor: number | null = null;
  let supplementNetAmountMinor: number | null = null;

  if (classification === 'SUPPLEMENT') {
    const origBookingRows = await db
      .select({
        totalAmountMinor: bookings.totalAmountMinor,
        commissionAmountMinor: bookings.commissionAmountMinor,
      })
      .from(bookings)
      .where(and(eq(bookings.id, command.bookingId), eq(bookings.organizationId, organizationId)))
      .limit(1);

    if (origBookingRows.length === 0) {
      return {
        kind: 'INVALID_INPUT',
        message: 'Réservation source introuvable pour le calcul de commission.',
      };
    }

    const origBooking = origBookingRows[0]!;
    supplementCommissionAmountMinor = calculateSupplementCommission(
      deltaAmountMinor,
      origBooking.totalAmountMinor,
      origBooking.commissionAmountMinor,
    );
    supplementNetAmountMinor = deltaAmountMinor - supplementCommissionAmountMinor;
  }

  // 13. Construction du diff ordonné avec libellés publics sûrs
  const previewLines: PreviewLineDiffEntry[] = [];
  for (const entry of lineDiff) {
    const names = variantDataMap.get(entry.variantId);
    if (!names) {
      return {
        kind: 'INVALID_INPUT',
        message: 'Libellés introuvables pour la variante demandée.',
      };
    }
    previewLines.push({
      logicalLineId: entry.logicalLineId,
      variantId: entry.variantId,
      productName: names.productName,
      variantName: names.variantName,
      action: entry.action,
      beforeQuantity: entry.beforeQuantity,
      afterQuantity: entry.afterQuantity,
      beforeLineTotalAmountMinor: entry.beforeLineTotalAmountMinor,
      afterLineTotalAmountMinor: entry.afterLineTotalAmountMinor,
    });
  }

  previewLines.sort(
    (a, b) =>
      a.productName.localeCompare(b.productName, 'fr-FR') ||
      a.variantName.localeCompare(b.variantName, 'fr-FR') ||
      a.variantId.localeCompare(b.variantId) ||
      a.logicalLineId.localeCompare(b.logicalLineId),
  );

  return {
    kind: 'SUCCESS',
    bookingId: command.bookingId,
    locationId: effectiveBooking.booking.locationId,
    locationTimeZone: timeZone,
    lastAppliedAmendmentNumber: effectiveBooking.lastAppliedAmendmentNumber,
    classification,
    previousCustomerStartAt: effectiveBooking.effectiveCustomerStartAt,
    previousCustomerEndAt: effectiveBooking.effectiveCustomerEndAt,
    nextCustomerStartAt: newCustomerStartAt,
    nextCustomerEndAt: newCustomerEndAt,
    previousContractualTotalAmountMinor,
    nextContractualTotalAmountMinor,
    deltaAmountMinor,
    currency: 'EUR',
    supplementCommissionAmountMinor,
    supplementNetAmountMinor,
    lines: previewLines,
  };
}
