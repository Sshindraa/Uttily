import { and, eq, isNull, count, sql, inArray } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  organizations,
  locations,
  locationOpeningHours,
  products,
  productVariants,
  productPhotos,
  pricingPlans,
  inventoryItems,
  organizationPaymentAccounts,
} from '@uttily/database';

export type ReadinessMilestoneKey =
  'ORGANIZATION' | 'LOCATION' | 'PRIMARY_PRODUCT' | 'PHOTOS' | 'PRICING' | 'INVENTORY' | 'PAYMENTS';

export interface ReadinessMilestone {
  key: ReadinessMilestoneKey;
  completed: boolean;
  details: {
    targetId?: string | undefined;
    productId?: string | undefined;
    variantId?: string | undefined;
    count?: number | undefined;
    required?: number | undefined;
    info?: string | undefined;
    isLegalIdentityComplete?: boolean | undefined;
    hasRegistrationNumber?: boolean | undefined;
    hasRegisteredOffice?: boolean | undefined;
  };
}

export interface OrganizationOnboardingReadiness {
  organizationId: string;
  completedCount: number;
  totalCount: 7;
  percentage: number;
  isConfigurationComplete: boolean;
  isReadyForReservations: boolean;
  milestones: ReadinessMilestone[];
}

/**
 * Calcule l'état de préparation (readiness) d'une organisation en 7 jalons structurés.
 * Read model pur (sans effets de bord ni dépendance d'interface).
 */
export async function getOrganizationOnboardingReadiness(
  db: DatabaseClient,
  organizationId: string,
): Promise<OrganizationOnboardingReadiness> {
  // 1. JALON 1 : ORGANISATION
  const [org] = await db
    .select({
      id: organizations.id,
      legalName: organizations.legalName,
      slug: organizations.slug,
      registrationNumber: organizations.registrationNumber,
      legalForm: organizations.legalForm,
      registeredOfficeCity: organizations.registeredOfficeCity,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  const orgCompleted = !!(org && org.legalName.trim().length >= 2 && org.slug.trim().length >= 2);
  const isLegalIdentityComplete = !!(
    org &&
    org.legalName.trim().length >= 2 &&
    org.registrationNumber?.trim() &&
    org.registeredOfficeCity?.trim()
  );

  // 2. JALON 2 : BOUTIQUE (LOCATION)
  const locRows = await db
    .select({
      id: locations.id,
      name: locations.name,
      addressLine1: locations.addressLine1,
      city: locations.city,
      postalCode: locations.postalCode,
      countryCode: locations.countryCode,
      geoPoint: locations.geoPoint,
      pickupEnabled: locations.pickupEnabled,
    })
    .from(locations)
    .where(and(eq(locations.organizationId, organizationId), isNull(locations.deletedAt)));

  let publishableLocationId: string | undefined;

  for (const loc of locRows) {
    const isAddressValid = !!(
      loc.addressLine1?.trim() &&
      loc.city?.trim() &&
      loc.postalCode?.trim() &&
      loc.countryCode?.trim()
    );
    const isCoordsValid = loc.geoPoint !== null;
    const isPickup = loc.pickupEnabled === true;

    if (isAddressValid && isCoordsValid && isPickup) {
      // Vérifie la présence d'au moins une plage horaire
      const [openHour] = await db
        .select({ id: locationOpeningHours.id })
        .from(locationOpeningHours)
        .where(eq(locationOpeningHours.locationId, loc.id))
        .limit(1);

      if (openHour) {
        publishableLocationId = loc.id;
        break;
      }
    }
  }

  const locationCompleted = !!publishableLocationId;

  // 3. JALON 3 : PREMIER VÉLO (PRODUCT & VARIANT)
  const prodRows = await db
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
      publicationStatus: products.publicationStatus,
    })
    .from(products)
    .where(and(eq(products.organizationId, organizationId), isNull(products.deletedAt)));

  const productIds = prodRows.map((p) => p.id);

  let primaryProductId: string | undefined;
  let primaryVariantId: string | undefined;

  if (productIds.length > 0) {
    const varRows = await db
      .select({
        id: productVariants.id,
        productId: productVariants.productId,
        name: productVariants.name,
        isActive: productVariants.isActive,
      })
      .from(productVariants)
      .where(
        and(
          inArray(productVariants.productId, productIds),
          eq(productVariants.isActive, true),
          isNull(productVariants.deletedAt),
        ),
      );

    for (const prod of prodRows) {
      const hasDescription = (prod.description ?? '').trim().length > 0;
      const activeVariant = varRows.find((v) => v.productId === prod.id);
      if (hasDescription && activeVariant) {
        primaryProductId = prod.id;
        primaryVariantId = activeVariant.id;
        break;
      }
    }
  }

  const primaryProductCompleted = !!primaryProductId;

  // 4. JALON 4 : PHOTOS (≥ 3 photos AVAILABLE pour au moins 1 produit)
  let photosCompleted = false;
  let photoProductTargetId: string | undefined = primaryProductId ?? prodRows[0]?.id;
  let maxValidPhotosCount = 0;

  if (productIds.length > 0) {
    const photoCounts = await db
      .select({
        productId: productPhotos.productId,
        validCount: sql<number>`count(distinct ${productPhotos.checksumSha256})::integer`,
      })
      .from(productPhotos)
      .where(
        and(
          inArray(productPhotos.productId, productIds),
          eq(productPhotos.fileState, 'AVAILABLE'),
          isNull(productPhotos.deletedAt),
          sql`${productPhotos.checksumSha256} IS NOT NULL`,
        ),
      )
      .groupBy(productPhotos.productId);

    for (const row of photoCounts) {
      const countVal = Number(row.validCount ?? 0);
      if (countVal > maxValidPhotosCount) {
        maxValidPhotosCount = countVal;
        photoProductTargetId = row.productId;
      }
      if (countVal >= 3) {
        photosCompleted = true;
        photoProductTargetId = row.productId;
        break;
      }
    }
  }

  // 5. JALON 5 : TARIF (≥ 1 plan tarifaire ACTIVE pour l'organisation)
  const [activePlanRow] = await db
    .select({
      id: pricingPlans.id,
      productVariantId: pricingPlans.productVariantId,
    })
    .from(pricingPlans)
    .where(
      and(
        eq(pricingPlans.organizationId, organizationId),
        eq(pricingPlans.lifecycleState, 'ACTIVE'),
      ),
    )
    .limit(1);

  const pricingCompleted = !!activePlanRow;

  // 6. JALON 6 : FLOTTE (≥ 1 exemplaire physique ACTIVE)
  let activeInventoryCount = 0;
  if (productIds.length > 0) {
    const [invCountRow] = await db
      .select({ val: count() })
      .from(inventoryItems)
      .innerJoin(productVariants, eq(inventoryItems.productVariantId, productVariants.id))
      .where(
        and(
          inArray(productVariants.productId, productIds),
          eq(inventoryItems.status, 'ACTIVE'),
          isNull(inventoryItems.deletedAt),
        ),
      );
    activeInventoryCount = Number(invCountRow?.val ?? 0);
  }

  const inventoryCompleted = activeInventoryCount >= 1;

  // 7. JALON 7 : PAIEMENTS (Stripe Connect connecté et charges actives)
  const [paymentAccount] = await db
    .select({
      id: organizationPaymentAccounts.id,
      onboardingStatus: organizationPaymentAccounts.onboardingStatus,
      chargesEnabled: organizationPaymentAccounts.chargesEnabled,
      payoutsEnabled: organizationPaymentAccounts.payoutsEnabled,
      transfersCapabilityStatus: organizationPaymentAccounts.transfersCapabilityStatus,
    })
    .from(organizationPaymentAccounts)
    .where(
      and(
        eq(organizationPaymentAccounts.organizationId, organizationId),
        eq(organizationPaymentAccounts.provider, 'STRIPE'),
      ),
    )
    .limit(1);

  const paymentsCompleted = !!(
    paymentAccount &&
    (paymentAccount.chargesEnabled || paymentAccount.onboardingStatus === 'ENABLED')
  );

  const milestones: ReadinessMilestone[] = [
    {
      key: 'ORGANIZATION',
      completed: orgCompleted,
      details: {
        targetId: organizationId,
        isLegalIdentityComplete,
        hasRegistrationNumber: !!org?.registrationNumber?.trim(),
        hasRegisteredOffice: !!org?.registeredOfficeCity?.trim(),
      },
    },
    {
      key: 'LOCATION',
      completed: locationCompleted,
      details: { targetId: publishableLocationId ?? locRows[0]?.id, count: locRows.length },
    },
    {
      key: 'PRIMARY_PRODUCT',
      completed: primaryProductCompleted,
      details: {
        productId: primaryProductId ?? prodRows[0]?.id,
        variantId: primaryVariantId,
        count: prodRows.length,
      },
    },
    {
      key: 'PHOTOS',
      completed: photosCompleted,
      details: {
        productId: photoProductTargetId,
        count: maxValidPhotosCount,
        required: 3,
      },
    },
    {
      key: 'PRICING',
      completed: pricingCompleted,
      details: {
        productId: primaryProductId ?? prodRows[0]?.id,
        variantId: activePlanRow?.productVariantId ?? primaryVariantId,
      },
    },
    {
      key: 'INVENTORY',
      completed: inventoryCompleted,
      details: { count: activeInventoryCount, required: 1 },
    },
    {
      key: 'PAYMENTS',
      completed: paymentsCompleted,
      details: { targetId: paymentAccount?.id },
    },
  ];

  const completedCount = milestones.filter((m) => m.completed).length;
  const totalCount = 7;
  const percentage = Math.round((completedCount / totalCount) * 100);

  // Configuration terminée si les 6 premières étapes sont complètes
  const isConfigurationComplete = milestones
    .filter((m) => m.key !== 'PAYMENTS')
    .every((m) => m.completed);

  const isReadyForReservations = completedCount === totalCount;

  return {
    organizationId,
    completedCount,
    totalCount,
    percentage,
    isConfigurationComplete,
    isReadyForReservations,
    milestones,
  };
}
