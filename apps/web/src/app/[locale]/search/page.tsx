import { notFound } from 'next/navigation';
import {
  listPublicSearchFilterOptions,
  PublicSearchError,
  buildPackRequestFromSearchParams,
  solvePackForParty,
  solvePackAlternatives,
  recordPackAnalytics,
  type RankedPackCandidate,
  type SolvedPackCandidate,
  type SolvedPackAlternatives,
} from '@uttily/core';
import { getDb } from '@/lib/db';
import {
  applyDefaultSearchDates,
  executePublicSearch,
  parsePublicSearchParams,
  type PublicUiLocale,
} from '@/lib/public-search';
import { ClientShell } from '@/components/shells/client-shell';
import { HomeNavigation } from '@/components/shells/client-shell/home-navigation';
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
  applyDefaultSearchDates(urlParams);
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

  // Pack Orchestrator — Résolution de pack mono-loueur pour demandes multi-besoins (ADR-041)
  let solvedPacks: readonly RankedPackCandidate<SolvedPackCandidate>[] = [];
  let packAlternatives: SolvedPackAlternatives | null = null;
  const isMultiNeed = Boolean(parsed.values.peopleCount && parsed.values.peopleCount > 1);

  if (isMultiNeed && parsed.values.destinationPublicId) {
    const selectedCategory = filters.categories.find((c) => c.id === parsed.values.categoryId);
    const startDate =
      parsed.values.startDate ||
      (parsed.values.startAt ? parsed.values.startAt.slice(0, 10) : '');
    const endDateExclusive =
      parsed.values.endDateExclusive ||
      (parsed.values.endAt ? parsed.values.endAt.slice(0, 10) : undefined);

    const packReq = buildPackRequestFromSearchParams({
      destinationPublicId: parsed.values.destinationPublicId,
      startDate: startDate || new Date().toISOString().slice(0, 10),
      endDateExclusive,
      peopleCount: parsed.values.peopleCount ?? 2,
      categoryId: parsed.values.categoryId,
      categorySlug: selectedCategory?.slug,
      packRequirementsJson: parsed.values.packRequirements,
    });

    if (packReq) {
      try {
        solvedPacks = await solvePackForParty(db, packReq);

        // Si aucun pack exact n'est trouvé, résoudre dynamiquement les vraies alternatives viables
        const hasExact = solvedPacks.some((p) => p.breakdown.exactMatch);
        if (!hasExact) {
          packAlternatives = await solvePackAlternatives(db, packReq, solvedPacks);
        }

        recordPackAnalytics({
          eventName: solvedPacks.length > 0 ? 'pack_candidate_found' : 'pack_zero_solution',
          destinationPublicId: parsed.values.destinationPublicId,
          peopleCount: parsed.values.peopleCount ?? 2,
          itemsCount: solvedPacks[0]?.candidate.items.length,
          totalPackPriceCents: solvedPacks[0]?.candidate.totalPriceCents,
          isRepaired: solvedPacks[0]?.candidate.repairs.length ? true : false,
        });
      } catch (err) {
        console.error('Error solving pack for party:', err);
      }
    }
  }

  const startAtIso =
    parsed.values.startAt ||
    (parsed.values.startDate
      ? `${parsed.values.startDate}T08:00:00.000Z`
      : new Date().toISOString());
  const endAtIso =
    parsed.values.endAt ||
    (parsed.values.endDateExclusive
      ? `${parsed.values.endDateExclusive}T19:00:00.000Z`
      : new Date(Date.now() + 86400000).toISOString());
  const datesSummary = parsed.values.startDate
    ? fr
      ? `le ${parsed.values.startDate}`
      : `on ${parsed.values.startDate}`
    : undefined;

  const otherLocale = fr ? 'en' : 'fr';
  const selectedDestination =
    filters.destinations.find(
      (destination) => destination.publicId === parsed.values.destinationPublicId,
    ) ?? null;
  return (
    <ClientShell
      localeOverride={locale}
      header={
        <HomeNavigation
          locale={locale}
          sticky={false}
          alternateHref={`/${otherLocale}/search`}
        />
      }
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
        solvedPacks={solvedPacks}
        packAlternatives={packAlternatives}
        datesSummary={datesSummary}
        startAtIso={startAtIso}
        endAtIso={endAtIso}
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
