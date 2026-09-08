import type {
  PublicSearchCategoryOption,
  PublicSearchDestinationOption,
  SearchPublicOffersResult,
  RankedPackCandidate,
  SolvedPackCandidate,
  SolvedPackAlternatives,
} from '@uttily/core';
import type { PublicSearchParseResult, PublicUiLocale } from '@/lib/public-search';
import { SearchForm } from './search-form';
import { SearchIntentBar } from '@/features/search-intent/search-intent-bar';
import { SearchFilterBar } from './components/search-filter-bar';
import { SearchResults } from './search-results';
import styles from './search.module.css';

export interface SearchPageViewProps {
  locale: PublicUiLocale;
  destinations: PublicSearchDestinationOption[];
  categories: PublicSearchCategoryOption[];
  parsed: PublicSearchParseResult;
  result: SearchPublicOffersResult | null;
  searchError: string | null;
  initialSearchParams: string;
  destination: PublicSearchDestinationOption | null;
  solvedPacks?: readonly RankedPackCandidate<SolvedPackCandidate>[] | undefined;
  datesSummary?: string | undefined;
  startAtIso?: string | undefined;
  endAtIso?: string | undefined;
  packAlternatives?: SolvedPackAlternatives | null | undefined;
}

export function SearchPageView({
  locale,
  destinations,
  categories,
  parsed,
  result,
  searchError,
  initialSearchParams,
  destination,
  solvedPacks,
  datesSummary,
  startAtIso,
  endAtIso,
  packAlternatives,
}: SearchPageViewProps): React.ReactElement {
  const fr = locale === 'fr';
  const isPackSearch = Boolean(parsed.values.peopleCount && parsed.values.peopleCount > 1);

  return (
    <main className={styles.page} lang={locale}>
      {/* Barre de recherche compacte Airbnb (en-tête de page) */}
      <section className={styles.topSearchSection} aria-labelledby="search-heading">
        <h2 id="search-heading" className={styles.srOnly}>
          {fr ? 'Critères de recherche' : 'Search criteria'}
        </h2>
        <div className={styles.searchBarWrapper}>
          <SearchIntentBar
            key={initialSearchParams}
            locale={locale}
            initialOptions={{ destinations, categories }}
            initialValues={parsed.values}
            {...(parsed.kind === 'INVALID' ? { fieldErrors: parsed.fieldErrors } : {})}
          />
        </div>
        <noscript>
          <SearchForm
            locale={locale}
            destinations={destinations}
            categories={categories}
            values={parsed.values}
          />
        </noscript>
        {destinations.length === 0 ? (
          <p role="status" className={styles.notice}>
            {fr
              ? "Aucune destination n'est activée pour le moment."
              : 'No destination is currently active.'}
          </p>
        ) : null}
      </section>

      {/* Bandeau de filtres horizontaux par catégorie (Airbnb chips) */}
      {categories.length > 0 ? (
        <SearchFilterBar
          categories={categories}
          selectedCategoryId={parsed.values.categoryId}
          locale={locale}
          currentSearchParams={initialSearchParams}
        />
      ) : null}

      {/* Résultats en split-screen (Solutions Packs + Liste individuelle + Carte interactive) */}
      <SearchResults
        locale={locale}
        result={result}
        searchError={searchError}
        criteriaInvalid={parsed.kind === 'INVALID'}
        initialSearchParams={initialSearchParams}
        destination={destination}
        canSearchMap={parsed.kind === 'VALID'}
        initialViewport={parsed.kind === 'VALID' ? parsed.input.viewport : undefined}
        solvedPacks={solvedPacks}
        datesSummary={datesSummary}
        startAtIso={startAtIso}
        endAtIso={endAtIso}
        isPackSearch={isPackSearch}
        packAlternatives={packAlternatives}
      />
    </main>
  );
}

