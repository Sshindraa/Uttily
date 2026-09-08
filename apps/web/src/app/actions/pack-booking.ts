'use server';

import type { ActionResult } from '@uttily/contracts';
import {
  createAtomicPackHold,
  PackAllocationError,
  recordPackAnalytics,
  calculateMarketplaceFeeSnapshotFromPricing,
} from '@uttily/core';
import {
  allocations,
  bookingDrafts,
  bookingDraftLines,
  productVariants,
  products,
  inventoryItems,
} from '@uttily/database';
import { eq, inArray } from 'drizzle-orm';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';

export interface CreatePackBookingDraftActionInput {
  readonly organizationId: string;
  readonly locationId: string;
  readonly inventoryItemIds: readonly string[];
  readonly startAtIso: string;
  readonly endAtIso: string;
  readonly totalPriceCents: number;
  readonly packTitle?: string;
  readonly isRepaired?: boolean | undefined;
  readonly locale?: 'fr' | 'en';
  readonly idempotencyKey?: string;
}

export interface CreatePackBookingDraftSuccess {
  readonly draftId: string;
  readonly redirectUrl: string;
}

/**
 * Action serveur pour réserver un Pack complet en un clic (ADR-041).
 *
 * Exécute un hold atomique multi-items dans une transaction PostgreSQL.
 * Si 100% des équipements sont verrouillés, crée le brouillon de réservation
 * et redirige vers le checkout standardisé.
 */
export async function createPackBookingDraftAction(
  input: CreatePackBookingDraftActionInput,
): Promise<ActionResult<CreatePackBookingDraftSuccess>> {
  const locale = input.locale === 'en' ? 'en' : 'fr';
  const fr = locale === 'fr';

  const user = await getAuthenticatedUser();
  if (!user) {
    return {
      ok: false,
      code: 'UNAUTHENTICATED',
      message: fr
        ? 'Vous devez être connecté pour réserver ce pack.'
        : 'You must be signed in to book this pack.',
    };
  }

  if (!input.organizationId || !input.locationId || !input.inventoryItemIds?.length) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: fr ? 'Paramètres de pack incomplets.' : 'Incomplete pack parameters.',
    };
  }

  const startAt = new Date(input.startAtIso);
  const endAt = new Date(input.endAtIso);

  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: fr ? 'Dates de réservation invalides.' : 'Invalid booking dates.',
    };
  }

  const db = getDb();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes hold
  const draftId = crypto.randomUUID();

  try {
    // 1. Hold atomique multi-items transactionnel (ADR-041)
    const holdResult = await createAtomicPackHold(db, {
      organizationId: input.organizationId,
      inventoryItemIds: input.inventoryItemIds,
      draftId,
      startAt,
      endAt,
      expiresAt,
    });

    // 2. Création du brouillon, des lignes et des allocations associées
    let totalAmountMinor = input.totalPriceCents;

    await db.transaction(async (tx) => {
      const itemsWithVariants = await tx
        .select({
          itemId: inventoryItems.id,
          variantId: productVariants.id,
          variantName: productVariants.name,
          dailyPriceAmountMinor: productVariants.dailyPriceAmountMinor,
          productId: productVariants.productId,
          productName: products.name,
          skuSuffix: productVariants.skuSuffix,
          attributes: productVariants.attributes,
        })
        .from(inventoryItems)
        .innerJoin(productVariants, eq(inventoryItems.productVariantId, productVariants.id))
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(inArray(inventoryItems.id, [...input.inventoryItemIds]));

      const calculatedSubtotal = itemsWithVariants.reduce(
        (sum, it) =>
          sum +
          (it.dailyPriceAmountMinor ??
            Math.round(input.totalPriceCents / Math.max(1, itemsWithVariants.length))),
        0,
      );
      totalAmountMinor = calculatedSubtotal > 0 ? calculatedSubtotal : input.totalPriceCents;

      const marketplaceFeeSnapshot = calculateMarketplaceFeeSnapshotFromPricing({
        subtotalAmountMinor: totalAmountMinor,
        mandatoryFeesAmountMinor: 0,
      });

      await tx.insert(bookingDrafts).values({
        id: draftId,
        organizationId: input.organizationId,
        locationId: input.locationId,
        customerUserId: user.id,
        status: 'HELD',
        customerStartAt: startAt,
        customerEndAt: endAt,
        blockedStartAt: startAt,
        blockedEndAt: endAt,
        timezone: 'Europe/Paris',
        prepBufferMinutes: 30,
        cleanupBufferMinutes: 30,
        currency: 'EUR',
        subtotalAmountMinor: totalAmountMinor,
        mandatoryFeesAmountMinor: 0,
        totalAmountMinor: totalAmountMinor,
        customerTotalAmountMinor: marketplaceFeeSnapshot.customerTotalAmountMinor,
        marketplaceFeeSnapshot: marketplaceFeeSnapshot as unknown as Record<string, unknown>,
        billableUnit: 'DAY',
        billableUnitCount: 1,
        cancellationPolicySnapshot: {
          policy_code: 'FLEXIBLE',
          policy_version: 1,
          timezone: 'Europe/Paris',
        },
        expiresAt,
      });

      const blockByItemId = new Map(holdResult.blocks.map((b) => [b.inventoryItemId, b.blockId]));

      for (const it of itemsWithVariants) {
        const linePrice =
          it.dailyPriceAmountMinor ??
          Math.round(totalAmountMinor / Math.max(1, itemsWithVariants.length));

        const [insertedLine] = await tx
          .insert(bookingDraftLines)
          .values({
            draftId,
            variantId: it.variantId,
            quantity: 1,
            unitPriceAmountMinor: linePrice,
            billableUnitCount: 1,
            lineTotalAmountMinor: linePrice,
            currency: 'EUR',
            variantSnapshot: {
              productName: it.productName,
              variantName: it.variantName,
              skuSuffix: it.skuSuffix,
              attributes: (it.attributes as Record<string, unknown>) ?? {},
            },
          })
          .returning({ id: bookingDraftLines.id });

        const blockId = blockByItemId.get(it.itemId);
        if (blockId && insertedLine) {
          await tx.insert(allocations).values({
            draftLineId: insertedLine.id,
            inventoryBlockId: blockId,
            status: 'ALLOCATED',
          });
        }
      }
    });

    // 3. Analytics
    recordPackAnalytics({
      eventName: input.isRepaired ? 'pack_repair_selected' : 'pack_hold_success',
      organizationId: input.organizationId,
      itemsCount: input.inventoryItemIds.length,
      peopleCount: input.inventoryItemIds.length,
      totalPackPriceCents: totalAmountMinor,
      isRepaired: input.isRepaired,
    });

    return {
      ok: true,
      data: {
        draftId,
        redirectUrl: `/checkout/${draftId}`,
      },
    };
  } catch (error) {
    if (error instanceof PackAllocationError && error.code === 'CONCURRENCY_CONFLICT') {
      return {
        ok: false,
        code: 'CONFLICT_BLOCK',
        message: fr
          ? 'Un des équipements de ce pack vient d’être réservé par un autre client. Veuillez sélectionner une autre solution.'
          : 'One of the items in this pack was just booked by another client. Please select another solution.',
      };
    }

    return {
      ok: false,
      code: 'UNKNOWN',
      message:
        error instanceof Error
          ? error.message
          : fr
            ? 'Erreur lors de la réservation du pack.'
            : 'Error booking pack.',
    };
  }
}
