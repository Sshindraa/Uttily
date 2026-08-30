'use server';

import { revalidatePath } from 'next/cache';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { runAction } from '@/lib/action-mapper';
import { isValidUuid } from '@/lib/validation';
import {
  saveDailyPricingPlanDraft,
  activateDailyPricingPlan,
  MVP_ORGANIZATION_CURRENCY,
  type PricingPlanSummary,
  type SaveDailyPricingPlanDraftInput,
} from '@uttily/core';
import type { ActionResult } from '@uttily/contracts';

interface ParsedPricingDraft {
  input: SaveDailyPricingPlanDraftInput;
  productId: string;
}

interface ParsedFailure {
  fieldErrors: Record<string, string>;
}

// Le moteur public et Stripe sont EUR-only au MVP (ADR-009 / ADR-018).
const MVP_PRICING_CURRENCY = MVP_ORGANIZATION_CURRENCY;

function parsePricingDraft(formData: FormData): ParsedFailure | ParsedPricingDraft {
  const fieldErrors: Record<string, string> = {};
  const productId = String(formData.get('productId') ?? '');
  const variantId = String(formData.get('variantId') ?? '');
  const dailyPriceEurosRaw = String(formData.get('dailyPriceEuros') ?? '').trim();
  const internalLabel = String(formData.get('internalLabel') ?? '').trim() || undefined;
  const currency = String(formData.get('currency') ?? MVP_PRICING_CURRENCY)
    .trim()
    .toUpperCase();

  if (!isValidUuid(productId)) fieldErrors.productId = 'Produit invalide.';
  if (!isValidUuid(variantId)) fieldErrors.variantId = 'Variante invalide.';
  if (currency !== MVP_PRICING_CURRENCY) {
    fieldErrors.currency = `La devise ${MVP_PRICING_CURRENCY} est la seule devise prise en charge au MVP.`;
  }

  const dailyPriceEuros = parseFloat(dailyPriceEurosRaw.replace(',', '.'));
  if (isNaN(dailyPriceEuros) || dailyPriceEuros <= 0) {
    fieldErrors.dailyPriceEuros = 'Veuillez saisir un tarif journalier supérieur à 0 €.';
  }

  // Paliers de réduction multi-jours (par exemple 3j et 7j)
  const discountTiers: Array<{ thresholdDays: number; discountPercent: number }> = [];

  const tier3DiscountPercentRaw = String(formData.get('tier3DiscountPercent') ?? '').trim();
  if (tier3DiscountPercentRaw) {
    const p3 = parseInt(tier3DiscountPercentRaw, 10);
    if (!isNaN(p3) && p3 > 0 && p3 < 100) {
      discountTiers.push({ thresholdDays: 3, discountPercent: p3 });
    }
  }

  const tier7DiscountPercentRaw = String(formData.get('tier7DiscountPercent') ?? '').trim();
  if (tier7DiscountPercentRaw) {
    const p7 = parseInt(tier7DiscountPercentRaw, 10);
    if (!isNaN(p7) && p7 > 0 && p7 < 100) {
      discountTiers.push({ thresholdDays: 7, discountPercent: p7 });
    }
  }

  const tier14DiscountPercentRaw = String(formData.get('tier14DiscountPercent') ?? '').trim();
  if (tier14DiscountPercentRaw) {
    const p14 = parseInt(tier14DiscountPercentRaw, 10);
    if (!isNaN(p14) && p14 > 0 && p14 < 100) {
      discountTiers.push({ thresholdDays: 14, discountPercent: p14 });
    }
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const priceAmountMinor = Math.round(dailyPriceEuros * 100);

  return {
    productId,
    input: {
      organizationId: '',
      variantId,
      currency,
      priceAmountMinor,
      internalLabel,
      discountTiers: discountTiers.length > 0 ? discountTiers : undefined,
    },
  };
}

export async function saveDailyPricingPlanDraftAction(
  organizationId: string,
  _prev: ActionResult<PricingPlanSummary>,
  formData: FormData,
): Promise<ActionResult<PricingPlanSummary>> {
  const parsed = parsePricingDraft(formData);
  if ('fieldErrors' in parsed) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs du formulaire tarifaire.',
      fieldErrors: parsed.fieldErrors,
    };
  }

  return runAction(async () => {
    const { db, organizationId: authorizedOrgId } = await requireCatalogManagerOf(organizationId);
    const plan = await saveDailyPricingPlanDraft(db, {
      ...parsed.input,
      organizationId: authorizedOrgId,
    });

    revalidatePath(`/dashboard/${authorizedOrgId}/catalog/${parsed.productId}`);
    revalidatePath(
      `/dashboard/${authorizedOrgId}/catalog/${parsed.productId}/variants/${parsed.input.variantId}`,
    );
    revalidatePath(
      `/dashboard/${authorizedOrgId}/catalog/${parsed.productId}/variants/${parsed.input.variantId}/pricing`,
    );
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${parsed.productId}`);
    return plan;
  });
}

export async function activateDailyPricingPlanAction(
  organizationId: string,
  _prev: ActionResult<PricingPlanSummary>,
  formData: FormData,
): Promise<ActionResult<PricingPlanSummary>> {
  const pricingPlanId = String(formData.get('pricingPlanId') ?? '');
  const productId = String(formData.get('productId') ?? '');
  const variantId = String(formData.get('variantId') ?? '');

  if (!isValidUuid(pricingPlanId)) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Identifiant de plan tarifaire invalide.',
    };
  }

  return runAction(async () => {
    const { db, organizationId: authorizedOrgId } = await requireCatalogManagerOf(organizationId);
    const plan = await activateDailyPricingPlan(db, authorizedOrgId, pricingPlanId);

    if (productId) {
      revalidatePath(`/dashboard/${authorizedOrgId}/catalog/${productId}`);
      if (variantId) {
        revalidatePath(`/dashboard/${authorizedOrgId}/catalog/${productId}/variants/${variantId}`);
        revalidatePath(
          `/dashboard/${authorizedOrgId}/catalog/${productId}/variants/${variantId}/pricing`,
        );
      }
      revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
      revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${productId}`);
    }
    return plan;
  });
}
