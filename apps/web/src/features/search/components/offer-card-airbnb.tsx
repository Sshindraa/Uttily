'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import type { PublicUiLocale, EnrichedPublicOfferSearchItem } from '@/lib/public-search';
import styles from './offer-card-airbnb.module.css';

export interface OfferCardAirbnbProps {
  item: EnrichedPublicOfferSearchItem;
  locale: PublicUiLocale;
  activeSearchParams: string;
  isHighlighted?: boolean;
  onHover?: (productId: string | null) => void;
}

function formatMoney(amountMinor: number, currency: string, locale: PublicUiLocale): string {
  return new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amountMinor / 100);
}

function formatDistance(distanceMeters: number, locale: PublicUiLocale): string {
  if (distanceMeters < 1000) return `${distanceMeters} m`;
  return `${new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    maximumFractionDigits: 1,
  }).format(distanceMeters / 1000)} km`;
}

export function OfferCardAirbnb({
  item,
  locale,
  activeSearchParams,
  isHighlighted = false,
  onHover,
}: OfferCardAirbnbProps): React.ReactElement {
  const fr = locale === 'fr';
  const [isLiked, setIsLiked] = useState(false);

  const searchParams = new URLSearchParams(activeSearchParams);
  searchParams.delete('cursor');
  const offerQuery = searchParams.toString();
  const offerUrl = `/${locale}/offers/${item.publicProductId}/${item.publicLocationId}${
    offerQuery ? `?${offerQuery}` : ''
  }`;

  return (
    <article
      className={`${styles.card} ${isHighlighted ? styles.cardHighlighted : ''}`}
      onMouseEnter={() => onHover?.(item.publicProductId)}
      onMouseLeave={() => onHover?.(null)}
      id={`offer-${item.publicProductId}`}
    >
      <div className={styles.mediaWrapper}>
        <Link href={offerUrl} className={styles.imageLink} tabIndex={-1}>
          {item.primaryPhotoPublicId ? (
            <img
              src={`/api/public/product-photos/${item.primaryPhotoPublicId}`}
              alt={item.productName}
              className={styles.photo}
              loading="lazy"
            />
          ) : (
            <div className={styles.placeholderPhoto}>
              <span className={styles.placeholderIcon} aria-hidden="true">
                🚲
              </span>
            </div>
          )}
          <div className={styles.imageGradientOverlay} aria-hidden="true" />
        </Link>

        {/* Boutons d'action circulaires flottants (Haut Droit) */}
        <div className={styles.floatingActions}>
          <button
            type="button"
            className={`${styles.circleBtn} ${styles.favoriteBtn} ${isLiked ? styles.favoriteBtnActive : ''}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsLiked((prev) => !prev);
            }}
            aria-label={
              isLiked
                ? fr
                  ? 'Retirer des favoris'
                  : 'Remove from favorites'
                : fr
                  ? 'Enregistrer dans les favoris'
                  : 'Save to favorites'
            }
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill={isLiked ? '#ef4444' : 'none'}
              stroke={isLiked ? '#ef4444' : '#1e293b'}
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
            </svg>
          </button>

          <Link
            href={offerUrl}
            className={`${styles.circleBtn} ${styles.actionLinkBtn}`}
            aria-label={fr ? 'Consulter cette offre' : 'View this offer'}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="7" y1="17" x2="17" y2="7" />
              <polyline points="7 7 17 7 17 17" />
            </svg>
          </Link>
        </div>
      </div>

      {/* Contenu de la fiche sous / sur l'image */}
      <div className={styles.cardContent}>
        {/* Pills / Badges flottants */}
        <div className={styles.badgesRow}>
          <span className={styles.statusPill}>
            <span className={styles.statusDot} aria-hidden="true" />
            <span>{fr ? 'Loueur vérifié' : 'Verified'}</span>
          </span>
          <span className={styles.ratingPill}>
            <span className={styles.starIcon} aria-hidden="true">
              ★
            </span>
            <span>4.9</span>
          </span>
        </div>

        {/* Ligne principale : Titre à gauche, Prix à droite */}
        <div className={styles.titlePriceRow}>
          <h3 className={styles.title}>
            <Link href={offerUrl} className={styles.titleLink}>
              {item.productName}
            </Link>
          </h3>
          <div className={styles.priceContainer}>
            <span className={styles.priceAmount}>
              {formatMoney(item.price.totalAmountMinor, item.price.currency, locale)}
            </span>
          </div>
        </div>

        {/* Sous-titre : Loueur, ville et distance */}
        <p className={styles.subtitleRow}>
          <span className={styles.orgName}>{item.organizationPublicDisplayName}</span>
          <span className={styles.dotSep}>·</span>
          <span>{item.city || item.locationName}</span>
          <span className={styles.dotSep}>·</span>
          <span className={styles.distanceText}>{formatDistance(item.distanceMeters, locale)}</span>
        </p>

        {/* Rangée de spécifications / tags arrondis (style 1200 sq ft, 3 Beds...) */}
        <div className={styles.specsRow}>
          <span className={styles.specChip}>
            {item.price.publicLabel || (fr ? 'Journée' : 'Daily')}
          </span>
          <span className={styles.specChip}>{fr ? 'Réservation garantie' : 'Instant booking'}</span>
          <span className={styles.specChip}>{fr ? 'Caution sur place' : 'Deposit at desk'}</span>
        </div>
      </div>
    </article>
  );
}
