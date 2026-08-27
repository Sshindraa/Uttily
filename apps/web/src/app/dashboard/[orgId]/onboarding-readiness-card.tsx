import { type ReactElement } from 'react';
import Link from 'next/link';
import type { OrganizationOnboardingReadiness, ReadinessMilestone } from '@uttily/core';
import styles from './onboarding-readiness-card.module.css';

interface OnboardingReadinessCardProps {
  orgId: string;
  readiness: OrganizationOnboardingReadiness;
}

export function OnboardingReadinessCard({
  orgId,
  readiness,
}: OnboardingReadinessCardProps): ReactElement | null {
  const getMilestoneInfo = (
    milestone: ReadinessMilestone,
  ): { title: string; ctaLabel: string; href: string } => {
    const { key, details } = milestone;

    switch (key) {
      case 'ORGANIZATION':
        return {
          title: '1. Entreprise & Raison sociale',
          ctaLabel: 'Compléter',
          href: `/dashboard/${orgId}/settings`,
        };
      case 'LOCATION':
        return {
          title: '2. Boutique & Point de retrait',
          ctaLabel: 'Configurer',
          href: `/dashboard/${orgId}/locations/new`,
        };
      case 'PRIMARY_PRODUCT':
        return {
          title: '3. Premier vélo au catalogue',
          ctaLabel: 'Ajouter un vélo',
          href: `/dashboard/${orgId}/catalog/new`,
        };
      case 'PHOTOS':
        return {
          title: '4. 3 photos (Photo Coach)',
          ctaLabel: details.productId ? 'Ajouter les photos' : 'Voir le catalogue',
          href: details.productId
            ? `/dashboard/${orgId}/catalog/${details.productId}`
            : `/dashboard/${orgId}/catalog`,
        };
      case 'PRICING':
        return {
          title: '5. Tarification journalière',
          ctaLabel:
            details.productId && details.variantId ? 'Définir le tarif' : 'Voir le catalogue',
          href:
            details.productId && details.variantId
              ? `/dashboard/${orgId}/catalog/${details.productId}/variants/${details.variantId}/pricing`
              : `/dashboard/${orgId}/catalog`,
        };
      case 'INVENTORY':
        return {
          title: '6. Flotte physique disponible',
          ctaLabel: 'Ajouter mes vélos',
          href: `/dashboard/${orgId}/inventory/new`,
        };
      case 'PAYMENTS':
        return {
          title: '7. Paiements Stripe Connect',
          ctaLabel: 'Activer les virements',
          href: `/dashboard/${orgId}/settings/payments`,
        };
    }
  };

  return (
    <section className={styles.card} aria-labelledby="readiness-card-title">
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <h2 id="readiness-card-title" className={styles.title}>
            {readiness.isReadyForReservations
              ? '🎉 Votre boutique est prête pour les réservations !'
              : `Votre boutique est prête à ${readiness.percentage} %`}
          </h2>
          <p className={styles.subtitle}>
            {readiness.completedCount} sur {readiness.totalCount} étapes terminées pour publier
            votre offre.
          </p>
        </div>

        <div className={styles.percentBadge}>
          {readiness.percentage} % • {readiness.completedCount}/{readiness.totalCount}
        </div>
      </div>

      <div className={styles.progressBarContainer}>
        <div
          className={`${styles.progressBarFill} ${
            readiness.isReadyForReservations ? styles.progressBarComplete : ''
          }`}
          style={{ width: `${Math.max(readiness.percentage, 5)}%` }}
        />
      </div>

      {/* Message clé si l'annonce est configurée mais que Stripe manque */}
      {readiness.isConfigurationComplete && !readiness.isReadyForReservations && (
        <div className={styles.celebrationBanner}>
          <div className={styles.celebrationTitle}>🎉 Votre annonce est prête !</div>
          <div>
            Une dernière étape pour recevoir vos réservations : connectez votre compte bancaire avec
            Stripe pour activer les paiements.
          </div>
        </div>
      )}

      {/* Liste des 7 jalons */}
      <ul className={styles.milestonesList} aria-label="Jalons de préparation de la boutique">
        {readiness.milestones.map((milestone) => {
          const info = getMilestoneInfo(milestone);

          return (
            <li
              key={milestone.key}
              className={`${styles.milestoneItem} ${
                milestone.completed ? styles.milestoneItemDone : ''
              }`}
            >
              <div className={styles.milestoneLeft}>
                {milestone.completed ? (
                  <span className={styles.iconDone} aria-label="Complété">
                    ✓
                  </span>
                ) : (
                  <span className={styles.iconPending} aria-label="À compléter">
                    ○
                  </span>
                )}
                <span
                  className={`${styles.milestoneLabel} ${
                    milestone.completed ? styles.milestoneLabelDone : ''
                  }`}
                >
                  {info.title}
                </span>
              </div>

              {!milestone.completed && (
                <Link href={info.href} className={styles.actionLink}>
                  {info.ctaLabel} →
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
