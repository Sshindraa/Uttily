import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  categories,
  countries,
  locationOpeningHours,
  locations,
  organizations,
  pricingPlans,
  productPhotos,
  products,
  productVariants,
} from '@uttily/database';
import { isHistoricalPaddleCategorySlug } from '../catalog/equipment-taxonomy';
import type {
  GetPublicOfferDetailsInput,
  GetPublicOfferDetailsResult,
  PublicOfferDetails,
  PublicOfferOpeningHour,
  PublicOfferVariant,
  PublicProductPublicationGate,
} from './types';
import {
  calculateMarketplaceFeeSnapshot,
  calculateMarketplaceFeeSnapshotFromPricing,
} from '../marketplace-fees';
import { FlexiblePricingError } from '../pricing-plans/errors';
import { quoteFlexiblePricing } from '../pricing-plans/quote-flexible-pricing';
import { getProfessionalVerification } from '../professional-verification';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read model canonique public d'une offre de location (G7E / Pont Checkout).
 *
 * Charge les données publiques nécessaires à la consultation et à la configuration
 * d'une réservation à partir de (publicProductId, publicLocationId).
 *
 * Règles de sécurité et d'isolation :
 * - Autorise uniquement les produits PUBLISHED non supprimés.
 * - Autorise uniquement les établissements publicly listed et pickup enabled non supprimés.
 * - Exige la stricte appartenance du produit et de l'établissement à la même organisation.
 * - Vérifie que l'organisation n'est pas supprimée.
 * - Vérifie que le pays de l'établissement est actif (countries.is_active = true).
 * - Applique le publicationGate (au moins 3 photos validées) si fourni.
 * - Expose uniquement les identifiants publics (publicProductId, publicLocationId, publicVariantId).
 * - Ne retourne aucun identifiant interne d'organisation, de lieu, de variante ou d'inventaire physique.
 */
export async function getPublicOfferDetails(
  db: DatabaseClient,
  input: GetPublicOfferDetailsInput,
  options?: {
    publicationGate?: PublicProductPublicationGate;
  },
): Promise<GetPublicOfferDetailsResult> {
  if (
    !input ||
    typeof input !== 'object' ||
    !input.publicProductId ||
    typeof input.publicProductId !== 'string' ||
    !UUID_RE.test(input.publicProductId.trim()) ||
    !input.publicLocationId ||
    typeof input.publicLocationId !== 'string' ||
    !UUID_RE.test(input.publicLocationId.trim())
  ) {
    return { kind: 'INVALID_INPUT' };
  }

  const cleanPublicProductId = input.publicProductId.trim();
  const cleanPublicLocationId = input.publicLocationId.trim();

  // 1. Charger produit, organisation, établissement et pays en une seule requête jointe
  const rows = await db
    .select({
      productId: products.id,
      publicProductId: products.publicId,
      productName: products.name,
      productDescription: products.description,
      productPublicationStatus: products.publicationStatus,
      productDeletedAt: products.deletedAt,
      categorySlug: categories.slug,
      productOrgId: products.organizationId,
      orgId: organizations.id,
      orgLegalName: organizations.legalName,
      orgPublicDisplayName: organizations.publicDisplayName,
      orgDeletedAt: organizations.deletedAt,
      locationId: locations.id,
      publicLocationId: locations.publicId,
      locationName: locations.name,
      locationOrgId: locations.organizationId,
      timeZone: locations.timeZone,
      operatingCurrency: locations.operatingCurrency,
      addressLine1: locations.addressLine1,
      addressLine2: locations.addressLine2,
      city: locations.city,
      postalCode: locations.postalCode,
      countryCode: locations.countryCode,
      pickupEnabled: locations.pickupEnabled,
      isPubliclyListed: locations.isPubliclyListed,
      locationDeletedAt: locations.deletedAt,
      countryIsActive: countries.isActive,
    })
    .from(products)
    .innerJoin(organizations, eq(organizations.id, products.organizationId))
    .innerJoin(locations, eq(locations.publicId, cleanPublicLocationId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .leftJoin(countries, eq(countries.countryCode, locations.countryCode))
    .where(eq(products.publicId, cleanPublicProductId))
    .limit(1);

  if (rows.length === 0) {
    return { kind: 'NOT_FOUND' };
  }

  const r = rows[0]!;

  // 2. Vérifications de cohérence multi-tenant et d'état
  if (r.productOrgId !== r.locationOrgId) {
    return { kind: 'NOT_FOUND' };
  }

  if (r.productPublicationStatus !== 'PUBLISHED') {
    return { kind: 'NOT_FOUND' };
  }

  if (isHistoricalPaddleCategorySlug(r.categorySlug)) {
    return { kind: 'NOT_FOUND' };
  }

  if (r.productDeletedAt !== null || r.orgDeletedAt !== null || r.locationDeletedAt !== null) {
    return { kind: 'NOT_FOUND' };
  }

  if (!r.isPubliclyListed || !r.pickupEnabled) {
    return { kind: 'NOT_FOUND' };
  }

  if (!r.addressLine1 || !r.city || !r.countryCode || !r.countryIsActive) {
    return { kind: 'NOT_FOUND' };
  }

  // 3. Gating de publication (photos) si fourni
  if (options?.publicationGate) {
    const eligible = await options.publicationGate.filterEligibleProductIds(db, [r.productId]);
    if (!eligible.has(r.productId)) {
      return { kind: 'NOT_FOUND' };
    }
  }

  // 4. Charger les variantes actives et non supprimées (projection minimale)
  const variantRows = await db
    .select({
      variantId: productVariants.id,
      publicVariantId: productVariants.publicId,
      name: productVariants.name,
      dailyPriceAmountMinor: productVariants.dailyPriceAmountMinor,
      currency: productVariants.currency,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.productId, r.productId),
        eq(productVariants.isActive, true),
        isNull(productVariants.deletedAt),
      ),
    )
    .orderBy(asc(productVariants.createdAt), asc(productVariants.name));

  if (variantRows.length === 0) {
    return { kind: 'NOT_FOUND' };
  }

  // 5. Charger les horaires d'ouverture de l'établissement
  const openingHourRows = await db
    .select({
      weekday: locationOpeningHours.weekday,
      openTime: locationOpeningHours.openTime,
      closeTime: locationOpeningHours.closeTime,
    })
    .from(locationOpeningHours)
    .where(eq(locationOpeningHours.locationId, r.locationId))
    .orderBy(asc(locationOpeningHours.weekday), asc(locationOpeningHours.openTime));

  const variants: PublicOfferVariant[] = variantRows.map((v) => ({
    publicVariantId: v.publicVariantId,
    name: v.name,
  }));

  // Avec une intention de réservation, le moteur flexible est l'autorité de
  // l'aperçu. Sans intention (accès direct), on présente le plan actif le moins
  // cher applicable au lieu, puis l’ancien champ comme compatibilité.
  const price = input.intent
    ? await getIntentPrice(db, r.orgId, r.locationId, input, variantRows)
    : await getIndicativePrice(db, r.locationId, variantRows, input.locale);

  const openingHours: PublicOfferOpeningHour[] = openingHourRows.map((h) => ({
    weekday: h.weekday,
    openTime: h.openTime,
    closeTime: h.closeTime,
  }));

  const photoRows = await db
    .select({
      publicPhotoId: productPhotos.publicId,
      contentType: productPhotos.contentType,
      widthPx: productPhotos.widthPx,
      heightPx: productPhotos.heightPx,
    })
    .from(productPhotos)
    .where(
      and(
        eq(productPhotos.productId, r.productId),
        eq(productPhotos.organizationId, r.productOrgId),
        eq(productPhotos.fileState, 'AVAILABLE'),
        isNull(productPhotos.deletedAt),
      ),
    )
    .orderBy(asc(productPhotos.sortOrder), asc(productPhotos.createdAt));

  const photos = photoRows.filter(
    (
      photo,
    ): photo is typeof photo & {
      contentType: 'image/jpeg' | 'image/png' | 'image/webp';
      widthPx: number;
      heightPx: number;
    } =>
      (photo.contentType === 'image/jpeg' ||
        photo.contentType === 'image/png' ||
        photo.contentType === 'image/webp') &&
      photo.widthPx !== null &&
      photo.heightPx !== null,
  );

  // Une surface publique ne demande jamais l'environnement TEST. Le statut
  // reste recalculé côté serveur et disparaît dès qu'un fait LIVE n'est plus
  // conforme.
  const professionalVerification = await getProfessionalVerification(db, r.orgId, 'LIVE');

  const offer: PublicOfferDetails = {
    publicProductId: r.publicProductId,
    publicLocationId: r.publicLocationId,
    organizationPublicDisplayName: r.orgPublicDisplayName ?? r.orgLegalName,
    professionalVerificationStatus: professionalVerification.status,
    productName: r.productName,
    productDescription: r.productDescription ?? '',
    locationName: r.locationName,
    timeZone: r.timeZone,
    operatingCurrency: r.operatingCurrency,
    addressLine1: r.addressLine1,
    addressLine2: r.addressLine2,
    city: r.city,
    postalCode: r.postalCode,
    countryCode: r.countryCode,
    ...(price ? { price } : {}),
    variants,
    photos,
    openingHours,
  };

  return { kind: 'SUCCESS', offer };
}

type OfferVariantRow = {
  variantId: string;
  publicVariantId: string;
  name: string;
  dailyPriceAmountMinor: number | null;
  currency: string;
};

async function getIntentPrice(
  db: DatabaseClient,
  organizationId: string,
  locationId: string,
  input: GetPublicOfferDetailsInput,
  variantRows: OfferVariantRow[],
): Promise<PublicOfferDetails['price']> {
  const selectedVariant = input.publicVariantId
    ? variantRows.find((variant) => variant.publicVariantId === input.publicVariantId)
    : undefined;
  const variantsToQuote = selectedVariant ? [selectedVariant] : variantRows;
  if (variantsToQuote.length === 0 || !input.intent) return undefined;

  try {
    const quote = await quoteFlexiblePricing(db, {
      organizationId,
      locationId,
      locale: input.locale?.trim() || 'fr',
      intent: input.intent,
      lines: variantsToQuote.map((variant) => ({ variantId: variant.variantId, quantity: 1 })),
    });

    const quoteLines = quote.lines.filter((line) =>
      variantsToQuote.some((variant) => variant.variantId === line.variantId),
    );
    const bestLine = [...quoteLines].sort(
      (left, right) =>
        left.lineTotalAmountMinor - right.lineTotalAmountMinor ||
        left.variantId.localeCompare(right.variantId),
    )[0];
    if (!bestLine || quote.currency !== 'EUR') return undefined;

    const snapshot = calculateMarketplaceFeeSnapshotFromPricing({
      subtotalAmountMinor: bestLine.lineTotalAmountMinor,
      mandatoryFeesAmountMinor: 0,
    });
    return {
      currency: 'EUR',
      marketplaceFeeBaseAmountMinor: snapshot.marketplaceFeeBaseAmountMinor,
      customerServiceFeeAmountMinor: snapshot.customerServiceFeeAmountMinor,
      customerTotalAmountMinor: snapshot.customerTotalAmountMinor,
      marketplaceFeeRuleVersion: snapshot.ruleVersion,
      totalAmountMinor: snapshot.customerTotalAmountMinor,
      planType: bestLine.planType,
      publicLabel:
        selectedVariant || variantsToQuote.length === 1
          ? bestLine.publicLabel
          : getFromLabel(input.locale),
      requestedDurationMinutes: bestLine.requestedDurationMinutes,
      billedDurationMinutes: bestLine.billedDurationMinutes,
      billedDays: bestLine.billedDays,
      discountPercent: bestLine.discountPercent,
    };
  } catch (error) {
    // Une intention impossible à tarifer (hors horaires, configuration
    // absente, etc.) ne doit pas afficher un ancien tarif trompeur.
    if (error instanceof FlexiblePricingError) return undefined;
    throw error;
  }
}

async function getIndicativePrice(
  db: DatabaseClient,
  locationId: string,
  variantRows: OfferVariantRow[],
  locale: string | undefined,
): Promise<PublicOfferDetails['price']> {
  const activePlans = await db
    .select({
      id: pricingPlans.id,
      productVariantId: pricingPlans.productVariantId,
      locationId: pricingPlans.locationId,
      planType: pricingPlans.planType,
      currency: pricingPlans.currency,
      priceAmountMinor: pricingPlans.priceAmountMinor,
      includedDurationMinutes: pricingPlans.includedDurationMinutes,
    })
    .from(pricingPlans)
    .where(
      and(
        inArray(
          pricingPlans.productVariantId,
          variantRows.map((variant) => variant.variantId),
        ),
        eq(pricingPlans.lifecycleState, 'ACTIVE'),
        eq(pricingPlans.currency, 'EUR'),
        or(isNull(pricingPlans.locationId), eq(pricingPlans.locationId, locationId)),
      ),
    );

  const effectivePlans = variantRows.flatMap((variant) => {
    const plans = activePlans.filter((plan) => plan.productVariantId === variant.variantId);
    const localPlans = plans.filter((plan) => plan.locationId === locationId);
    return plans.filter(
      (plan) =>
        plan.locationId === locationId ||
        !localPlans.some(
          (localPlan) =>
            localPlan.planType === plan.planType &&
            localPlan.includedDurationMinutes === plan.includedDurationMinutes,
        ),
    );
  });
  const bestActivePlan = [...effectivePlans]
    .filter(
      (plan) =>
        Number.isSafeInteger(Number(plan.priceAmountMinor)) && Number(plan.priceAmountMinor) > 0,
    )
    .sort(
      (left, right) =>
        Number(left.priceAmountMinor) - Number(right.priceAmountMinor) ||
        left.productVariantId.localeCompare(right.productVariantId) ||
        left.id.localeCompare(right.id),
    )[0];

  if (bestActivePlan) {
    const snapshot = calculateMarketplaceFeeSnapshot({
      marketplaceFeeBaseAmountMinor: Number(bestActivePlan.priceAmountMinor),
    });
    return {
      currency: 'EUR',
      marketplaceFeeBaseAmountMinor: snapshot.marketplaceFeeBaseAmountMinor,
      customerServiceFeeAmountMinor: snapshot.customerServiceFeeAmountMinor,
      customerTotalAmountMinor: snapshot.customerTotalAmountMinor,
      marketplaceFeeRuleVersion: snapshot.ruleVersion,
      totalAmountMinor: snapshot.customerTotalAmountMinor,
      planType: bestActivePlan.planType,
      publicLabel: getIndicativePlanLabel(locale, bestActivePlan.planType),
      requestedDurationMinutes: null,
      billedDurationMinutes: null,
      billedDays: bestActivePlan.planType === 'DAILY' ? 1 : null,
      discountPercent: null,
    };
  }

  // Compatibilité avec les anciennes fiches qui n’ont pas encore de plan actif.
  const dailyPrices = variantRows
    .filter(
      (variant): variant is OfferVariantRow & { dailyPriceAmountMinor: number } =>
        variant.dailyPriceAmountMinor !== null &&
        Number.isSafeInteger(variant.dailyPriceAmountMinor) &&
        variant.dailyPriceAmountMinor > 0 &&
        variant.currency === 'EUR',
    )
    .map((variant) => variant.dailyPriceAmountMinor);
  const lowestDailyPrice = dailyPrices.length > 0 ? Math.min(...dailyPrices) : null;
  if (lowestDailyPrice === null) return undefined;

  const snapshot = calculateMarketplaceFeeSnapshot({
    marketplaceFeeBaseAmountMinor: lowestDailyPrice,
  });
  return {
    currency: 'EUR',
    marketplaceFeeBaseAmountMinor: snapshot.marketplaceFeeBaseAmountMinor,
    customerServiceFeeAmountMinor: snapshot.customerServiceFeeAmountMinor,
    customerTotalAmountMinor: snapshot.customerTotalAmountMinor,
    marketplaceFeeRuleVersion: snapshot.ruleVersion,
    totalAmountMinor: snapshot.customerTotalAmountMinor,
    planType: 'DAILY',
    publicLabel: getFromLabel(locale),
    requestedDurationMinutes: null,
    billedDurationMinutes: null,
    billedDays: 1,
    discountPercent: null,
  };
}

function getIndicativePlanLabel(
  locale: string | undefined,
  planType: 'DAILY' | 'HOURLY' | 'FIXED_DURATION',
): string {
  const from = getFromLabel(locale);
  if (locale?.toLowerCase().startsWith('en')) {
    return `${from} · ${planType === 'DAILY' ? 'per day' : planType === 'HOURLY' ? 'per hour' : 'fixed duration'}`;
  }
  return `${from} · ${planType === 'DAILY' ? 'par jour' : planType === 'HOURLY' ? 'par heure' : 'forfait durée fixe'}`;
}

function getFromLabel(locale: string | undefined): string {
  return locale?.toLowerCase().startsWith('en') ? 'From' : 'À partir de';
}
