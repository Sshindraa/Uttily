import type { UnifiedBike } from '@uttily/core';
import {
  formatMoneyAmount,
  getPricingPlanTypeLabel,
  getPricingPlanUnitLabel,
} from '@/lib/status-presentation';
import { PricingDrawer } from './pricing-drawer';
import styles from './components.module.css';

interface PricingCardProps {
  organizationId: string;
  productId: string;
  variantId: string;
  pricing: UnifiedBike['pricing'];
  currency: string;
}

export function BikePricingCard({
  organizationId,
  productId,
  variantId,
  pricing,
  currency,
}: PricingCardProps): React.ReactElement {
  const activePlan = pricing.activePlan;
  const planForDisplay = activePlan ?? pricing.draftPlan;
  const priceEuros = planForDisplay ? planForDisplay.priceAmountMinor / 100 : null;
  const displayCurrency = planForDisplay?.currency ?? currency;
  const activePlanType = planForDisplay?.planType ?? null;
  const canEditWithDailyEditor = activePlanType === null || activePlanType === 'DAILY';

  return (
    <section className={styles.card} aria-labelledby="pricing-title">
      <div className={styles.cardHeader}>
        <h2 id="pricing-title" className={styles.cardTitle}>
          <span>🏷️</span>{' '}
          {activePlanType ? getPricingPlanTypeLabel(activePlanType) : 'Tarification'}
        </h2>
        {canEditWithDailyEditor ? (
          <PricingDrawer
            organizationId={organizationId}
            productId={productId}
            variantId={variantId}
            currentPriceEuros={priceEuros}
            currency={displayCurrency}
            currentTiers={planForDisplay?.discountTiers}
          />
        ) : null}
      </div>

      {pricing.isPriced && activePlan ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div className={styles.pricingDisplay}>
            <span className={styles.pricingBig}>
              {formatMoneyAmount(activePlan.priceAmountMinor, displayCurrency)}
            </span>
            <span className={styles.pricingUnit}>
              {getPricingPlanUnitLabel(activePlan.planType)} (TTC)
            </span>
          </div>

          {activePlan.planType === 'DAILY' &&
          activePlan.discountTiers &&
          activePlan.discountTiers.length > 0 ? (
            <div>
              <div
                style={{
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  color: 'var(--ut-color-ink-muted)',
                  marginBottom: '6px',
                }}
              >
                Remises longue durée actives :
              </div>
              <div className={styles.tiersList}>
                {activePlan.discountTiers.map((tier) => (
                  <span key={tier.thresholdDays} className={styles.tierBadge}>
                    Dès <strong>{tier.thresholdDays} jours</strong> : -{tier.discountPercent} %
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--ut-color-ink-muted)' }}>
              {activePlan.planType === 'DAILY'
                ? 'Tarif unique sans palier de remise.'
                : 'Ce plan est calculé par le moteur de tarification flexible.'}
            </p>
          )}
          {!canEditWithDailyEditor && (
            <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--ut-color-warning)' }}>
              Cet écran ne modifie que les tarifs journaliers. Le plan actif reste inchangé.
            </p>
          )}
        </div>
      ) : (
        <div
          style={{
            padding: '16px',
            background: 'var(--ut-color-surface)beb',
            border: '1px solid var(--ut-color-warning-soft)',
            borderRadius: '12px',
          }}
        >
          <strong style={{ color: 'var(--ut-color-warning)', fontSize: '0.9rem' }}>
            ⚠️ {pricing.draftPlan ? 'Brouillon tarifaire non activé' : 'Aucun plan tarifaire actif'}
          </strong>
          <p style={{ margin: '4px 0 0 0', fontSize: '0.85rem', color: 'var(--ut-color-warning)' }}>
            {pricing.draftPlan
              ? `Le ${getPricingPlanTypeLabel(pricing.draftPlan.planType).toLowerCase()} doit être activé avant la mise en ligne.`
              : 'Cet équipement ne peut pas être proposé à la réservation tant qu’un plan tarifaire valide n’est pas défini.'}
          </p>
        </div>
      )}
    </section>
  );
}
