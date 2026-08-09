/**
 * @uttily/core — Module Pricing Plans (G7P-B1).
 *
 * Chargeur de contexte de pricing depuis PostgreSQL.
 * Toutes les données sont chargées en requêtes batchées (pas de N+1).
 * Au maximum 7 requêtes SQL quel que soit le nombre de lignes.
 */

import { eq, inArray, sql } from 'drizzle-orm';
import {
  locations,
  locationOpeningHours,
  pricingPlanWindows,
  multiDayDiscountTiers,
  pricingPlanTranslations,
  productVariants,
  products,
  type DatabaseClient,
} from '@uttily/database';
import type {
  OpeningHour,
  PricingContext,
  QuoteFlexiblePricingInput,
  ResolvedFlexiblePricingIntent,
  ResolvedPlan,
  ResolvedTier,
  ResolvedTranslation,
  ResolvedWindow,
} from './types';
import { FlexiblePricingError } from './errors';
import { localDateTimeStringToUtc } from './local-to-utc';

/**
 * Charge tout le contexte de pricing nécessaire au calcul d'un devis.
 *
 * Requêtes (au maximum 7, toutes batchées) :
 * 1. Location (single query)
 * 2. Opening hours for location (single query)
 * 3. resolve_effective_pricing_plans(locationId) (single query — SQL function)
 * 4. Windows for ALL resolved plan IDs (single query, WHERE pricing_plan_id = ANY(...))
 * 5. Tiers for ALL resolved plan IDs (single query)
 * 6. Translations for ALL resolved plan IDs (single query)
 * 7. Variants for ALL input line variantIds (single query, join products)
 *
 * @throws FlexiblePricingError(LOCATION_NOT_FOUND) si la location n'existe pas,
 *   est supprimée, ou n'appartient pas à l'organisation.
 */
export async function loadPricingContext(
  db: DatabaseClient,
  input: QuoteFlexiblePricingInput,
): Promise<PricingContext> {
  // 1. Charger la location.
  const locationRows = await db
    .select({
      id: locations.id,
      organizationId: locations.organizationId,
      operatingCurrency: locations.operatingCurrency,
      timeZone: locations.timeZone,
      deletedAt: locations.deletedAt,
    })
    .from(locations)
    .where(eq(locations.id, input.locationId))
    .limit(1);

  if (locationRows.length === 0 || locationRows[0]!.deletedAt !== null) {
    throw new FlexiblePricingError(
      'LOCATION_NOT_FOUND',
      `Location introuvable ou supprimée : ${input.locationId}`,
    );
  }

  const location = locationRows[0]!;

  // 2. Fail-closed : vérifier l'organisation sans leak d'information.
  if (location.organizationId !== input.organizationId) {
    throw new FlexiblePricingError(
      'LOCATION_NOT_FOUND',
      `Location introuvable : ${input.locationId}`,
    );
  }

  // 3. Charger les horaires d'ouverture.
  const openingHourRows = await db
    .select({
      weekday: locationOpeningHours.weekday,
      openTime: locationOpeningHours.openTime,
      closeTime: locationOpeningHours.closeTime,
    })
    .from(locationOpeningHours)
    .where(eq(locationOpeningHours.locationId, input.locationId));

  const openingHours: OpeningHour[] = openingHourRows.map((r) => ({
    weekday: r.weekday,
    openTime: typeof r.openTime === 'string' ? r.openTime : String(r.openTime),
    closeTime: typeof r.closeTime === 'string' ? r.closeTime : String(r.closeTime),
  }));

  // 4. Appeler resolve_effective_pricing_plans(locationId).
  const planRows = await db.execute<{
    id: string;
    organization_id: string;
    product_variant_id: string;
    location_id: string | null;
    plan_type: 'HOURLY' | 'FIXED_DURATION' | 'DAILY';
    currency: string;
    price_amount_minor: string | number;
    min_duration_minutes: number | null;
    max_duration_minutes: number | null;
    billing_increment_minutes: number | null;
    included_duration_minutes: number | null;
    internal_label: string | null;
    priority: number;
    lifecycle_state: string;
    version: number;
  }>(sql`SELECT * FROM resolve_effective_pricing_plans(${input.locationId}::uuid)`);

  const plans: ResolvedPlan[] = [];
  const planIds: string[] = [];
  for (const row of planRows) {
    const plan: ResolvedPlan = {
      id: row.id,
      organizationId: row.organization_id,
      productVariantId: row.product_variant_id,
      locationId: row.location_id,
      planType: row.plan_type,
      currency: row.currency,
      priceAmountMinor:
        typeof row.price_amount_minor === 'string'
          ? parseInt(row.price_amount_minor, 10)
          : row.price_amount_minor,
      minDurationMinutes: row.min_duration_minutes,
      maxDurationMinutes: row.max_duration_minutes,
      billingIncrementMinutes: row.billing_increment_minutes,
      includedDurationMinutes: row.included_duration_minutes,
      internalLabel: row.internal_label,
      priority: row.priority,
      version: row.version,
    };
    plans.push(plan);
    planIds.push(plan.id);
  }

  // Si aucun plan, on peut retourner tôt (les autres requêtes seraient vides).
  // On exécute quand même les requêtes pour cohérence (elles retournent vide).

  // 5. Charger les fenêtres pour tous les plan IDs (batched).
  const windowRows =
    planIds.length > 0
      ? await db
          .select({
            pricingPlanId: pricingPlanWindows.pricingPlanId,
            weekdayMask: pricingPlanWindows.weekdayMask,
            startTime: pricingPlanWindows.startTime,
            endTime: pricingPlanWindows.endTime,
          })
          .from(pricingPlanWindows)
          .where(inArray(pricingPlanWindows.pricingPlanId, planIds))
      : [];

  const windows: ResolvedWindow[] = windowRows.map((r) => ({
    pricingPlanId: r.pricingPlanId,
    weekdayMask: r.weekdayMask,
    startTime: typeof r.startTime === 'string' ? r.startTime : String(r.startTime),
    endTime: typeof r.endTime === 'string' ? r.endTime : String(r.endTime),
  }));

  // 6. Charger les paliers pour tous les plan IDs (batched).
  const tierRows =
    planIds.length > 0
      ? await db
          .select({
            pricingPlanId: multiDayDiscountTiers.pricingPlanId,
            thresholdDays: multiDayDiscountTiers.thresholdDays,
            discountPercent: multiDayDiscountTiers.discountPercent,
          })
          .from(multiDayDiscountTiers)
          .where(inArray(multiDayDiscountTiers.pricingPlanId, planIds))
      : [];

  const tiers: ResolvedTier[] = tierRows.map((r) => ({
    pricingPlanId: r.pricingPlanId,
    thresholdDays: r.thresholdDays,
    discountPercent: r.discountPercent,
  }));

  // 7. Charger les traductions pour tous les plan IDs (batched).
  const translationRows =
    planIds.length > 0
      ? await db
          .select({
            pricingPlanId: pricingPlanTranslations.pricingPlanId,
            locale: pricingPlanTranslations.locale,
            publicLabel: pricingPlanTranslations.publicLabel,
          })
          .from(pricingPlanTranslations)
          .where(inArray(pricingPlanTranslations.pricingPlanId, planIds))
      : [];

  const translations: ResolvedTranslation[] = translationRows.map((r) => ({
    pricingPlanId: r.pricingPlanId,
    locale: r.locale,
    publicLabel: r.publicLabel,
  }));

  // 8. Charger les variantes pour tous les line variantIds (batched, join products).
  const variantIds = input.lines.map((l) => l.variantId);
  const variantRows =
    variantIds.length > 0
      ? await db
          .select({
            variantId: productVariants.id,
            productId: productVariants.productId,
            organizationId: products.organizationId,
          })
          .from(productVariants)
          .innerJoin(products, eq(productVariants.productId, products.id))
          .where(inArray(productVariants.id, variantIds))
      : [];

  const variants = new Map<string, { productId: string; organizationId: string }>();
  for (const r of variantRows) {
    variants.set(r.variantId, {
      productId: r.productId,
      organizationId: r.organizationId,
    });
  }

  return {
    organizationId: input.organizationId,
    locationId: input.locationId,
    currency: location.operatingCurrency,
    timeZone: location.timeZone,
    intent: resolveIntent(input.intent, location.timeZone),
    plans,
    windows,
    tiers,
    translations,
    openingHours,
    variants,
    lines: input.lines,
    locale: input.locale,
  };
}

/**
 * Convertit un {@link FlexiblePricingIntent} (chaînes locales pour TIME_RANGE)
 * en un {@link ResolvedFlexiblePricingIntent} (instants UTC `Date` pour
 * TIME_RANGE) en utilisant le fuseau IANA du lieu.
 *
 * G7P-B2-C Round 3 (P0-1) : l'entrée du client est en heure locale du lieu
 * de location. Le moteur de pricing travaille sur des instants UTC absolus.
 * La conversion a lieu ici, à la frontière entre l'entrée et le contexte
 * interne du moteur.
 *
 * @throws FlexiblePricingError(VALIDATION) si la conversion local → UTC échoue
 *   (heure inexistante, heure ambiguë, format invalide, fuseau invalide).
 */
function resolveIntent(
  intent: QuoteFlexiblePricingInput['intent'],
  timeZone: string,
): ResolvedFlexiblePricingIntent {
  if (intent.kind === 'TIME_RANGE') {
    try {
      return {
        kind: 'TIME_RANGE',
        startAt: localDateTimeStringToUtc(intent.startAt, timeZone),
        endAt: localDateTimeStringToUtc(intent.endAt, timeZone),
      };
    } catch (err) {
      throw new FlexiblePricingError(
        'VALIDATION',
        err instanceof Error ? err.message : 'Conversion local → UTC invalide pour TIME_RANGE',
      );
    }
  }
  return intent;
}
