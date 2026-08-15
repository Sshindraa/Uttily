'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { Component, type ErrorInfo, type ReactNode, useEffect, useRef, useState } from 'react';
import type {
  PublicOfferSearchItem,
  PublicSearchDestinationOption,
  PublicSearchViewport,
  SearchPublicOffersResult,
} from '@uttily/core';
import type { PublicUiLocale } from '@/lib/public-search';
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
}: SearchResultsProps): React.ReactElement {
  const fr = locale === 'fr';
  const [result, setResult] = useState<SearchPublicOffersResult | null>(initialResult);
  const [activeSearchParams, setActiveSearchParams] = useState(initialSearchParams);
  const [error, setError] = useState<string | null>(initialSearchError);
  const [isFetching, setIsFetching] = useState(false);
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
  const alternativeItems =
    result?.items.filter((item) => item.geographicMatch === 'VIEWPORT_ALTERNATIVE') ?? [];

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

      {destination ? (
        <div className={styles.mapBlock} aria-labelledby="search-map-heading">
          <div className={styles.mapHeading}>
            <div>
              <p className={styles.eyebrow}>{fr ? 'Explorer la zone' : 'Explore the area'}</p>
              <h2 id="search-map-heading">{fr ? 'Carte de recherche' : 'Search map'}</h2>
            </div>
            <p>
              {fr
                ? 'La carte est informative. La liste reste disponible sans carte ni JavaScript.'
                : 'The map is informational. The list remains available without the map or JavaScript.'}
            </p>
          </div>
          <MapErrorBoundary locale={locale} key={destination.publicId}>
            <SearchMap
              locale={locale}
              destination={destination}
              items={result?.items ?? []}
              initialViewport={initialViewport}
              canSearch={canSearchMap}
              isSearching={isFetching}
              onSearchViewport={searchViewport}
            />
          </MapErrorBoundary>
        </div>
      ) : null}

      {result ? (
        <>
          <div className={styles.resultsHeading}>
            <div>
              <p className={styles.eyebrow}>{fr ? 'Disponibles maintenant' : 'Available now'}</p>
              <h2 id="search-results-heading">
                {result.items.length === 0
                  ? fr
                    ? 'Aucun résultat exact'
                    : 'No exact results'
                  : fr
                    ? `${result.items.length} offre${result.items.length > 1 ? 's' : ''}`
                    : `${result.items.length} offer${result.items.length > 1 ? 's' : ''}`}
              </h2>
            </div>
            <p>
              {fr
                ? "Disponibilité informative — l'exemplaire est alloué au hold."
                : 'Informative availability — the item is allocated when held.'}
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
                {exactItems.map((item) => renderCard(item, locale, activeSearchParams))}
              </div>
            ) : (
              <p className={styles.emptySection}>
                {fr
                  ? 'Aucune offre exacte pour ces critères.'
                  : 'No exact offer for these criteria.'}
              </p>
            )}
          </section>

          {alternativeItems.length > 0 ? (
            <section className={styles.resultSection} aria-labelledby="alternative-results-heading">
              <h3 id="alternative-results-heading">
                {fr
                  ? `Dans la zone de carte choisie (${alternativeItems.length})`
                  : `In the selected map area (${alternativeItems.length})`}
              </h3>
              <p className={styles.alternativeExplanation}>
                {fr
                  ? 'Ces offres sont hors de la destination sélectionnée, mais dans la zone de carte choisie.'
                  : 'These offers are outside the selected destination but inside the chosen map area.'}
              </p>
              <div className={styles.grid}>
                {alternativeItems.map((item) => renderCard(item, locale, activeSearchParams))}
              </div>
            </section>
          ) : null}

          {result.nextCursor ? (
            <a
              className={styles.more}
              href={`/${locale}/search?${withCursor(activeSearchParams, result.nextCursor)}`}
              rel="next"
            >
              {fr ? 'Voir la suite' : 'See more'}
            </a>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function renderCard(
  item: PublicOfferSearchItem,
  locale: PublicUiLocale,
  activeSearchParams: string,
): React.ReactElement {
  const fr = locale === 'fr';
  const searchParams = new URLSearchParams(activeSearchParams);
  searchParams.delete('cursor');
  const offerQuery = searchParams.toString();
  const offerUrl = `/${locale}/offers/${item.publicProductId}/${item.publicLocationId}${offerQuery ? `?${offerQuery}` : ''}`;

  return (
    <article key={`${item.publicProductId}:${item.publicLocationId}`} className={styles.card}>
      <div className={styles.cardTopline}>
        <span>{formatDistance(item.distanceMeters, locale)}</span>
        <span className={styles.available}>{fr ? 'Disponible' : 'Available'}</span>
      </div>
      <h4>
        <Link href={offerUrl} className={styles.offerLink}>
          {item.productName}
        </Link>
      </h4>
      <p className={styles.renter}>{item.organizationPublicDisplayName}</p>
      <p>
        {item.locationName}
        <br />
        {item.addressLine1}
        {item.addressLine2 ? (
          <>
            <br />
            {item.addressLine2}
          </>
        ) : null}
        <br />
        {[item.postalCode, item.city].filter(Boolean).join(' ')} · {item.countryCode}
      </p>
      <div className={styles.price}>
        <strong>{formatMoney(item.price.totalAmountMinor, item.price.currency, locale)}</strong>
        <span>{item.price.publicLabel}</span>
      </div>
      <div style={{ marginTop: '0.85rem' }}>
        <Link href={offerUrl} className={styles.bookButton}>
          {fr ? 'Voir l’offre et réserver' : 'View offer & book'}
        </Link>
      </div>
    </article>
  );
}

function withCursor(params: string, cursor: string): string {
  const next = new URLSearchParams(params);
  next.set('cursor', cursor);
  return next.toString();
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
