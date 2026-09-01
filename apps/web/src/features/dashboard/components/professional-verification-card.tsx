import { type ReactElement } from 'react';
import type { ProfessionalVerificationResult } from '@uttily/core';
import styles from './professional-verification-card.module.css';

interface ProfessionalVerificationCardProps {
  verification: ProfessionalVerificationResult;
}

const labels: Record<keyof ProfessionalVerificationResult['criteria'], string> = {
  professionalProfile: 'Informations professionnelles',
  publicLocation: 'Établissement public',
  stripeAccount: 'Compte de paiement opérationnel',
};

export function ProfessionalVerificationCard({
  verification,
}: ProfessionalVerificationCardProps): ReactElement {
  const title =
    verification.status === 'eligible'
      ? 'Loueur professionnel vérifié'
      : verification.status === 'ineligible'
        ? 'Vérification professionnelle indisponible'
        : 'Vérification professionnelle en attente';

  return (
    <section className={styles.card} aria-labelledby="professional-verification-title">
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Confiance publique</p>
          <h2 id="professional-verification-title" className={styles.title}>
            {verification.status === 'eligible' ? '✓ ' : '○ '}
            {title}
          </h2>
        </div>
        <span className={`${styles.status} ${styles[verification.status]}`}>
          {verification.status === 'eligible'
            ? 'Actif'
            : verification.status === 'ineligible'
              ? 'À corriger'
              : 'En attente'}
        </span>
      </div>

      <p className={styles.description}>
        {verification.status === 'eligible'
          ? 'Le badge public est autorisé tant que ces critères restent satisfaits.'
          : 'Le badge public reste masqué tant que tous les critères vérifiables ne sont pas réunis.'}
      </p>

      <ul className={styles.criteria} aria-label="Critères de vérification professionnelle">
        {(Object.keys(labels) as Array<keyof typeof labels>).map((key) => {
          const complete = verification.criteria[key];
          return (
            <li key={key} className={complete ? styles.complete : styles.missing}>
              <span aria-hidden="true">{complete ? '✓' : '○'}</span>
              <span>{labels[key]}</span>
            </li>
          );
        })}
      </ul>

      <p className={styles.audit}>
        Calcul serveur {verification.algorithmVersion} · évalué le{' '}
        {verification.evaluatedAt.toLocaleDateString('fr-FR')}
      </p>
    </section>
  );
}
