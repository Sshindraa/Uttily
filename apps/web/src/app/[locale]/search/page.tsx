import { notFound } from 'next/navigation';
import { listPublicSearchFilterOptions, PublicSearchError } from '@uttily/core';
import { getDb } from '@/lib/db';
import {
  executePublicSearch,
  parsePublicSearchParams,
  type PublicUiLocale,
} from '@/lib/public-search';
import { ClientShell } from '@/components/shells/client-shell';
import { getPublicErrorMessage, SearchPageView } from '@/features/search';

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
        // Keep the public page renderable when the data source is temporarily
        // unavailable. The API exposes the same closed SEARCH_UNAVAILABLE
        // code, so the page must not turn that expected failure into a Next
        // error boundary.
        searchError = getPublicErrorMessage('SEARCH_UNAVAILABLE', locale);
      }
    }
  }

  const otherLocale = fr ? 'en' : 'fr';
  const selectedDestination =
    filters.destinations.find(
      (destination) => destination.publicId === parsed.values.destinationPublicId,
    ) ?? null;
  return (
    <ClientShell
      localeOverride={locale}
      alternateHref={`/${otherLocale}/search`}
      alternateLabel={fr ? 'English' : 'Français'}
    >
      <SearchPageView
        locale={locale}
        destinations={filters.destinations}
        categories={filters.categories}
        parsed={parsed}
        result={result}
        searchError={searchError}
        initialSearchParams={urlParams.toString()}
        destination={selectedDestination}
      />
    </ClientShell>
  );
}

function toUrlSearchParams(values: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') params.set(key, value);
    else if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
  }
  return params;
}
