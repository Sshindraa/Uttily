import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listPublicSearchFilterOptions, PublicSearchError } from '@uttily/core';
import { getDb } from '@/lib/db';
import {
  executePublicSearch,
  parsePublicSearchParams,
  type PublicUiLocale,
} from '@/lib/public-search';
import { SearchForm } from './search-form';
import { SearchResults } from './search-results';
import styles from './search.module.css';

interface SearchPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PublicSearchPage({
  params,
  searchParams,
}: SearchPageProps): Promise<React.ReactElement> {
  const { locale: rawLocale } = await params;
  if (rawLocale !== 'fr' && rawLocale !== 'en') notFound();
  const locale: PublicUiLocale = rawLocale;
  const fr = locale === 'fr';
  const resolvedParams = await searchParams;
  const urlParams = toUrlSearchParams(resolvedParams);
  const parsed = parsePublicSearchParams(urlParams, locale);
  const db = getDb();
  const filters = await listPublicSearchFilterOptions(db, locale);

  let result: Awaited<ReturnType<typeof executePublicSearch>> | null = null;
  let searchError: string | null = null;
  if (parsed.kind === 'VALID') {
    try {
      result = await executePublicSearch(db, parsed.input);
    } catch (error) {
      if (error instanceof PublicSearchError) {
        searchError = getPublicErrorMessage(error.code, locale);
      } else {
        throw error;
      }
    }
  }

  const otherLocale = fr ? 'en' : 'fr';
  const selectedDestination =
    filters.destinations.find(
      (destination) => destination.publicId === parsed.values.destinationPublicId,
    ) ?? null;
  return (
    <main className={styles.page} lang={locale}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Uttily, accueil">
          Uttily
        </Link>
        <nav aria-label={fr ? 'Navigation et langue' : 'Navigation and language'}>
          <Link href="/fr/account/bookings">{fr ? 'Mes locations' : 'My bookings'}</Link>
          <Link href={`/${otherLocale}/search`} hrefLang={otherLocale}>
            {fr ? 'English' : 'Français'}
          </Link>
          <Link href="/sign-in">{fr ? 'Espace loueur' : 'Renter portal'}</Link>
        </nav>
      </header>

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
            ? 'Les disponibilités et les tarifs sont calculés en temps réel pour votre période. Votre équipement est garanti dès votre réservation.'
            : 'Availability and pricing are calculated in real time for your dates. Your equipment is guaranteed upon booking.'}
        </p>
      </section>

      <section className={styles.searchPanel} aria-labelledby="search-heading">
        <h2 id="search-heading" className={styles.srOnly}>
          {fr ? 'Critères de recherche' : 'Search criteria'}
        </h2>
        <SearchForm
          locale={locale}
          destinations={filters.destinations}
          categories={filters.categories}
          values={parsed.values}
          {...(parsed.kind === 'INVALID' ? { fieldErrors: parsed.fieldErrors } : {})}
        />
        {filters.destinations.length === 0 ? (
          <p role="status" className={styles.notice}>
            {fr
              ? "Aucune destination n'est activée pour le moment."
              : 'No destination is currently active.'}
          </p>
        ) : null}
      </section>

      <SearchResults
        locale={locale}
        result={result}
        searchError={searchError}
        criteriaInvalid={parsed.kind === 'INVALID'}
        initialSearchParams={urlParams.toString()}
        destination={selectedDestination}
        canSearchMap={parsed.kind === 'VALID'}
        initialViewport={parsed.kind === 'VALID' ? parsed.input.viewport : undefined}
      />
    </main>
  );
}

function toUrlSearchParams(values: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') params.set(key, value);
    else if (Array.isArray(value) && value[0]) params.set(key, value[0]);
  }
  return params;
}

function getPublicErrorMessage(code: string, locale: PublicUiLocale): string {
  const fr = locale === 'fr';
  if (code === 'INVALID_LOCAL_TIME') {
    return fr
      ? "L'heure choisie est ambiguë ou inexistante dans le fuseau du lieu."
      : 'The selected time is ambiguous or does not exist in the location time zone.';
  }
  if (code === 'DESTINATION_NOT_FOUND' || code === 'DESTINATION_INACTIVE') {
    return fr
      ? "Cette destination n'est plus disponible."
      : 'This destination is no longer available.';
  }
  if (code === 'INVALID_CURSOR') {
    return fr
      ? 'Ce lien de pagination est invalide ou expiré.'
      : 'This pagination link is invalid or expired.';
  }
  if (code === 'INVALID_INPUT') {
    return fr ? 'Les critères de recherche sont invalides.' : 'The search criteria are invalid.';
  }
  return fr
    ? 'La recherche est momentanément indisponible. Réessayez plus tard.'
    : 'Search is temporarily unavailable. Please try again later.';
}
