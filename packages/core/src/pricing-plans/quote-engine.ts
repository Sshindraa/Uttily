/**
 * @uttily/core — Module Pricing Plans (G7P-B1).
 *
 * Moteur de calcul PUR — aucune dépendance base de données, aucune écriture,
 * aucun Date.now(), aucun random, aucun float pour les montants.
 * Same input + same plans = byte-for-byte equivalent result.
 */

import type {
  Candidate,
  PricingContext,
  PricingWindowSnapshot,
  QuoteFlexiblePricingResult,
  QuoteLine,
  QuoteLineDaily,
  QuoteLineFixedDuration,
  QuoteLineHourly,
  SelectedWindow,
} from './types';
import { FlexiblePricingError } from './errors';
import { safeAdd } from './safe-arithmetic';
import { isWithinOpeningHours } from './opening-hours';
import { generateCandidates } from './candidate-generator';
import { calculateAmount } from './amount-calculator';
import { validateGrid } from './grid-validator';
import { selectBestCandidate } from './selector';
import { getTranslation, resolveLocale } from './locale-resolver';

/**
 * Calcule un devis à partir d'un contexte de pricing entièrement résolu.
 *
 * Étapes :
 * 1. Valider l'intent
 * 2. Valider la locale
 * 3. Vérifier les horaires d'ouverture
 * 4. Pour chaque ligne :
 *    a. Trouver la variante → VARIANT_NOT_FOUND si absente
 *    b. Vérifier org variante = context.organizationId → PRODUCT_NOT_ELIGIBLE
 *    c. Générer les candidats
 *    d. Calculer les montants
 *    e. Valider la grille
 *    f. Sélectionner le meilleur candidat
 *    g. Résoudre le libellé de locale
 * 5. Calculer le subtotal = safeAdd de tous les lineTotalAmountMinor
 * 6. total = subtotal (pas de taxe, commission ni frais en B1)
 * 7. Trier les lignes par variantId
 * 8. Retourner le résultat
 *
 * @throws FlexiblePricingError pour toute erreur métier.
 */
export function computeQuote(context: PricingContext): QuoteFlexiblePricingResult {
  // 1. Valider l'intent.
  validateIntent(context.intent);

  // 2. Valider la locale — collecter les locales disponibles depuis les traductions.
  const availableLocales = collectAvailableLocales(context.translations);
  const resolvedLocale = resolveLocale(context.locale, availableLocales);

  // 3. Vérifier les horaires d'ouverture.
  isWithinOpeningHours(context.intent, context.timeZone, context.openingHours);

  // 4. Traiter chaque ligne.
  const quoteLines: QuoteLine[] = [];

  for (const line of context.lines) {
    // 4a. Trouver la variante.
    const variant = context.variants.get(line.variantId);
    if (!variant) {
      throw new FlexiblePricingError(
        'VARIANT_NOT_FOUND',
        `Variante introuvable : ${line.variantId}`,
      );
    }

    // 4b. Vérifier l'organisation.
    if (variant.organizationId !== context.organizationId) {
      throw new FlexiblePricingError(
        'PRODUCT_NOT_ELIGIBLE',
        `Variante ${line.variantId} n'appartient pas à l'organisation ${context.organizationId}`,
      );
    }

    // 4c. Générer les candidats.
    let candidates = generateCandidates(line.variantId, line.quantity, context);

    if (candidates.length === 0) {
      throw new FlexiblePricingError(
        'NO_ELIGIBLE_PLAN',
        `Aucun plan éligible pour la variante ${line.variantId}`,
      );
    }

    // 4d. Calculer les montants.
    candidates = candidates.map((c) => calculateAmount(c, context.tiers));

    // 4e. Valider la grille.
    validateGrid(candidates);

    // 4f. Sélectionner le meilleur candidat.
    const best = selectBestCandidate(candidates);

    // 4g. Résoudre le libellé.
    const publicLabel = getTranslation(best.plan.id, resolvedLocale, context.translations);

    // Construire la QuoteLine selon le type de plan.
    quoteLines.push(buildQuoteLine(best, publicLabel));
  }

  // 7. Trier les lignes par variantId.
  quoteLines.sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0));

  // 5. Calculer le subtotal.
  let subtotal = 0;
  for (const line of quoteLines) {
    subtotal = safeAdd(subtotal, line.lineTotalAmountMinor);
  }

  // 6. total = subtotal (pas de taxe, commission ni frais en B1).
  const total = subtotal;

  return {
    algorithmVersion: 'flexible-pricing-v1',
    roundingRuleVersion: 'half-up-v1',
    organizationId: context.organizationId,
    locationId: context.locationId,
    currency: context.currency,
    timeZone: context.timeZone,
    intent: context.intent,
    lines: quoteLines,
    subtotalAmountMinor: subtotal,
    totalAmountMinor: total,
    resolvedLocale,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function validateIntent(intent: PricingContext['intent']): void {
  if (intent.kind === 'TIME_RANGE') {
    if (!(intent.endAt.getTime() > intent.startAt.getTime())) {
      throw new FlexiblePricingError(
        'VALIDATION',
        'TIME_RANGE: endAt doit être strictement postérieur à startAt',
      );
    }
  } else {
    if (!intent.startDate || !intent.endDateExclusive) {
      throw new FlexiblePricingError(
        'VALIDATION',
        'DAY_RANGE: startDate et endDateExclusive sont requis',
      );
    }
    // countCivilDays valide que endDateExclusive > startDate.
  }
}

function collectAvailableLocales(translations: PricingContext['translations']): string[] {
  const locales = new Set<string>();
  for (const t of translations) {
    locales.add(t.locale);
  }
  return [...locales];
}

function buildQuoteLine(candidate: Candidate, publicLabel: string): QuoteLine {
  const base = {
    variantId: candidate.variantId,
    quantity: candidate.quantity,
    pricingPlanId: candidate.plan.id,
    planVersion: candidate.plan.version,
    publicLabel,
    unitPriceAmountMinor: candidate.plan.priceAmountMinor,
    requestedDurationMinutes: candidate.requestedDurationMinutes,
    selectedWindow: candidate.selectedWindow,
    lineTotalAmountMinor: candidate.lineTotalAmountMinor,
    billableUnitCount: candidate.billableUnitCount,
  };

  switch (candidate.plan.planType) {
    case 'HOURLY':
      const hourly: QuoteLineHourly = {
        ...base,
        planType: 'HOURLY',
        billedDurationMinutes: candidate.billedDurationMinutes!,
        coveredDurationMinutes: null,
        billedDays: null,
        discountThresholdDays: null,
        discountPercent: null,
        amountBeforeDiscountMinor: null,
        amountAfterDiscountMinor: null,
        windowSnapshot: buildTimeRangeWindowSnapshot(candidate.selectedWindow),
      };
      return hourly;

    case 'FIXED_DURATION':
      const fixed: QuoteLineFixedDuration = {
        ...base,
        planType: 'FIXED_DURATION',
        billedDurationMinutes: null,
        coveredDurationMinutes: candidate.coveredDurationMinutes!,
        billedDays: null,
        discountThresholdDays: null,
        discountPercent: null,
        amountBeforeDiscountMinor: null,
        amountAfterDiscountMinor: null,
        windowSnapshot: buildTimeRangeWindowSnapshot(candidate.selectedWindow),
      };
      return fixed;

    case 'DAILY':
      const daily: QuoteLineDaily = {
        ...base,
        planType: 'DAILY',
        billedDurationMinutes: null,
        coveredDurationMinutes: null,
        billedDays: candidate.billedDays!,
        discountThresholdDays: candidate.discountThresholdDays,
        discountPercent: candidate.discountPercent,
        amountBeforeDiscountMinor: candidate.amountBeforeDiscountMinor!,
        amountAfterDiscountMinor: candidate.amountAfterDiscountMinor!,
        dayRangeBoundaries: candidate.dayRangeBoundaries,
        windowSnapshot: buildDailyWindowSnapshot(candidate),
      };
      return daily;
  }
}

/**
 * Construit un snapshot TIME_RANGE_WINDOW à partir d'une SelectedWindow.
 * Retourne null si la fenêtre est absente (pas de fenêtre sélectionnée).
 */
function buildTimeRangeWindowSnapshot(
  selectedWindow: SelectedWindow | null,
): PricingWindowSnapshot | null {
  if (selectedWindow === null) return null;
  return {
    kind: 'TIME_RANGE_WINDOW',
    weekdayMask: selectedWindow.weekdayMask,
    startTime: selectedWindow.startTime,
    endTime: selectedWindow.endTime,
  };
}

/**
 * Construit le snapshot de fenêtre pour un candidat DAILY.
 * - DAY_RANGE : DAY_RANGE_BOUNDARIES si dayRangeBoundaries est non-null.
 * - TIME_RANGE : TIME_RANGE_WINDOW si selectedWindow est non-null.
 * - Sinon : null.
 */
function buildDailyWindowSnapshot(candidate: Candidate): PricingWindowSnapshot | null {
  if (candidate.dayRangeBoundaries !== null) {
    return {
      kind: 'DAY_RANGE_BOUNDARIES',
      firstDay: {
        localDate: candidate.dayRangeBoundaries.firstDay.localDate,
        weekdayMask: candidate.dayRangeBoundaries.firstDay.weekdayMask,
        startTime: candidate.dayRangeBoundaries.firstDay.startTime,
        endTime: candidate.dayRangeBoundaries.firstDay.endTime,
      },
      lastDay: {
        localDate: candidate.dayRangeBoundaries.lastDay.localDate,
        weekdayMask: candidate.dayRangeBoundaries.lastDay.weekdayMask,
        startTime: candidate.dayRangeBoundaries.lastDay.startTime,
        endTime: candidate.dayRangeBoundaries.lastDay.endTime,
      },
    };
  }
  return buildTimeRangeWindowSnapshot(candidate.selectedWindow);
}
