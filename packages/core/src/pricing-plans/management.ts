import { and, eq, isNull, sql, inArray, desc } from 'drizzle-orm';
import type { DatabaseClient, DbExecutor } from '@uttily/database';
import {
  pricingPlans,
  pricingPlanTranslations,
  multiDayDiscountTiers,
  productVariants,
  products,
} from '@uttily/database';
import { FlexiblePricingError } from './errors';

export interface DiscountTierSummary {
  id: string;
  thresholdDays: number;
  discountPercent: number;
}

export interface PricingPlanSummary {
  id: string;
  organizationId: string;
  productVariantId: string;
  locationId: string | null;
  planType: 'DAILY' | 'HOURLY' | 'FIXED_DURATION';
  currency: string;
  priceAmountMinor: number;
  internalLabel: string | null;
  lifecycleState: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  version: number;
  discountTiers: DiscountTierSummary[];
  translations: Array<{ locale: string; publicLabel: string }>;
  createdAt: Date;
  updatedAt: Date;
}

export interface VariantPricingOverview {
  activePlan: PricingPlanSummary | null;
  draftPlan: PricingPlanSummary | null;
  retiredPlansCount: number;
}

export interface SaveDailyPricingPlanDraftInput {
  organizationId: string;
  variantId: string;
  locationId?: string | null | undefined;
  priceAmountMinor: number;
  currency?: string | undefined;
  internalLabel?: string | null | undefined;
  discountTiers?: Array<{ thresholdDays: number; discountPercent: number }> | undefined;
  translations?: Array<{ locale: string; publicLabel: string }> | undefined;
}

/**
 * Récupère la vue d'ensemble tarifaire d'une variante : plan actif, brouillon et historique.
 */
export async function getVariantPricingSummary(
  db: DatabaseClient,
  organizationId: string,
  variantId: string,
): Promise<VariantPricingOverview> {
  // Vérifie que la variante appartient bien à l'organisation
  const [variant] = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(productVariants.id, variantId),
        eq(products.organizationId, organizationId),
        isNull(productVariants.deletedAt),
        isNull(products.deletedAt),
      ),
    )
    .limit(1);

  if (!variant) {
    throw new FlexiblePricingError(
      'VARIANT_NOT_FOUND',
      'Variante introuvable ou non autorisée pour cette organisation.',
    );
  }

  const planRows = await db
    .select()
    .from(pricingPlans)
    .where(
      and(
        eq(pricingPlans.organizationId, organizationId),
        eq(pricingPlans.productVariantId, variantId),
      ),
    )
    .orderBy(desc(pricingPlans.version), desc(pricingPlans.createdAt));

  if (planRows.length === 0) {
    return {
      activePlan: null,
      draftPlan: null,
      retiredPlansCount: 0,
    };
  }

  const planIds = planRows.map((p) => p.id);

  // Charge les tiers et traductions en batch
  const tierRows = await db
    .select()
    .from(multiDayDiscountTiers)
    .where(
      and(
        inArray(multiDayDiscountTiers.pricingPlanId, planIds),
        eq(multiDayDiscountTiers.active, true),
      ),
    );

  const transRows = await db
    .select()
    .from(pricingPlanTranslations)
    .where(inArray(pricingPlanTranslations.pricingPlanId, planIds));

  const buildPlanSummary = (row: (typeof planRows)[number]): PricingPlanSummary => {
    const tiers = tierRows
      .filter((t) => t.pricingPlanId === row.id)
      .map((t) => ({
        id: t.id,
        thresholdDays: t.thresholdDays,
        discountPercent: t.discountPercent,
      }))
      .sort((a, b) => a.thresholdDays - b.thresholdDays);

    const translations = transRows
      .filter((tr) => tr.pricingPlanId === row.id)
      .map((tr) => ({
        locale: tr.locale,
        publicLabel: tr.publicLabel,
      }));

    return {
      id: row.id,
      organizationId: row.organizationId,
      productVariantId: row.productVariantId,
      locationId: row.locationId ?? null,
      planType: row.planType as 'DAILY' | 'HOURLY' | 'FIXED_DURATION',
      currency: row.currency,
      priceAmountMinor: Number(row.priceAmountMinor),
      internalLabel: row.internalLabel ?? null,
      lifecycleState: row.lifecycleState as 'DRAFT' | 'ACTIVE' | 'RETIRED',
      version: row.version,
      discountTiers: tiers,
      translations,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  };

  const activeRow = planRows.find((p) => p.lifecycleState === 'ACTIVE');
  const draftRow = planRows.find((p) => p.lifecycleState === 'DRAFT');
  const retiredPlansCount = planRows.filter((p) => p.lifecycleState === 'RETIRED').length;

  return {
    activePlan: activeRow ? buildPlanSummary(activeRow) : null,
    draftPlan: draftRow ? buildPlanSummary(draftRow) : null,
    retiredPlansCount,
  };
}

/**
 * Crée ou remplace un plan journalier en DRAFT pour une variante.
 */
export async function saveDailyPricingPlanDraft(
  db: DatabaseClient,
  input: SaveDailyPricingPlanDraftInput,
): Promise<PricingPlanSummary> {
  const currency = (input.currency ?? 'EUR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new FlexiblePricingError('VALIDATION', 'La devise doit être un code ISO à 3 lettres.');
  }

  if (
    !Number.isInteger(input.priceAmountMinor) ||
    input.priceAmountMinor <= 0 ||
    input.priceAmountMinor > 9007199254740991
  ) {
    throw new FlexiblePricingError(
      'VALIDATION',
      'Le montant du prix journalier doit être un entier strictement positif en unités mineures.',
    );
  }

  // Valide les paliers de réduction multi-jours
  if (input.discountTiers && input.discountTiers.length > 0) {
    const seenThresholds = new Set<number>();
    for (const tier of input.discountTiers) {
      if (tier.thresholdDays < 2) {
        throw new FlexiblePricingError(
          'VALIDATION',
          'Le seuil d’un palier multi-jours doit être d’au moins 2 jours.',
        );
      }
      if (tier.discountPercent <= 0 || tier.discountPercent >= 100) {
        throw new FlexiblePricingError(
          'VALIDATION',
          'Le pourcentage de réduction d’un palier doit être compris entre 1 % et 99 %.',
        );
      }
      if (seenThresholds.has(tier.thresholdDays)) {
        throw new FlexiblePricingError(
          'VALIDATION',
          `Palier en double pour le seuil de ${tier.thresholdDays} jours.`,
        );
      }
      seenThresholds.add(tier.thresholdDays);
    }
  }

  return await db.transaction(async (tx: DbExecutor) => {
    // 1. Vérifie la variante
    const [variant] = await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(
        and(
          eq(productVariants.id, input.variantId),
          eq(products.organizationId, input.organizationId),
          isNull(productVariants.deletedAt),
          isNull(products.deletedAt),
        ),
      )
      .limit(1);

    if (!variant) {
      throw new FlexiblePricingError(
        'VARIANT_NOT_FOUND',
        'Variante introuvable ou non autorisée pour cette organisation.',
      );
    }

    const locationId = input.locationId ?? null;

    // 2. Recherche la version max existante pour cette clé métier
    const locCondition = locationId
      ? eq(pricingPlans.locationId, locationId)
      : isNull(pricingPlans.locationId);

    const [maxVersionRow] = await tx
      .select({ maxVer: sql<number>`COALESCE(MAX(${pricingPlans.version}), 0)::integer` })
      .from(pricingPlans)
      .where(
        and(
          eq(pricingPlans.organizationId, input.organizationId),
          eq(pricingPlans.productVariantId, input.variantId),
          locCondition,
          eq(pricingPlans.planType, 'DAILY'),
          eq(pricingPlans.currency, currency),
        ),
      );

    const nextVersion = (maxVersionRow?.maxVer ?? 0) + 1;

    // 3. Supprime tout brouillon DRAFT existant pour cette même clé
    const existingDrafts = await tx
      .select({ id: pricingPlans.id })
      .from(pricingPlans)
      .where(
        and(
          eq(pricingPlans.organizationId, input.organizationId),
          eq(pricingPlans.productVariantId, input.variantId),
          locCondition,
          eq(pricingPlans.planType, 'DAILY'),
          eq(pricingPlans.currency, currency),
          eq(pricingPlans.lifecycleState, 'DRAFT'),
        ),
      );

    if (existingDrafts.length > 0) {
      const draftIds = existingDrafts.map((d) => d.id);
      await tx.delete(pricingPlans).where(inArray(pricingPlans.id, draftIds));
    }

    // 4. Insère le nouveau plan en DRAFT
    const [insertedPlan] = await tx
      .insert(pricingPlans)
      .values({
        organizationId: input.organizationId,
        productVariantId: input.variantId,
        locationId: locationId,
        planType: 'DAILY',
        currency,
        priceAmountMinor: input.priceAmountMinor,
        internalLabel: input.internalLabel?.trim() || null,
        lifecycleState: 'DRAFT',
        version: nextVersion,
        priority: 0,
      })
      .returning();

    if (!insertedPlan) {
      throw new FlexiblePricingError(
        'PRICING_CONFIGURATION_INVALID',
        'Échec de la création du plan tarifaire.',
      );
    }

    // 5. Insère les traductions requises (fr et en)
    const translationsToInsert =
      input.translations && input.translations.length >= 2
        ? input.translations
        : [
            { locale: 'fr', publicLabel: 'Tarif journalier' },
            { locale: 'en', publicLabel: 'Daily rate' },
          ];

    await tx.insert(pricingPlanTranslations).values(
      translationsToInsert.map((tr) => ({
        pricingPlanId: insertedPlan.id,
        locale: tr.locale,
        publicLabel: tr.publicLabel.trim(),
      })),
    );

    // 6. Insère les paliers multi-jours
    if (input.discountTiers && input.discountTiers.length > 0) {
      await tx.insert(multiDayDiscountTiers).values(
        input.discountTiers.map((tier) => ({
          pricingPlanId: insertedPlan.id,
          thresholdDays: tier.thresholdDays,
          discountPercent: tier.discountPercent,
          active: true,
        })),
      );
    }

    return {
      id: insertedPlan.id,
      organizationId: insertedPlan.organizationId,
      productVariantId: insertedPlan.productVariantId,
      locationId: insertedPlan.locationId ?? null,
      planType: insertedPlan.planType as 'DAILY',
      currency: insertedPlan.currency,
      priceAmountMinor: Number(insertedPlan.priceAmountMinor),
      internalLabel: insertedPlan.internalLabel ?? null,
      lifecycleState: 'DRAFT',
      version: insertedPlan.version,
      discountTiers: (input.discountTiers ?? []).map((t, idx) => ({
        id: `tier-${idx}`,
        thresholdDays: t.thresholdDays,
        discountPercent: t.discountPercent,
      })),
      translations: translationsToInsert,
      createdAt: insertedPlan.createdAt,
      updatedAt: insertedPlan.updatedAt,
    };
  });
}

/**
 * Active un plan tarifaire en brouillon (DRAFT -> ACTIVE).
 * Met automatiquement à la retraite (ACTIVE -> RETIRED) l'éventuelle version active précédente.
 */
export async function activateDailyPricingPlan(
  db: DatabaseClient,
  organizationId: string,
  pricingPlanId: string,
): Promise<PricingPlanSummary> {
  return await db.transaction(async (tx: DbExecutor) => {
    // 1. Charge le plan FOR UPDATE
    const [plan] = await tx
      .select()
      .from(pricingPlans)
      .where(
        and(eq(pricingPlans.id, pricingPlanId), eq(pricingPlans.organizationId, organizationId)),
      )
      .for('update')
      .limit(1);

    if (!plan) {
      throw new FlexiblePricingError(
        'PRICING_CONFIGURATION_INVALID',
        'Plan tarifaire introuvable ou non autorisé.',
      );
    }

    if (plan.lifecycleState !== 'DRAFT') {
      throw new FlexiblePricingError(
        'VALIDATION',
        `Seul un plan en brouillon (DRAFT) peut être activé (état actuel : ${plan.lifecycleState}).`,
      );
    }

    // 2. Vérifie la présence des traductions FR et EN non vides
    const translations = await tx
      .select()
      .from(pricingPlanTranslations)
      .where(eq(pricingPlanTranslations.pricingPlanId, plan.id));

    const frTrans = translations.find((t) => t.locale === 'fr');
    const enTrans = translations.find((t) => t.locale === 'en');

    if (!frTrans || !frTrans.publicLabel.trim() || !enTrans || !enTrans.publicLabel.trim()) {
      throw new FlexiblePricingError(
        'VALIDATION',
        'Les libellés publics en français et en anglais sont requis pour activer le plan tarifaire.',
      );
    }

    // 3. Passe les anciens plans actifs correspondants en RETIRED
    const locCondition = plan.locationId
      ? eq(pricingPlans.locationId, plan.locationId)
      : isNull(pricingPlans.locationId);

    await tx
      .update(pricingPlans)
      .set({
        lifecycleState: 'RETIRED',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pricingPlans.organizationId, organizationId),
          eq(pricingPlans.productVariantId, plan.productVariantId),
          locCondition,
          eq(pricingPlans.planType, plan.planType),
          eq(pricingPlans.currency, plan.currency),
          eq(pricingPlans.lifecycleState, 'ACTIVE'),
        ),
      );

    // 4. Active le plan cible
    const [activatedPlan] = await tx
      .update(pricingPlans)
      .set({
        lifecycleState: 'ACTIVE',
        updatedAt: new Date(),
      })
      .where(eq(pricingPlans.id, plan.id))
      .returning();

    if (!activatedPlan) {
      throw new FlexiblePricingError(
        'PRICING_CONFIGURATION_INVALID',
        'Échec de l’activation du plan tarifaire.',
      );
    }

    // 5. Récupère les tiers associés
    const tiers = await tx
      .select()
      .from(multiDayDiscountTiers)
      .where(
        and(
          eq(multiDayDiscountTiers.pricingPlanId, activatedPlan.id),
          eq(multiDayDiscountTiers.active, true),
        ),
      )
      .orderBy(multiDayDiscountTiers.thresholdDays);

    return {
      id: activatedPlan.id,
      organizationId: activatedPlan.organizationId,
      productVariantId: activatedPlan.productVariantId,
      locationId: activatedPlan.locationId ?? null,
      planType: activatedPlan.planType as 'DAILY',
      currency: activatedPlan.currency,
      priceAmountMinor: Number(activatedPlan.priceAmountMinor),
      internalLabel: activatedPlan.internalLabel ?? null,
      lifecycleState: 'ACTIVE',
      version: activatedPlan.version,
      discountTiers: tiers.map((t) => ({
        id: t.id,
        thresholdDays: t.thresholdDays,
        discountPercent: t.discountPercent,
      })),
      translations: translations.map((t) => ({
        locale: t.locale,
        publicLabel: t.publicLabel,
      })),
      createdAt: activatedPlan.createdAt,
      updatedAt: activatedPlan.updatedAt,
    };
  });
}
