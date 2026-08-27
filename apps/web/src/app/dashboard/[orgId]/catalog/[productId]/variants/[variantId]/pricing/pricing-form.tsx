'use client';

import { type ReactElement, useState, useActionState } from 'react';
import type { VariantPricingOverview, PricingPlanSummary } from '@uttily/core';
import type { ActionResult } from '@uttily/contracts';
import {
  saveDailyPricingPlanDraftAction,
  activateDailyPricingPlanAction,
} from '@/app/actions/pricing';
import styles from './pricing.module.css';

interface PricingFormProps {
  orgId: string;
  productId: string;
  variantId: string;
  overview: VariantPricingOverview;
}

type FormState = ActionResult<PricingPlanSummary> | { ok: true; data: null };
const initialFormState: FormState = { ok: true, data: null };

export function PricingForm({
  orgId,
  productId,
  variantId,
  overview,
}: PricingFormProps): ReactElement {
  const currentPlan = overview.draftPlan ?? overview.activePlan;

  const initialPriceEuros = currentPlan ? (currentPlan.priceAmountMinor / 100).toFixed(2) : '';

  const initialTier3 =
    currentPlan?.discountTiers.find((t) => t.thresholdDays === 3)?.discountPercent ?? '';
  const initialTier7 =
    currentPlan?.discountTiers.find((t) => t.thresholdDays === 7)?.discountPercent ?? '';
  const initialTier14 =
    currentPlan?.discountTiers.find((t) => t.thresholdDays === 14)?.discountPercent ?? '';

  const [dailyPriceStr, setDailyPriceStr] = useState(initialPriceEuros);
  const [tier3Percent, setTier3Percent] = useState<number | string>(initialTier3);
  const [tier7Percent, setTier7Percent] = useState<number | string>(initialTier7);
  const [tier14Percent, setTier14Percent] = useState<number | string>(initialTier14);

  const saveActionWithOrg = saveDailyPricingPlanDraftAction.bind(null, orgId);
  const activateActionWithOrg = activateDailyPricingPlanAction.bind(null, orgId);

  const [saveState, saveFormAction, isSaving] = useActionState<FormState, FormData>(
    (prev: FormState, formData: FormData) =>
      saveActionWithOrg(prev as ActionResult<PricingPlanSummary>, formData),
    initialFormState,
  );

  const [activateState, activateFormAction, isActivating] = useActionState<FormState, FormData>(
    (prev: FormState, formData: FormData) =>
      activateActionWithOrg(prev as ActionResult<PricingPlanSummary>, formData),
    initialFormState,
  );

  const dailyPriceNum = parseFloat(dailyPriceStr.replace(',', '.')) || 0;

  const calculateDiscountedPrice = (percent: number | string): string => {
    const p = typeof percent === 'number' ? percent : parseInt(percent, 10);
    if (isNaN(p) || p <= 0 || p >= 100 || dailyPriceNum <= 0) return '—';
    const discounted = dailyPriceNum * (1 - p / 100);
    return `${discounted.toFixed(2)} € / j`;
  };

  const hasDraft = !!overview.draftPlan;
  const isCurrentlyActive = !!overview.activePlan && !overview.draftPlan;

  return (
    <div className={styles.container}>
      {/* Messages de feedback */}
      {saveState.ok && saveState.data !== null && (
        <div className={styles.feedbackSuccess}>
          ✓ Brouillon tarifaire enregistré avec succès. Vous pouvez maintenant l’activer.
        </div>
      )}
      {!saveState.ok && (
        <div className={styles.feedbackError}>
          {saveState.message || 'Une erreur est survenue lors de l’enregistrement.'}
        </div>
      )}
      {activateState.ok && activateState.data !== null && (
        <div className={styles.feedbackSuccess}>
          🎉 Le plan tarifaire est désormais actif et prêt pour les réservations !
        </div>
      )}
      {!activateState.ok && (
        <div className={styles.feedbackError}>
          {activateState.message || 'Une erreur est survenue lors de l’activation.'}
        </div>
      )}

      {/* Formulaire d'édition du tarif */}
      <form action={saveFormAction} className={styles.card}>
        <input type="hidden" name="productId" value={productId} />
        <input type="hidden" name="variantId" value={variantId} />
        <input type="hidden" name="currency" value="EUR" />

        <div className={styles.formGroup}>
          <label htmlFor="dailyPriceEuros" className={styles.label}>
            Prix de base à la journée (obligatoire)
          </label>
          <span className={styles.hint}>
            Tarif appliqué pour une journée complète de location (TTC).
          </span>
          <div className={styles.priceInputRow}>
            <input
              id="dailyPriceEuros"
              name="dailyPriceEuros"
              type="text"
              inputMode="decimal"
              placeholder="25,00"
              required
              className={styles.priceInput}
              value={dailyPriceStr}
              onChange={(e) => setDailyPriceStr(e.target.value)}
            />
            <span className={styles.currencySuffix}>€ / jour</span>
          </div>
        </div>

        {/* Paliers dégressifs */}
        <div className={styles.tierSection}>
          <div>
            <label className={styles.label}>Tarifs dégressifs longue durée (facultatif)</label>
            <span className={styles.hint} style={{ display: 'block' }}>
              Encouragez les locations de moyenne et longue durée en proposant une réduction en
              pourcentage.
            </span>
          </div>

          <div className={styles.tierRow}>
            <span className={styles.tierLabel}>À partir de 3 jours :</span>
            <div className={styles.tierInputWrap}>
              <input
                type="number"
                name="tier3DiscountPercent"
                min={1}
                max={99}
                placeholder="10"
                className={styles.tierInput}
                value={tier3Percent}
                onChange={(e) => setTier3Percent(e.target.value)}
              />
              <span style={{ fontWeight: 600, color: '#475569' }}>%</span>
            </div>
            <span className={styles.tierCalculated}>{calculateDiscountedPrice(tier3Percent)}</span>
          </div>

          <div className={styles.tierRow}>
            <span className={styles.tierLabel}>À partir de 7 jours (semaine) :</span>
            <div className={styles.tierInputWrap}>
              <input
                type="number"
                name="tier7DiscountPercent"
                min={1}
                max={99}
                placeholder="20"
                className={styles.tierInput}
                value={tier7Percent}
                onChange={(e) => setTier7Percent(e.target.value)}
              />
              <span style={{ fontWeight: 600, color: '#475569' }}>%</span>
            </div>
            <span className={styles.tierCalculated}>{calculateDiscountedPrice(tier7Percent)}</span>
          </div>

          <div className={styles.tierRow}>
            <span className={styles.tierLabel}>À partir de 14 jours (2 semaines) :</span>
            <div className={styles.tierInputWrap}>
              <input
                type="number"
                name="tier14DiscountPercent"
                min={1}
                max={99}
                placeholder="30"
                className={styles.tierInput}
                value={tier14Percent}
                onChange={(e) => setTier14Percent(e.target.value)}
              />
              <span style={{ fontWeight: 600, color: '#475569' }}>%</span>
            </div>
            <span className={styles.tierCalculated}>{calculateDiscountedPrice(tier14Percent)}</span>
          </div>
        </div>

        <div className={styles.formGroup}>
          <label htmlFor="internalLabel" className={styles.label}>
            Libellé interne (optionnel)
          </label>
          <input
            id="internalLabel"
            name="internalLabel"
            type="text"
            placeholder="Ex : Grille standard été 2026"
            defaultValue={currentPlan?.internalLabel ?? ''}
            style={{
              padding: '8px 12px',
              borderRadius: '8px',
              border: '1px solid #cbd5e1',
              fontSize: '0.95rem',
            }}
          />
        </div>

        <div className={styles.actionsRow}>
          <button type="submit" disabled={isSaving} className={styles.btnPrimary}>
            {isSaving ? 'Enregistrement…' : 'Enregistrer en brouillon'}
          </button>
        </div>
      </form>

      {/* Bloc d'activation */}
      {hasDraft && overview.draftPlan && (
        <div
          className={styles.card}
          style={{ background: '#f0fdf4', borderColor: '#bbf7d0', marginTop: '8px' }}
        >
          <div>
            <h3 style={{ margin: '0 0 4px 0', color: '#166534', fontSize: '1.1rem' }}>
              Prêt pour l’activation
            </h3>
            <p style={{ margin: 0, color: '#15803d', fontSize: '0.9rem' }}>
              Un brouillon de tarif à{' '}
              <strong>{(overview.draftPlan.priceAmountMinor / 100).toFixed(2)} € / jour</strong> est
              prêt. Cliquez ci-dessous pour le rendre immédiatement actif.
            </p>
          </div>

          <form action={activateFormAction}>
            <input type="hidden" name="pricingPlanId" value={overview.draftPlan.id} />
            <input type="hidden" name="productId" value={productId} />
            <input type="hidden" name="variantId" value={variantId} />
            <button type="submit" disabled={isActivating} className={styles.btnActivate}>
              {isActivating ? 'Activation en cours…' : '🚀 Activer ce tarif maintenant'}
            </button>
          </form>
        </div>
      )}

      {isCurrentlyActive && overview.activePlan && (
        <div style={{ fontSize: '0.85rem', color: '#64748b', textAlign: 'center' }}>
          Ce tarif est actuellement actif (Version {overview.activePlan.version}). Toute
          modification enregistrera une nouvelle version en brouillon sans interrompre le tarif en
          vigueur.
        </div>
      )}
    </div>
  );
}
