import { type ReactElement } from 'react';
import Link from 'next/link';
import { Icon } from '@uttily/ui';
import type { ProfessionalVerificationResult } from '@uttily/core';
import styles from './professional-verification-card.module.css';

interface ProfessionalVerificationCardProps {
  verification: ProfessionalVerificationResult;
  orgId?: string;
}

const labels: Record<keyof ProfessionalVerificationResult['criteria'], string> = {
  professionalProfile: 'Informations professionnelles',
  publicLocation: 'Établissement public',
  stripeAccount: 'Compte de paiement opérationnel',
};

const criteriaLinks: Record<
  keyof ProfessionalVerificationResult['criteria'],
  { path: string; label: string }
> = {
  professionalProfile: { path: 'settings', label: 'Compléter' },
  publicLocation: { path: 'locations', label: 'Ajouter' },
  stripeAccount: { path: 'finances', label: 'Configurer' },
};

export function ProfessionalVerificationCard({
  verification,
  orgId,
}: ProfessionalVerificationCardProps): ReactElement {
  const isEligible = verification.status === 'eligible';
  const isIneligible = verification.status === 'ineligible';

  const title = isEligible
    ? 'Loueur professionnel vérifié'
    : isIneligible
      ? 'Vérification professionnelle indisponible'
      : 'Vérification professionnelle en attente';

  return (
    <section className={styles.card} aria-labelledby="professional-verification-title">
      <div className={styles.header}>
        <div className={styles.headerTitleGroup}>
          <p className={styles.eyebrow}>Confiance publique & visibilité</p>
          <h2 id="professional-verification-title" className={styles.title}>
            <span
              className={`${styles.titleShield} ${
                isEligible ? styles.titleShieldEligible : styles.titleShieldPending
              }`}
              aria-hidden="true"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </span>
            {title}
          </h2>
        </div>
        <span className={`${styles.status} ${styles[verification.status]}`}>
          {isEligible ? 'Actif' : isIneligible ? 'À corriger' : 'En attente'}
        </span>
      </div>

      <p className={styles.description}>
        {isEligible
          ? 'Votre statut professionnel est certifié. Le badge de confiance est affiché sur vos annonces pour rassurer les clients.'
          : 'Le badge public sera activé sur vos annonces dès que tous les critères vérifiables ci-dessous seront réunis.'}
      </p>

      <ul className={styles.criteria} aria-label="Critères de vérification professionnelle">
        {(Object.keys(labels) as Array<keyof typeof labels>).map((key) => {
          const complete = verification.criteria[key];
          const linkInfo = criteriaLinks[key];

          return (
            <li
              key={key}
              className={`${styles.criterionItem} ${complete ? styles.complete : styles.missing}`}
            >
              <div className={styles.criterionLeft}>
                <span
                  className={`${styles.criterionIcon} ${
                    complete ? styles.criterionIconComplete : styles.criterionIconPending
                  }`}
                  aria-hidden="true"
                >
                  {complete ? <Icon name="check" size={13} /> : null}
                </span>
                <span className={styles.criterionLabel}>{labels[key]}</span>
              </div>

              <div className={styles.criterionRight}>
                {complete ? (
                  <span className={styles.badgeDone}>Validé</span>
                ) : orgId ? (
                  <Link
                    href={`/dashboard/${orgId}/${linkInfo.path}`}
                    className={styles.criterionLink}
                  >
                    {linkInfo.label} →
                  </Link>
                ) : (
                  <span className={styles.badgePending}>À compléter</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/* CTA contextuel : priorité au compte Stripe pour débloquer les réservations et le badge */}
      {!verification.criteria.stripeAccount && orgId && (
        <div className={styles.ctaBox}>
          <div className={styles.ctaTextGroup}>
            <p className={styles.ctaTitle}>Activez vos versements et le badge vérifié</p>
            <p className={styles.ctaDescription}>
              Connectez votre compte Stripe pour recevoir vos paiements de location et certifier
              votre boutique auprès des clients.
            </p>
          </div>
          <Link href={`/dashboard/${orgId}/finances`} className={styles.primaryCta}>
            <span>Connecter vos versements bancaires (Stripe)</span>
            <Icon name="arrow-right" size={16} />
          </Link>
        </div>
      )}

      {/* Si Stripe est validé mais qu'il manque l'établissement public */}
      {verification.criteria.stripeAccount && !verification.criteria.publicLocation && orgId && (
        <div className={styles.ctaBox}>
          <div className={styles.ctaTextGroup}>
            <p className={styles.ctaTitle}>Renseignez votre établissement public</p>
            <p className={styles.ctaDescription}>
              Ajoutez l’adresse de retrait de vos équipements pour valider la présence physique de
              votre boutique.
            </p>
          </div>
          <Link href={`/dashboard/${orgId}/locations`} className={styles.primaryCta}>
            <span>Ajouter un établissement public</span>
            <Icon name="arrow-right" size={16} />
          </Link>
        </div>
      )}

      <div className={styles.footer}>
        <p className={styles.audit}>
          Vérification continue · Mis à jour le{' '}
          {verification.evaluatedAt.toLocaleDateString('fr-FR')}
        </p>
      </div>
    </section>
  );
}
