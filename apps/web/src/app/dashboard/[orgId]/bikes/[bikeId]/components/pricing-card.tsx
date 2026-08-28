import type { UnifiedBike } from '@uttily/core';
import { formatMoneyAmount } from '@/lib/status-presentation';
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
  const priceEuros = activePlan ? activePlan.priceAmountMinor / 100 : null;
  const displayCurrency = activePlan?.currency ?? currency;

  return (
    <section className={styles.card} aria-labelledby="pricing-title">
      <div className={styles.cardHeader}>
        <h2 id="pricing-title" className={styles.cardTitle}>
          <span>🏷️</span> Tarification journalière & remises
        </h2>
        <PricingDrawer
          organizationId={organizationId}
          productId={productId}
          variantId={variantId}
          currentPriceEuros={priceEuros}
          currency={displayCurrency}
          currentTiers={activePlan?.discountTiers}
        />
      </div>

      {pricing.isPriced && activePlan ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div className={styles.pricingDisplay}>
            <span className={styles.pricingBig}>
              {formatMoneyAmount(activePlan.priceAmountMinor, displayCurrency)}
            </span>
            <span className={styles.pricingUnit}>/ jour (TTC)</span>
          </div>

          {activePlan.discountTiers && activePlan.discountTiers.length > 0 ? (
            <div>
              <div
                style={{
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  color: '#64748b',
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
            <p style={{ margin: 0, fontSize: '0.88rem', color: '#64748b' }}>
              Tarif unique sans palier de remise.
            </p>
          )}
        </div>
      ) : (
        <div
          style={{
            padding: '16px',
            background: '#fffbeb',
            border: '1px solid #fde68a',
            borderRadius: '12px',
          }}
        >
          <strong style={{ color: '#b45309', fontSize: '0.9rem' }}>⚠️ Aucun tarif actif</strong>
          <p style={{ margin: '4px 0 0 0', fontSize: '0.85rem', color: '#92400e' }}>
            Ce vélo ne peut pas être proposé à la réservation tant qu’un prix journalier n’est pas
            défini.
          </p>
        </div>
      )}
    </section>
  );
}
