import type {
  PublicSearchCategoryOption,
  PublicSearchDestinationOption,
  SearchPublicOffersResult,
} from '@uttily/core';
import type { PublicSearchParseResult, PublicUiLocale } from '@/lib/public-search';
import { SearchForm } from './search-form';
import { SearchIntentBar } from '@/features/search-intent/search-intent-bar';
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
}: SearchPageViewProps): React.ReactElement {
  const fr = locale === 'fr';

  return (
    <main className={styles.page} lang={locale}>
      <section className={styles.hero}>
        <p className={styles.eyebrow}>
          {fr ? 'Location locale · Stock réel' : 'Local rental · Verified stock'}
        </p>
        <h1>
          {fr
            ? 'Trouvez le bon équipement, au bon endroit.'
            : 'Find the right equipment, in the right place.'}
        </h1>
        <p>
          {fr
            ? 'Les disponibilités et les tarifs sont calculés pour votre période. Votre équipement est bloqué lors de votre réservation.'
            : 'Availability and pricing are calculated for your dates. Your equipment is held upon booking.'}
        </p>
      </section>

      <section className={styles.searchPanel} aria-labelledby="search-heading">
        <h2 id="search-heading" className={styles.srOnly}>
          {fr ? 'Critères de recherche' : 'Search criteria'}
        </h2>
        <SearchIntentBar
          key={initialSearchParams}
          locale={locale}
          initialOptions={{ destinations, categories }}
          initialValues={parsed.values}
          {...(parsed.kind === 'INVALID' ? { fieldErrors: parsed.fieldErrors } : {})}
        />
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

      {parsed.values.peopleCount && parsed.values.peopleCount > 1 ? (
        <p className={styles.notice}>
          <strong>
            {fr
              ? `Recherche pour ${parsed.values.peopleCount} personnes. `
              : `Searching for ${parsed.values.peopleCount} people. `}
          </strong>
          {fr
            ? 'Les offres et les prix restent présentés pour un équipement, pas pour l’ensemble des personnes. Vérifiez les capacités et les quantités avant de réserver.'
            : 'Offers and prices are still shown for one item, not for the whole party. Check capacities and quantities before booking.'}
        </p>
      ) : null}

      <SearchResults
        locale={locale}
        result={result}
        searchError={searchError}
        criteriaInvalid={parsed.kind === 'INVALID'}
        initialSearchParams={initialSearchParams}
        destination={destination}
        canSearchMap={parsed.kind === 'VALID'}
        initialViewport={parsed.kind === 'VALID' ? parsed.input.viewport : undefined}
      />
    </main>
  );
}
