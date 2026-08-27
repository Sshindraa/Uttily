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
  // Mode exploitation à 100 % (toutes les étapes sont complétées)
  if (readiness.isReadyForReservations) {
    return (
      <section className={styles.healthCard} aria-labelledby="health-bar-title">
        <div>
          <h2
            id="health-bar-title"
            style={{ margin: '0 0 4px 0', fontSize: '1.15rem', color: '#166534' }}
          >
            🚀 Votre boutique est en ligne et opérationnelle
          </h2>
          <p style={{ margin: 0, fontSize: '0.88rem', color: '#15803d' }}>
            Prête à recevoir des réservations en temps réel.
          </p>
        </div>

        <div className={styles.healthBadges}>
          <span className={styles.healthBadge}>
            <span style={{ color: '#10b981' }}>●</span> Boutique active
          </span>
          <span className={styles.healthBadge}>
            <span style={{ color: '#10b981' }}>●</span> Versements bancaires activés
          </span>
          <span className={styles.healthBadge}>
            <span style={{ color: '#10b981' }}>●</span> Tarifs & Flotte prêts
          </span>
        </div>
      </section>
    );
  }

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
          title: '7. Recevoir mes virements',
          ctaLabel: 'Activer mes virements',
          href: `/dashboard/${orgId}/finances`,
        };
    }
  };

  // Identifie le premier jalon incomplet pour le mettre en valeur
  const firstIncompleteIndex = readiness.milestones.findIndex((m) => !m.completed);

  return (
    <section className={styles.card} aria-labelledby="readiness-card-title">
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <h2 id="readiness-card-title" className={styles.title}>
            <span>⚡</span> Votre boutique est prête à {readiness.percentage} %
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
          className={styles.progressBarFill}
          style={{ width: `${Math.max(readiness.percentage, 5)}%` }}
        />
      </div>

      {/* Message clé si la configuration (1 à 6) est terminée mais que les virements manquent */}
      {readiness.isConfigurationComplete && !readiness.isReadyForReservations && (
        <div className={styles.celebrationBanner}>
          <div className={styles.celebrationTitle}>🎉 Votre configuration est terminée !</div>
          <div className={styles.celebrationText}>
            Votre offre est prête à être publiée. Activez vos versements pour recevoir l’argent de
            vos premières réservations.
          </div>
        </div>
      )}

      {/* Liste des 7 jalons */}
      <ul className={styles.milestonesList} aria-label="Jalons de préparation de la boutique">
        {readiness.milestones.map((milestone, idx) => {
          const info = getMilestoneInfo(milestone);
          const isCurrentActiveStep = idx === firstIncompleteIndex;
          const isLastStep = milestone.key === 'PAYMENTS' && readiness.completedCount === 6;

          return (
            <li
              key={milestone.key}
              className={`${styles.milestoneItem} ${
                milestone.completed
                  ? styles.milestoneItemDone
                  : isCurrentActiveStep
                    ? styles.milestoneItemActive
                    : ''
              }`}
            >
              <div className={styles.milestoneLeft}>
                {milestone.completed ? (
                  <span className={styles.iconDone} aria-label="Complété">
                    ✓
                  </span>
                ) : isCurrentActiveStep ? (
                  <span className={styles.iconActive} aria-label="Étape en cours">
                    ●
                  </span>
                ) : (
                  <span className={styles.iconPending} aria-label="À compléter">
                    ○
                  </span>
                )}

                <div className={styles.milestoneTitleWrap}>
                  <span
                    className={`${styles.milestoneLabel} ${
                      milestone.completed ? styles.milestoneLabelDone : ''
                    }`}
                  >
                    {info.title}
                  </span>
                  {isCurrentActiveStep && !milestone.completed && (
                    <span className={styles.badgeActiveStep}>
                      {isLastStep ? '★ Dernière étape requise' : '👉 Étape recommandée'}
                    </span>
                  )}
                </div>
              </div>

              {!milestone.completed && (
                <Link
                  href={info.href}
                  className={
                    isCurrentActiveStep ? styles.actionBtnPrimary : styles.actionBtnSecondary
                  }
                >
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
