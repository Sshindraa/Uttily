import { type ReactElement } from 'react';
import Link from 'next/link';
import {
  type OrganizationOnboardingReadiness,
  resolveUnifiedOnboardingProgress,
} from '@uttily/core';
import styles from './onboarding-readiness-card.module.css';

interface OnboardingReadinessCardProps {
  orgId: string;
  readiness: OrganizationOnboardingReadiness;
}

export function OnboardingReadinessCard({
  orgId,
  readiness,
}: OnboardingReadinessCardProps): ReactElement | null {
  const progress = resolveUnifiedOnboardingProgress(orgId, readiness);

  // Mode exploitation à 100 % (toutes les étapes sont complétées)
  if (progress.isReadyForReservations) {
    return (
      <section className={styles.healthCard} aria-labelledby="health-bar-title">
        <div>
          <h2
            id="health-bar-title"
            style={{
              margin: '0 0 4px 0',
              fontSize: '1.2rem',
              fontWeight: 800,
              color: 'var(--ut-color-success-strong)',
            }}
          >
            🚀 Votre boutique est active & en ligne
          </h2>
          <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--ut-color-success)' }}>
            Prête à recevoir des réservations réelles en temps réel.
          </p>
        </div>

        <div className={styles.healthBadges}>
          <span className={styles.healthBadge}>
            <span style={{ color: 'var(--ut-color-success)' }}>●</span> Boutique active
          </span>
          <span className={styles.healthBadge}>
            <span style={{ color: 'var(--ut-color-success)' }}>●</span> Versements bancaires activés
          </span>
          <span className={styles.healthBadge}>
            <span style={{ color: 'var(--ut-color-success)' }}>●</span> Flotte & Tarifs en ligne
          </span>
          <Link href={`/dashboard/${orgId}/bikes`} className={styles.actionBtnPrimary}>
            Voir mes équipements en ligne →
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.card} aria-labelledby="readiness-card-title">
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <h2 id="readiness-card-title" className={styles.title}>
            <span>⚡</span> Créer ma boutique Uttily
          </h2>
          <p className={styles.subtitle}>
            {progress.completedCount} sur {progress.totalCount} étapes complétées pour ouvrir votre
            boutique.
          </p>
        </div>

        <div className={styles.percentBadge}>
          {progress.percentage} % • Étape {progress.currentStepNum}/{progress.totalCount}
        </div>
      </div>

      {/* Barre de progression des 4 grandes étapes */}
      <div className={styles.progressBarContainer}>
        <div
          className={`${styles.progressBarFill} ${
            progress.percentage === 100 ? styles.progressBarComplete : ''
          }`}
          style={{ width: `${Math.max(progress.percentage, 8)}%` }}
        />
      </div>

      {/* Moment Clé : Quand l'activité, la boutique et le premier équipement sont prêts et qu'il ne reste que les virements */}
      {progress.isConfigurationComplete && !progress.isReadyForReservations && (
        <div className={styles.celebrationBanner}>
          <div className={styles.celebrationTitle}>🎉 Votre premier équipement est prêt !</div>
          <div className={styles.celebrationText}>
            {progress.firstBike.name ? <strong>{progress.firstBike.name} : </strong> : null}
            {progress.firstBike.photosCount}/3 photos ✓ • Tarif configuré ✓ •{' '}
            {progress.firstBike.inventoryCount} exemplaire(s) en flotte ✓.
          </div>
          <div style={{ marginTop: '8px', fontSize: '0.9rem' }}>
            Une dernière étape pour commencer à louer : activez vos virements bancaires.
          </div>
        </div>
      )}

      {/* Grille des 4 étapes unifiées */}
      <ul className={styles.milestonesList} aria-label="Étapes d'ouverture de votre boutique">
        {progress.steps.map((step) => {
          const isActive = progress.currentStep?.key === step.key;

          return (
            <li
              key={step.key}
              className={`${styles.milestoneItem} ${
                step.completed
                  ? styles.milestoneItemDone
                  : isActive
                    ? styles.milestoneItemActive
                    : ''
              }`}
            >
              <div className={styles.milestoneLeft}>
                {step.completed ? (
                  <span className={styles.iconDone}>✓</span>
                ) : isActive ? (
                  <span className={styles.iconActive}>●</span>
                ) : (
                  <span className={styles.iconPending}>○</span>
                )}

                <div className={styles.milestoneTitleWrap}>
                  <div
                    className={`${styles.milestoneLabel} ${
                      step.completed ? styles.milestoneLabelDone : ''
                    }`}
                  >
                    {step.label}
                  </div>
                  <div style={{ fontSize: '0.82rem', color: 'var(--ut-color-ink-muted)' }}>
                    {step.description}
                  </div>
                  {step.key === 'FIRST_BIKE' && progress.firstBike.name && !step.completed && (
                    <div
                      style={{
                        fontSize: '0.78rem',
                        color: 'var(--ut-color-primary)',
                        fontWeight: 700,
                        marginTop: '2px',
                      }}
                    >
                      🧰 {progress.firstBike.name} ({progress.firstBike.photosCount}/3 photos)
                    </div>
                  )}
                </div>
              </div>

              <div>
                {step.completed ? (
                  <Link href={step.href} className={styles.actionBtnSecondary}>
                    Modifier
                  </Link>
                ) : (
                  <Link
                    href={step.href}
                    className={isActive ? styles.actionBtnPrimary : styles.actionBtnSecondary}
                  >
                    {step.ctaLabel} →
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
