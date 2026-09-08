'use client';

import type { RankedPackCandidate, SolvedPackCandidate } from '@uttily/core';
import styles from './pack-solution-card.module.css';

export interface PackSolutionCardProps {
  readonly pack: RankedPackCandidate<SolvedPackCandidate>;
  readonly locale: 'fr' | 'en';
  readonly datesSummary?: string | undefined;
  readonly onSelectPack: (pack: RankedPackCandidate<SolvedPackCandidate>) => void;
  readonly disabled?: boolean | undefined;
}

function getItemEmoji(categorySlug?: string, productName?: string): string {
  const text = `${categorySlug || ''} ${productName || ''}`.toLowerCase();
  if (text.includes('trailer') || text.includes('remorque')) return '🛞';
  if (text.includes('seat') || text.includes('siege') || text.includes('siège')) return '💺';
  if (
    text.includes('bike') ||
    text.includes('velo') ||
    text.includes('vtt') ||
    text.includes('vae')
  )
    return '🚲';
  if (text.includes('kayak') || text.includes('canoe')) return '🛶';
  if (text.includes('paddle') || text.includes('surf')) return '🏄';
  if (text.includes('ski')) return '⛷️';
  return '📦';
}

function formatEuros(cents: number): string {
  const euros = (cents / 100).toFixed(2).replace('.', ',');
  return `${euros} €`;
}

export function PackSolutionCard({
  pack,
  locale,
  datesSummary,
  onSelectPack,
  disabled = false,
}: PackSolutionCardProps): React.ReactElement {
  const fr = locale === 'fr';
  const candidate = pack.candidate;
  const isRepaired = candidate.repairs.length > 0;

  // Grouper les équipements par nom de produit
  const groupedItems = new Map<
    string,
    { count: number; productName: string; categorySlug: string }
  >();

  for (const item of candidate.items) {
    const key = item.productId || item.productName;
    const existing = groupedItems.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      groupedItems.set(key, {
        count: 1,
        productName: item.productName,
        categorySlug: item.categorySlug,
      });
    }
  }

  const itemsList = Array.from(groupedItems.values());

  return (
    <article className={styles.card} aria-labelledby={`pack-title-${candidate.organizationId}`}>
      <div className={styles.cardHeader}>
        <div className={styles.badgeRow}>
          {isRepaired ? (
            <span className={styles.repairedBadge}>
              <span aria-hidden="true">💡</span>
              <span>{fr ? 'Alternative disponible' : 'Alternative available'}</span>
            </span>
          ) : (
            <span className={styles.completeBadge}>
              <span aria-hidden="true">✓</span>
              <span>{fr ? 'Solution complète' : 'Complete solution'}</span>
            </span>
          )}
          {pack.breakdown.exactMatch && (
            <span className={styles.matchBadge}>{fr ? '100% disponible' : '100% available'}</span>
          )}
        </div>

        <h3 id={`pack-title-${candidate.organizationId}`} className={styles.organizationName}>
          {candidate.organizationName}
        </h3>
        <p className={styles.locationSummary}>
          📍 {candidate.locationAddress || (fr ? 'Annecy' : 'Annecy')} · {candidate.distanceMeters}{' '}
          m
        </p>
      </div>

      <div className={styles.itemsSection}>
        <ul className={styles.itemsList}>
          {itemsList.map((item, idx) => (
            <li key={idx} className={styles.itemRow}>
              <span className={styles.itemEmoji} aria-hidden="true">
                {getItemEmoji(item.categorySlug, item.productName)}
              </span>
              <span className={styles.itemCount}>{item.count} ×</span>
              <span className={styles.itemName}>{item.productName}</span>
            </li>
          ))}
        </ul>

        {isRepaired && (
          <div className={styles.repairExplanation}>
            <span className={styles.repairIcon}>ℹ️</span>
            <span>
              {(fr ? candidate.repairs[0]?.explanationFr : candidate.repairs[0]?.explanationEn) ||
                (fr
                  ? 'Matériel adapté homologué pour votre groupe'
                  : 'Approved adapted equipment for your party')}
            </span>
          </div>
        )}
      </div>

      <div className={styles.invariantsRow}>
        <span className={styles.invariantPill}>
          ✓{' '}
          {datesSummary
            ? `${fr ? 'Tout disponible ' : 'All available '}${datesSummary}`
            : fr
              ? 'Tout disponible ce jour'
              : 'All available today'}
        </span>
        <span className={styles.invariantPill}>
          ✓ {fr ? 'Un seul retrait au même comptoir' : 'Single pickup at the same shop'}
        </span>
      </div>

      <div className={styles.cardFooter}>
        <div className={styles.priceContainer}>
          <span className={styles.priceAmount}>{formatEuros(candidate.totalPriceCents)}</span>
          <span className={styles.pricePeriod}>
            {fr ? 'TTC total pack' : 'total pack incl. VAT'}
          </span>
        </div>

        <button
          type="button"
          onClick={() => onSelectPack(pack)}
          disabled={disabled}
          className={styles.choosePackBtn}
        >
          <span>{fr ? 'Choisir ce pack →' : 'Choose this pack →'}</span>
        </button>
      </div>
    </article>
  );
}
