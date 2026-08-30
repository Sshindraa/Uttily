'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  saveDailyPricingPlanDraftAction,
  activateDailyPricingPlanAction,
} from '@/app/actions/pricing';
import { formatMoneyAmount } from '@/lib/status-presentation';
import styles from './components.module.css';

interface PricingDrawerProps {
  organizationId: string;
  productId: string;
  variantId: string;
  currentPriceEuros: number | null;
  currency: string;
  currentTiers?: Array<{ thresholdDays: number; discountPercent: number }> | undefined;
}

export function PricingDrawer({
  organizationId,
  productId,
  variantId,
  currentPriceEuros,
  currency,
  currentTiers = [],
}: PricingDrawerProps): React.ReactElement {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [dailyPrice, setDailyPrice] = useState<string>(
    currentPriceEuros !== null ? String(currentPriceEuros) : '',
  );

  const initialTier3 = currentTiers?.find((t) => t.thresholdDays === 3)?.discountPercent ?? 10;
  const initialTier7 = currentTiers?.find((t) => t.thresholdDays === 7)?.discountPercent ?? 20;
  const initialTier14 = currentTiers?.find((t) => t.thresholdDays === 14)?.discountPercent ?? 30;

  const [tier3Percent, setTier3Percent] = useState<string>(String(initialTier3));
  const [tier7Percent, setTier7Percent] = useState<string>(String(initialTier7));
  const [tier14Percent, setTier14Percent] = useState<string>(String(initialTier14));

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedDailyPrice = parseFloat(dailyPrice.replace(',', '.')) || 0;
  const p3 = parseInt(tier3Percent, 10) || 0;
  const p7 = parseInt(tier7Percent, 10) || 0;
  const p14 = parseInt(tier14Percent, 10) || 0;

  async function handleSaveAndActivate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      // 1. Sauvegarde le brouillon
      const saveFormData = new FormData();
      saveFormData.set('productId', productId);
      saveFormData.set('variantId', variantId);
      saveFormData.set('dailyPriceEuros', dailyPrice);
      saveFormData.set('currency', currency);
      saveFormData.set(
        'internalLabel',
        `Tarif journalier ${formatMoneyAmount(Math.round(parsedDailyPrice * 100), currency)}`,
      );
      if (p3 > 0) saveFormData.set('tier3DiscountPercent', String(p3));
      if (p7 > 0) saveFormData.set('tier7DiscountPercent', String(p7));
      if (p14 > 0) saveFormData.set('tier14DiscountPercent', String(p14));

      const saveRes = await saveDailyPricingPlanDraftAction(
        organizationId,
        { ok: false, code: 'UNKNOWN', message: '' },
        saveFormData,
      );

      if (!saveRes.ok) {
        throw new Error(saveRes.message || 'Erreur lors de la sauvegarde du plan tarifaire.');
      }

      // 2. Active immédiatement le plan
      const activateFormData = new FormData();
      activateFormData.set('pricingPlanId', saveRes.data.id);
      activateFormData.set('productId', productId);
      activateFormData.set('variantId', variantId);

      const activateRes = await activateDailyPricingPlanAction(
        organizationId,
        { ok: false, code: 'UNKNOWN', message: '' },
        activateFormData,
      );

      if (!activateRes.ok) {
        throw new Error(activateRes.message || 'Erreur lors de l’activation du plan tarifaire.');
      }

      setIsOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue.');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
      >
        ✏️ Modifier le tarif
      </button>

      {isOpen && (
        <div className={styles.drawerOverlay} onClick={() => !isLoading && setIsOpen(false)}>
          <div
            className={styles.drawerContent}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pricing-drawer-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.drawerHeader}>
              <h3 id="pricing-drawer-title" className={styles.drawerTitle}>
                🏷️ Définir la tarification
              </h3>
              <button
                type="button"
                onClick={() => !isLoading && setIsOpen(false)}
                className={styles.closeBtn}
                disabled={isLoading}
                aria-label="Fermer"
              >
                ✕
              </button>
            </div>

            <form
              onSubmit={handleSaveAndActivate}
              style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
            >
              {error && (
                <div
                  style={{
                    padding: '10px',
                    background: 'var(--ut-color-danger-soft)',
                    border: '1px solid var(--ut-color-danger-soft)',
                    color: 'var(--ut-color-danger)',
                    borderRadius: '8px',
                    fontSize: '0.85rem',
                  }}
                >
                  {error}
                </div>
              )}

              <div className={styles.formGroup}>
                <label htmlFor="daily-price" className={styles.formLabel}>
                  Prix de base à la journée (TTC, {currency}) :
                </label>
                <input
                  id="daily-price"
                  type="text"
                  value={dailyPrice}
                  onChange={(e) => setDailyPrice(e.target.value)}
                  className={styles.inputField}
                  placeholder="ex: 25.00"
                  required
                  disabled={isLoading}
                />
              </div>

              {/* Aperçu en direct */}
              <div
                style={{
                  background: 'var(--ut-color-success-soft)',
                  border: '1px solid var(--ut-color-success-soft)',
                  padding: '14px',
                  borderRadius: '10px',
                }}
              >
                <div
                  style={{
                    fontWeight: 800,
                    color: 'var(--ut-color-success-strong)',
                    fontSize: '0.9rem',
                  }}
                >
                  Aperçu de votre offre :
                </div>
                <div
                  style={{
                    fontSize: '1.25rem',
                    fontWeight: 900,
                    color: 'var(--ut-color-ink-strong)',
                    marginTop: '4px',
                  }}
                >
                  {formatMoneyAmount(Math.round(parsedDailyPrice * 100), currency)}{' '}
                  <span
                    style={{
                      fontSize: '0.85rem',
                      fontWeight: 600,
                      color: 'var(--ut-color-ink-muted)',
                    }}
                  >
                    / jour
                  </span>
                </div>
              </div>

              {/* Remises dégressives */}
              <div
                style={{
                  borderTop: '1px solid var(--ut-color-border)',
                  paddingTop: '12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                }}
              >
                <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--ut-color-ink)' }}>
                  Remises longue durée (optionnelles) :
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '10px',
                    alignItems: 'center',
                  }}
                >
                  <label
                    htmlFor="tier-3"
                    style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}
                  >
                    Dès 3 jours (% remise) :
                  </label>
                  <input
                    id="tier-3"
                    type="number"
                    min="0"
                    max="99"
                    value={tier3Percent}
                    onChange={(e) => setTier3Percent(e.target.value)}
                    className={styles.inputField}
                    disabled={isLoading}
                  />
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '10px',
                    alignItems: 'center',
                  }}
                >
                  <label
                    htmlFor="tier-7"
                    style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}
                  >
                    Dès 7 jours (% remise) :
                  </label>
                  <input
                    id="tier-7"
                    type="number"
                    min="0"
                    max="99"
                    value={tier7Percent}
                    onChange={(e) => setTier7Percent(e.target.value)}
                    className={styles.inputField}
                    disabled={isLoading}
                  />
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '10px',
                    alignItems: 'center',
                  }}
                >
                  <label
                    htmlFor="tier-14"
                    style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}
                  >
                    Dès 14 jours (% remise) :
                  </label>
                  <input
                    id="tier-14"
                    type="number"
                    min="0"
                    max="99"
                    value={tier14Percent}
                    onChange={(e) => setTier14Percent(e.target.value)}
                    className={styles.inputField}
                    disabled={isLoading}
                  />
                </div>
              </div>

              <div className={styles.drawerFooter}>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  disabled={isLoading}
                  className={styles.actionBtn}
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={isLoading}
                  className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
                >
                  {isLoading ? 'Activation en cours…' : 'Enregistrer et activer le tarif'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
