'use client';

import type { RankedPackCandidate, SolvedPackCandidate, SolvedPackAlternatives } from '@uttily/core';
import styles from './pack-alternatives-section.module.css';

export interface PackAlternativesSectionProps {
  readonly locale: 'fr' | 'en';
  readonly alternatives?: SolvedPackAlternatives | null | undefined;
  readonly repairedPack?: RankedPackCandidate<SolvedPackCandidate> | null | undefined;
  readonly onSelectRepairedPack?: ((pack: RankedPackCandidate<SolvedPackCandidate>) => void) | undefined;
  readonly onShiftDate?: ((daysOffset: number) => void) | undefined;
  readonly currentSearchParams?: string | undefined;
}

export function PackAlternativesSection({
  locale,
  alternatives,
  repairedPack,
  onSelectRepairedPack,
  onShiftDate,
  currentSearchParams = '',
}: PackAlternativesSectionProps): React.ReactElement {
  const fr = locale === 'fr';

  const handleSpecificDateClick = (specificDateIso?: string) => {
    if (onShiftDate && !specificDateIso) {
      onShiftDate(1);
      return;
    }
    const params = new URLSearchParams(currentSearchParams);
    let targetDate = specificDateIso;
    if (!targetDate) {
      const startStr = params.get('startDate') || params.get('startAt');
      if (startStr) {
        const d = new Date(startStr.includes('T') ? startStr : `${startStr}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        targetDate = d.toISOString().slice(0, 10);
      }
    }

    if (targetDate) {
      if (params.has('startDate')) {
        params.set('startDate', targetDate);
        const endStr = params.get('endDateExclusive');
        if (endStr) {
          const dEnd = new Date(endStr.includes('T') ? endStr : `${endStr}T12:00:00Z`);
          dEnd.setUTCDate(dEnd.getUTCDate() + 1);
          params.set('endDateExclusive', dEnd.toISOString().slice(0, 10));
        }
      }
      if (params.has('startAt')) {
        params.set('startAt', `${targetDate}T08:00`);
      }
      window.location.search = params.toString();
    }
  };

  const handleAfternoonSlotClick = () => {
    const params = new URLSearchParams(currentSearchParams);
    params.set('intent', 'TIME_RANGE');
    const start =
      params.get('startDate') ||
      params.get('startAt')?.slice(0, 10) ||
      new Date().toISOString().slice(0, 10);
    params.set('startAt', `${start}T14:00`);
    params.set('endAt', `${start}T19:00`);
    params.delete('startDate');
    params.delete('endDateExclusive');
    window.location.search = params.toString();
  };

  // Résolution dynamique des cartes viables
  const equipmentAlt =
    alternatives?.equipmentAlternative ||
    (repairedPack && repairedPack.candidate.repairs.length > 0
      ? {
          candidate: repairedPack,
          titleFr: 'Substitution homologuée',
          titleEn: 'Approved substitution',
          descriptionFr:
            repairedPack.candidate.repairs[0]?.explanationFr ||
            'Matériel équivalent homologué par le Graphe de Compatibilité',
          descriptionEn:
            repairedPack.candidate.repairs[0]?.explanationEn ||
            'Equivalent equipment approved by the Compatibility Graph',
          ctaLabelFr: 'Choisir cette solution →',
          ctaLabelEn: 'Choose this solution →',
        }
      : null);

  const timeShiftAlt = alternatives?.timeShiftAlternative || null;
  const dateShiftAlt = alternatives?.dateShiftAlternative || null;

  const hasAnyAlternative = Boolean(equipmentAlt || timeShiftAlt || dateShiftAlt);

  if (!hasAnyAlternative) {
    return (
      <section className={styles.compactNoticeSection} aria-labelledby="alternatives-heading">
        <h3 id="alternatives-heading" className={styles.compactNoticeTitle}>
          {fr
            ? 'Aucune correspondance exacte pour ce créneau'
            : 'No exact match for this specific slot'}
        </h3>
        <p className={styles.compactNoticeSubtitle}>
          {fr
            ? 'Aucun loueur unique ne dispose de l’ensemble de vos équipements pour ces dates. Retrouvez ci-dessous les offres disponibles à l’unité :'
            : 'No single shop has all requested items for these dates. Explore the offers available individually below:'}
        </p>
      </section>
    );
  }

  return (
    <section className={styles.container} aria-labelledby="alternatives-heading">
      <div className={styles.header}>
        <div className={styles.eyebrow}>
          {fr ? 'Adaptations intelligentes' : 'Smart alternatives'}
        </div>
        <h3 id="alternatives-heading" className={styles.title}>
          {fr
            ? 'Aucune correspondance exacte pour ce créneau'
            : 'No exact match for this specific slot'}
        </h3>
        <p className={styles.subtitle}>
          {fr
            ? 'Mais nous pouvons rendre votre sortie possible :'
            : 'However, we can make your outing possible:'}
        </p>
      </div>

      <div className={styles.cardsGrid}>
        {/* Alternative 1: Matériel alternatif (si substitution réelle trouvée) */}
        {equipmentAlt && (
          <div className={styles.alternativeCard}>
            <div className={styles.cardTop}>
              <span className={`${styles.badge} ${styles.badgeMaterial}`}>
                🔄 {fr ? 'Même jour · Matériel alternatif' : 'Same day · Alternative gear'}
              </span>
              <h4 className={styles.cardTitle}>
                {fr ? equipmentAlt.titleFr : equipmentAlt.titleEn}
              </h4>
              <p className={styles.cardDescription}>
                {fr ? equipmentAlt.descriptionFr : equipmentAlt.descriptionEn}
              </p>
            </div>
            <button
              type="button"
              className={styles.actionBtn}
              onClick={() => onSelectRepairedPack?.(equipmentAlt.candidate)}
            >
              {fr ? equipmentAlt.ctaLabelFr : equipmentAlt.ctaLabelEn}
            </button>
          </div>
        )}

        {/* Alternative 2: Autre horaire (si créneau 14h-19h vérifié disponible en base) */}
        {timeShiftAlt && (
          <div className={styles.alternativeCard}>
            <div className={styles.cardTop}>
              <span className={`${styles.badge} ${styles.badgeTime}`}>
                🕒 {fr ? 'Même matériel · Autre horaire' : 'Same gear · Other time'}
              </span>
              <h4 className={styles.cardTitle}>
                {fr ? timeShiftAlt.titleFr : timeShiftAlt.titleEn}
              </h4>
              <p className={styles.cardDescription}>
                {fr ? timeShiftAlt.descriptionFr : timeShiftAlt.descriptionEn}
              </p>
            </div>
            <button
              type="button"
              className={styles.actionBtn}
              onClick={handleAfternoonSlotClick}
            >
              {fr ? timeShiftAlt.ctaLabelFr : timeShiftAlt.ctaLabelEn}
            </button>
          </div>
        )}

        {/* Alternative 3: Lendemain (si date J+1 vérifiée disponible en base) */}
        {dateShiftAlt && (
          <div className={styles.alternativeCard}>
            <div className={styles.cardTop}>
              <span className={`${styles.badge} ${styles.badgeDate}`}>
                📅 {fr ? 'Correspondance exacte · Lendemain' : 'Exact match · Next day'}
              </span>
              <h4 className={styles.cardTitle}>
                {fr ? dateShiftAlt.titleFr : dateShiftAlt.titleEn}
              </h4>
              <p className={styles.cardDescription}>
                {fr ? dateShiftAlt.descriptionFr : dateShiftAlt.descriptionEn}
              </p>
            </div>
            <button
              type="button"
              className={styles.actionBtn}
              onClick={() => handleSpecificDateClick(dateShiftAlt.dateIso)}
            >
              {fr ? dateShiftAlt.ctaLabelFr : dateShiftAlt.ctaLabelEn}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
