'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Component, type ErrorInfo, type ReactNode, useEffect, useRef, useState } from 'react';
import type {
  PublicOfferSearchItem,
  PublicSearchGeographicMatch,
  PublicSearchDestinationOption,
  PublicSearchViewport,
  SearchPublicOffersResult,
  RankedPackCandidate,
  SolvedPackCandidate,
  SolvedPackAlternatives,
} from '@uttily/core';
import { Icon } from '@uttily/ui';
import type { PublicUiLocale } from '@/lib/public-search';
import { FloatingViewToggle } from './components/floating-view-toggle';
import { PackSolutionCard } from './components/pack-solution-card';
import { PackConfirmationDrawer } from './components/pack-confirmation-drawer';
import { PackAlternativesSection } from './components/pack-alternatives-section';
import styles from './search.module.css';

const SearchMap = dynamic(() => import('./search-map').then((module) => module.SearchMap), {
  ssr: false,
  loading: () => <p className={styles.mapUnavailable} role="status" />,
});

interface SearchResultsProps {
  locale: PublicUiLocale;
  result: SearchPublicOffersResult | null;
  searchError: string | null;
  criteriaInvalid: boolean;
  initialSearchParams: string;
  destination: PublicSearchDestinationOption | null;
  canSearchMap: boolean;
  initialViewport?: PublicSearchViewport | undefined;
  solvedPacks?: readonly RankedPackCandidate<SolvedPackCandidate>[] | undefined;
  datesSummary?: string | undefined;
  startAtIso?: string | undefined;
  endAtIso?: string | undefined;
  isPackSearch?: boolean | undefined;
  packAlternatives?: SolvedPackAlternatives | null | undefined;
}

interface SearchErrorBody {
  error?: { code?: string };
}

export function SearchResults({
  locale,
  result: initialResult,
  searchError: initialSearchError,
  criteriaInvalid,
  initialSearchParams,
  destination,
  canSearchMap,
  initialViewport,
  solvedPacks,
  datesSummary,
  startAtIso,
  endAtIso,
  isPackSearch = false,
  packAlternatives,
}: SearchResultsProps): React.ReactElement {
  const fr = locale === 'fr';
  const [result, setResult] = useState<SearchPublicOffersResult | null>(initialResult);
  const [activeSearchParams, setActiveSearchParams] = useState(initialSearchParams);
  const [error, setError] = useState<string | null>(initialSearchError);
  const [isFetching, setIsFetching] = useState(false);
  const [hoveredProductId, setHoveredProductId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<'list' | 'map'>('list');
  const [selectedPackForDrawer, setSelectedPackForDrawer] =
    useState<RankedPackCandidate<SolvedPackCandidate> | null>(null);

  const hasRepairedPacksOnly = Boolean(
    solvedPacks && solvedPacks.length > 0 && !solvedPacks.some((p) => p.breakdown.exactMatch),
  );

  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    abortRef.current?.abort();
    setResult(initialResult);
    setActiveSearchParams(initialSearchParams);
    setError(initialSearchError);
    setIsFetching(false);
  }, [initialResult, initialSearchError, initialSearchParams]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const searchViewport = async (viewport: PublicSearchViewport): Promise<boolean> => {
    if (!canSearchMap) return false;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestIdRef.current;
    const params = new URLSearchParams(activeSearchParams || initialSearchParams);
    params.set('locale', locale);
    params.delete('cursor');
    params.set('viewportSouth', String(viewport.south));
    params.set('viewportWest', String(viewport.west));
    params.set('viewportNorth', String(viewport.north));
    params.set('viewportEast', String(viewport.east));

    setIsFetching(true);
    setError(null);
    try {
      const response = await fetch(`/api/public/search?${params.toString()}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      const body = (await response.json()) as SearchPublicOffersResult | SearchErrorBody;
      if (requestId !== requestIdRef.current) return false;
      if (!response.ok || !isSearchResult(body)) {
        setError(
          getApiErrorMessage(isSearchErrorBody(body) ? body.error?.code : undefined, locale),
        );
        return false;
      }
      setResult(body);
      setActiveSearchParams(params.toString());
      return true;
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return false;
      if (requestId === requestIdRef.current) {
        setError(
          fr
            ? 'La recherche dans cette zone est momentanément indisponible.'
            : 'Search for this area is temporarily unavailable.',
        );
      }
      return false;
    } finally {
      if (requestId === requestIdRef.current) setIsFetching(false);
    }
  };

  const exactItems = result?.items.filter((item) => item.geographicMatch === 'EXACT') ?? [];
  const radius10Items =
    result?.items.filter((item) => item.geographicMatch === 'RADIUS_10KM') ?? [];
  const radius25Items =
    result?.items.filter((item) => item.geographicMatch === 'RADIUS_25KM') ?? [];
  const radius50Items =
    result?.items.filter((item) => item.geographicMatch === 'RADIUS_50KM') ?? [];
  const viewportAlternativeItems =
    result?.items.filter((item) => item.geographicMatch === 'VIEWPORT_ALTERNATIVE') ?? [];

  const radiusSections: Array<{
    id: string;
    match: Extract<PublicSearchGeographicMatch, `RADIUS_${string}`>;
    titleFr: string;
    titleEn: string;
    descriptionFr: string;
    descriptionEn: string;
    items: PublicOfferSearchItem[];
  }> = [
    {
      id: 'radius-10-results',
      match: 'RADIUS_10KM',
      titleFr: 'Alternative à moins de 10 km',
      titleEn: 'Alternative within 10 km',
      descriptionFr:
        'Ces offres sont hors de la destination sélectionnée, dans un rayon maximal de 10 km.',
      descriptionEn:
        'These offers are outside the selected destination, within a maximum radius of 10 km.',
      items: radius10Items,
    },
    {
      id: 'radius-25-results',
      match: 'RADIUS_25KM',
      titleFr: 'Alternative entre 10 et 25 km',
      titleEn: 'Alternative between 10 and 25 km',
      descriptionFr:
        'Ces offres sont hors de la destination sélectionnée, entre 10 et 25 km du centre.',
      descriptionEn:
        'These offers are outside the selected destination, between 10 and 25 km from its centre.',
      items: radius25Items,
    },
    {
      id: 'radius-50-results',
      match: 'RADIUS_50KM',
      titleFr: 'Alternative entre 25 et 50 km',
      titleEn: 'Alternative between 25 and 50 km',
      descriptionFr:
        'Ces offres sont hors de la destination sélectionnée, entre 25 et 50 km du centre.',
      descriptionEn:
        'These offers are outside the selected destination, between 25 and 50 km from its centre.',
      items: radius50Items,
    },
  ];

  return (
    <section className={styles.results} aria-live="polite" aria-busy={isFetching}>
      {criteriaInvalid ? (
        <p role="alert" className={styles.error}>
          {fr ? 'Vérifiez les champs indiqués.' : 'Check the highlighted fields.'}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {isFetching ? (
        <p className={styles.searchStatus} role="status">
          {fr ? 'Recherche dans la zone choisie…' : 'Searching this area…'}
        </p>
      ) : null}

      <div className={styles.splitLayout}>
        {/* Colonne gauche : Liste des offres (Airbnb style) */}
        <div
          className={`${styles.listPane} ${mobileView === 'map' ? styles.paneHiddenOnMobile : ''}`}
        >
          {result ? (
            <>
              {/* Pack Orchestrator — Solutions Mono-Loueur */}
              {isPackSearch && solvedPacks && solvedPacks.length > 0 ? (
                <section className={styles.packsSection} aria-labelledby="packs-section-heading">
                  <div className={styles.packsHeader}>
                    <div className={styles.packsEyebrow}>
                      <span aria-hidden="true">✓</span>
                      <span>
                        {fr
                          ? 'Pack Orchestrator · Solution Mono-Loueur'
                          : 'Pack Orchestrator · Single-Shop Solution'}
                      </span>
                    </div>
                    <h2 id="packs-section-heading" className={styles.packsTitle}>
                      {fr ? 'Solutions pour votre sortie' : 'Solutions for your outing'}
                    </h2>
                    <p className={styles.packsSubtitle}>
                      {fr
                        ? 'Tout votre équipement réuni chez un seul loueur vérifié, avec un seul retrait et une disponibilité garantie.'
                        : 'All your equipment provided by a single verified shop, with one pickup and guaranteed availability.'}
                    </p>
                  </div>

                  <div className={styles.packsGrid}>
                    {solvedPacks.map((pack) => (
                      <PackSolutionCard
                        key={`${pack.candidate.organizationId}:${pack.candidate.locationId}`}
                        pack={pack}
                        locale={locale}
                        datesSummary={datesSummary}
                        onSelectPack={(selected) => setSelectedPackForDrawer(selected)}
                      />
                    ))}
                  </div>

                  {hasRepairedPacksOnly && (
                    <PackAlternativesSection
                      locale={locale}
                      alternatives={packAlternatives}
                      repairedPack={solvedPacks.find((p) => p.candidate.repairs.length > 0)}
                      onSelectRepairedPack={(selected) => setSelectedPackForDrawer(selected)}
                      currentSearchParams={activeSearchParams}
                    />
                  )}
                </section>
              ) : isPackSearch && (!solvedPacks || solvedPacks.length === 0) ? (
                <PackAlternativesSection
                  locale={locale}
                  alternatives={packAlternatives}
                  currentSearchParams={activeSearchParams}
                />
              ) : null}

              {isPackSearch &&
                Boolean(
                  (solvedPacks && solvedPacks.length > 0) ||
                  (packAlternatives && packAlternatives.totalAlternativesCount > 0),
                ) && (
                  <div className={styles.individualOffersDivider}>
                    <h3 className={styles.individualOffersTitle}>
                      {fr ? 'Ou explorez les offres individuelles' : 'Or explore individual offers'}
                    </h3>
                    <p className={styles.individualOffersSubtitle}>
                      {fr
                        ? 'Ces offres restent disponibles à l’unité pour composer votre propre panier.'
                        : 'These offers remain available individually to build your own cart.'}
                    </p>
                  </div>
                )}

              <div className={styles.resultsHeading}>
                <div>
                  <p className={styles.eyebrow}>{fr ? 'Disponibilités' : 'Availability'}</p>
                  <h2 id="search-results-heading">
                    {result.items.length === 0
                      ? fr
                        ? 'Aucun résultat exact'
                        : 'No exact results'
                      : fr
                        ? `${result.items.length} offre${
                            result.items.length > 1 ? 's' : ''
                          } disponible${result.items.length > 1 ? 's' : ''}`
                        : `${result.items.length} available offer${result.items.length > 1 ? 's' : ''}`}
                  </h2>
                </div>
                <p>
                  {fr
                    ? "Disponibilité actualisée — l'exemplaire est alloué lors de la confirmation de votre réservation."
                    : 'Updated availability — equipment is allocated upon booking confirmation.'}
                </p>
              </div>

              <section className={styles.resultSection} aria-labelledby="exact-results-heading">
                <h3 id="exact-results-heading">
                  {fr
                    ? `Dans la destination sélectionnée (${exactItems.length})`
                    : `In the selected destination (${exactItems.length})`}
                </h3>
                {exactItems.length > 0 ? (
                  <div className={styles.grid}>
                    {exactItems.map((item) => (
                      <OfferSearchCard
                        key={`${item.publicProductId}:${item.publicLocationId}`}
                        item={item}
                        locale={locale}
                        activeSearchParams={activeSearchParams}
                        isHighlighted={hoveredProductId === item.publicProductId}
                        onHover={setHoveredProductId}
                      />
                    ))}
                  </div>
                ) : (
                  <p className={styles.emptySection}>
                    {fr
                      ? 'Aucune offre exacte pour ces critères. Consultez les alternatives ci-dessous.'
                      : 'No exact offer for these criteria. Check the alternatives below.'}
                  </p>
                )}
              </section>

              {radiusSections.map((section) =>
                section.items.length > 0 ? (
                  <section
                    className={styles.resultSection}
                    aria-labelledby={section.id}
                    key={section.id}
                  >
                    <h3 id={section.id}>{fr ? section.titleFr : section.titleEn}</h3>
                    <p className={styles.alternativeExplanation}>
                      {fr ? section.descriptionFr : section.descriptionEn}
                    </p>
                    <div className={styles.grid}>
                      {section.items.map((item) => (
                        <OfferSearchCard
                          key={`${item.publicProductId}:${item.publicLocationId}`}
                          item={item}
                          locale={locale}
                          activeSearchParams={activeSearchParams}
                          isHighlighted={hoveredProductId === item.publicProductId}
                          onHover={setHoveredProductId}
                        />
                      ))}
                    </div>
                  </section>
                ) : null,
              )}

              {viewportAlternativeItems.length > 0 ? (
                <section
                  className={styles.resultSection}
                  aria-labelledby="alternative-results-heading"
                >
                  <h3 id="alternative-results-heading">
                    {fr
                      ? `Dans la zone de carte choisie (${viewportAlternativeItems.length})`
                      : `In the selected map area (${viewportAlternativeItems.length})`}
                  </h3>
                  <p className={styles.alternativeExplanation}>
                    {fr
                      ? 'Ces offres sont hors de la destination sélectionnée, mais dans la zone de carte choisie.'
                      : 'These offers are outside the selected destination but inside the chosen map area.'}
                  </p>
                  <div className={styles.grid}>
                    {viewportAlternativeItems.map((item) => (
                      <OfferSearchCard
                        key={`${item.publicProductId}:${item.publicLocationId}`}
                        item={item}
                        locale={locale}
                        activeSearchParams={activeSearchParams}
                        isHighlighted={hoveredProductId === item.publicProductId}
                        onHover={setHoveredProductId}
                      />
                    ))}
                  </div>
                </section>
              ) : null}

              {result.nextCursor ? (
                <a
                  className={styles.more}
                  href={`/${locale}/search?${withCursor(activeSearchParams, result.nextCursor)}`}
                  rel="next"
                >
                  {fr ? 'Voir plus d’offres' : 'See more offers'}
                </a>
              ) : null}
            </>
          ) : null}
        </div>

        {/* Colonne droite : Carte interactive collante (Airbnb style) */}
        {destination ? (
          <div
            className={`${styles.mapPane} ${
              mobileView === 'list' ? styles.paneHiddenOnMobile : ''
            }`}
            aria-labelledby="search-map-heading"
          >
            <div className={styles.stickyMapWrapper}>
              <MapErrorBoundary locale={locale} key={destination.publicId}>
                <SearchMap
                  locale={locale}
                  destination={destination}
                  items={result?.items ?? []}
                  initialViewport={initialViewport}
                  canSearch={canSearchMap}
                  isSearching={isFetching}
                  hoveredProductId={hoveredProductId}
                  onHoverProduct={setHoveredProductId}
                  onSearchViewport={searchViewport}
                />
              </MapErrorBoundary>
            </div>
          </div>
        ) : null}
      </div>

      {/* Bouton flottant de bascule mobile Carte / Liste */}
      {destination && (
        <FloatingViewToggle currentView={mobileView} onToggle={setMobileView} locale={locale} />
      )}

      {/* Pack Confirmation Drawer */}
      <PackConfirmationDrawer
        pack={selectedPackForDrawer}
        locale={locale}
        datesSummary={datesSummary}
        startAtIso={startAtIso || new Date().toISOString()}
        endAtIso={endAtIso || new Date(Date.now() + 86400000).toISOString()}
        onClose={() => setSelectedPackForDrawer(null)}
      />
    </section>
  );
}

function withCursor(params: string, cursor: string): string {
  const next = new URLSearchParams(params);
  next.set('cursor', cursor);
  return next.toString();
}

interface OfferSearchCardProps {
  item: PublicOfferSearchItem;
  locale: PublicUiLocale;
  activeSearchParams: string;
  isHighlighted?: boolean;
  onHover?: (productId: string | null) => void;
}

function OfferSearchCard({
  item,
  locale,
  activeSearchParams,
  isHighlighted = false,
  onHover,
}: OfferSearchCardProps): React.ReactElement {
  const fr = locale === 'fr';
  const searchParams = new URLSearchParams(activeSearchParams);
  searchParams.delete('cursor');
  const offerQuery = searchParams.toString();
  const offerUrl = `/${locale}/offers/${item.publicProductId}/${item.publicLocationId}${
    offerQuery ? `?${offerQuery}` : ''
  }`;
  const [imageError, setImageError] = useState(false);
  const [isLiked, setIsLiked] = useState(false);
  const coverPhotoUrl = item.coverPhotoPublicId
    ? `/api/public/product-photos/${item.coverPhotoPublicId}`
    : null;
  const address = [
    item.addressLine1,
    item.addressLine2,
    [item.city, item.postalCode].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <article
      className={`${styles.card} ${isHighlighted ? styles.cardHighlighted : ''}`}
      onMouseEnter={() => onHover?.(item.publicProductId)}
      onMouseLeave={() => onHover?.(null)}
      id={`offer-${item.publicProductId}`}
    >
      <div className={styles.cardMedia}>
        <Link
          href={offerUrl}
          className={styles.cardImageLink}
          aria-label={`${fr ? 'Voir l’offre et réserver' : 'View offer & book'} : ${item.productName}`}
        >
          <span className={styles.cardImageFallback} aria-hidden="true" />
          {coverPhotoUrl && !imageError ? (
            <img
              src={coverPhotoUrl}
              alt=""
              className={styles.cardImage}
              onError={() => setImageError(true)}
            />
          ) : null}
          <span className={styles.cardImageShade} aria-hidden="true" />
        </Link>

        <div
          className={styles.cardActions}
          aria-label={fr ? 'Actions de l’offre' : 'Offer actions'}
        >
          <button
            type="button"
            className={`${styles.cardAction} ${isLiked ? styles.cardActionLiked : ''}`}
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
            <Icon name="heart" size={18} />
          </button>
          <Link
            href={offerUrl}
            className={`${styles.cardAction} ${styles.cardActionPrimary}`}
            aria-label={fr ? 'Voir l’offre et réserver' : 'View offer & book'}
          >
            <Icon name="arrow-up-right" size={19} />
          </Link>
        </div>

        <div className={styles.cardMeta} aria-label={fr ? 'Statut de l’offre' : 'Offer status'}>
          <span className={`${styles.cardMetaPill} ${styles.cardAvailability}`}>
            <span className={styles.cardStatusDot} aria-hidden="true">
              •
            </span>
            {fr ? 'Disponible' : 'Available'}
          </span>
          <span className={`${styles.cardMetaPill} ${styles.cardTrust}`}>
            <Icon name="check" size={14} />
            {fr ? 'Stock réel' : 'Real stock'}
          </span>
        </div>
      </div>

      <div className={styles.cardBody}>
        <div className={styles.cardTitleRow}>
          <h4>
            <Link href={offerUrl} className={styles.offerLink}>
              {item.productName}
            </Link>
          </h4>
          <strong className={styles.cardPrice}>
            {formatMoney(item.price.totalAmountMinor, item.price.currency, locale)}
          </strong>
        </div>
        <p className={styles.cardLocation} title={address}>
          {address}
        </p>
        <p className={styles.cardRenter} title={item.organizationPublicDisplayName}>
          {item.organizationPublicDisplayName} · {item.locationName}
        </p>
        <div className={styles.cardChips} aria-label={fr ? 'Détails de l’offre' : 'Offer details'}>
          <span className={styles.cardChip}>{item.price.publicLabel}</span>
          <span className={styles.cardChip}>{fr ? '1 équipement' : '1 item'}</span>
          <span className={styles.cardChip}>{fr ? 'Retrait sur place' : 'Local pickup'}</span>
          <span className={styles.cardChip}>{formatDistance(item.distanceMeters, locale)}</span>
        </div>
      </div>
    </article>
  );
}

function formatMoney(amountMinor: number, currency: string, locale: PublicUiLocale): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amountMinor / 100);
}

function formatDistance(distanceMeters: number, locale: PublicUiLocale): string {
  if (distanceMeters < 1000) return `${distanceMeters} m`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(distanceMeters / 1000)} km`;
}

function isSearchErrorBody(
  value: SearchPublicOffersResult | SearchErrorBody,
): value is SearchErrorBody {
  return 'error' in value;
}

function isSearchResult(
  value: SearchPublicOffersResult | SearchErrorBody,
): value is SearchPublicOffersResult {
  return (
    !isSearchErrorBody(value) &&
    Array.isArray(value.items) &&
    (typeof value.nextCursor === 'string' || value.nextCursor === null)
  );
}

function getApiErrorMessage(code: string | undefined, locale: PublicUiLocale): string {
  const fr = locale === 'fr';
  if (code === 'INVALID_INPUT' || code === 'INVALID_CURSOR') {
    return fr ? 'La zone de recherche est invalide.' : 'The search area is invalid.';
  }
  return fr
    ? 'La recherche est momentanément indisponible. Réessayez plus tard.'
    : 'Search is temporarily unavailable. Please try again later.';
}

interface MapErrorBoundaryProps {
  locale: PublicUiLocale;
  children: ReactNode;
}

interface MapErrorBoundaryState {
  failed: boolean;
}

class MapErrorBoundary extends Component<MapErrorBoundaryProps, MapErrorBoundaryState> {
  override state: MapErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): MapErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // La liste reste la surface de repli ; aucun détail de provider n'est exposé.
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <p className={styles.mapUnavailable} role="status">
          {this.props.locale === 'fr'
            ? 'La carte est momentanément indisponible. La liste reste utilisable.'
            : 'The map is temporarily unavailable. The list is still usable.'}
        </p>
      );
    }
    return this.props.children;
  }
}
