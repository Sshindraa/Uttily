import { type ReactElement } from 'react';
import Link from 'next/link';
import {
  getOrganizationById,
  getOrganizationOnboardingReadiness,
  resolveUnifiedOnboardingProgress,
} from '@uttily/core';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import styles from './onboarding.module.css';

export default async function UnifiedOnboardingPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<ReactElement> {
  const { orgId } = await params;
  const { db, organizationId } = await requireFulfillmentOperatorOf(orgId);
  const org = await getOrganizationById(db, organizationId);
  const readiness = await getOrganizationOnboardingReadiness(db, organizationId);
  const progress = resolveUnifiedOnboardingProgress(organizationId, readiness);

  // Si tout est complété, page de succès / Moment Wow
  if (progress.isReadyForReservations) {
    return (
      <main className={styles.container}>
        <div className={styles.successCard}>
          <span style={{ fontSize: '3rem' }}>🎉</span>
          <h1 className={styles.successTitle}>Votre boutique Uttily est prête !</h1>
          <p className={styles.successSubtitle}>
            Toutes les étapes d'activation sont validées. Votre premier vélo est en ligne et vous
            pouvez recevoir des réservations réelles.
          </p>

          <div className={styles.wowDetails}>
            <div className={styles.wowItem}>
              <span className={styles.wowIcon}>🏢</span>
              <div>
                <strong>Activité & Boutique</strong>
                <p>{org?.legalName ?? 'Organisation'} • Point de retrait configuré</p>
              </div>
            </div>
            {progress.firstBike.name && (
              <div className={styles.wowItem}>
                <span className={styles.wowIcon}>🚲</span>
                <div>
                  <strong>{progress.firstBike.name}</strong>
                  <p>
                    3 photos certifiées • Tarif actif • {progress.firstBike.inventoryCount} vélo(s)
                    en stock
                  </p>
                </div>
              </div>
            )}
            <div className={styles.wowItem}>
              <span className={styles.wowIcon}>💳</span>
              <div>
                <strong>Revenus & Versements</strong>
                <p>Compte bancaire professionnel connecté</p>
              </div>
            </div>
          </div>

          <Link href={`/dashboard/${organizationId}`} className={styles.primaryCtaBtn}>
            Accéder à mon Tableau de Bord →
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.container}>
      <header className={styles.header}>
        <Link href={`/dashboard/${organizationId}`} className={styles.backLink}>
          ← Retour au tableau de bord
        </Link>
        <h1 className={styles.title}>Créer ma boutique Uttily</h1>
        <p className={styles.subtitle}>
          Configuration initiale de votre espace loueur en 4 étapes simples.
        </p>
      </header>

      {/* Stepper horizontal visuel */}
      <nav aria-label="Progression de l'onboarding" className={styles.stepperNav}>
        <div className={styles.stepperTrack}>
          {progress.steps.map((step, idx) => {
            const isCurrent = progress.currentStep?.key === step.key;

            return (
              <div key={step.key} className={styles.stepNode}>
                <div
                  className={`${styles.stepCircle} ${
                    step.completed
                      ? styles.stepCircleDone
                      : isCurrent
                        ? styles.stepCircleCurrent
                        : styles.stepCirclePending
                  }`}
                >
                  {step.completed ? '✓' : step.num}
                </div>
                <span
                  className={`${styles.stepLabel} ${
                    step.completed ? styles.stepLabelDone : isCurrent ? styles.stepLabelCurrent : ''
                  }`}
                >
                  {step.shortLabel}
                </span>
                {idx < progress.steps.length - 1 && (
                  <div
                    className={`${styles.stepConnector} ${
                      step.completed ? styles.stepConnectorDone : ''
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </nav>

      {/* Carte d'action courante */}
      <section className={styles.currentStepCard} aria-labelledby="current-step-title">
        {progress.currentStep && (
          <>
            <div className={styles.cardTop}>
              <span className={styles.stepBadge}>
                Étape {progress.currentStep.num} sur {progress.totalCount}
              </span>
              <h2 id="current-step-title" className={styles.stepTitle}>
                {progress.currentStep.label}
              </h2>
              <p className={styles.stepDesc}>{progress.currentStep.description}</p>
            </div>

            {progress.currentStep.key === 'FIRST_BIKE' && progress.firstBike.name && (
              <div className={styles.firstBikeHighlight}>
                <span style={{ fontSize: '1.5rem' }}>🚲</span>
                <div>
                  <strong>{progress.firstBike.name}</strong>
                  <p style={{ margin: '2px 0 0 0', fontSize: '0.85rem', color: '#0369a1' }}>
                    {progress.firstBike.photosCount}/3 photos •{' '}
                    {progress.firstBike.hasPrice ? 'Tarif OK' : 'Tarif à définir'} •{' '}
                    {progress.firstBike.inventoryCount} vélo(s)
                  </p>
                </div>
              </div>
            )}

            <div className={styles.ctaRow}>
              <Link href={progress.currentStep.href} className={styles.primaryCtaBtn}>
                {progress.primaryCta.label}
              </Link>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
