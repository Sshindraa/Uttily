import { notFound } from 'next/navigation';
import { getPublicOfferDetails, PostgresPhotoPublicationGate } from '@uttily/core';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import type { PublicUiLocale } from '@/lib/public-search';
import { ClientShell } from '@/components/shells/client-shell';
import { OfferPageView } from '@/features/offers';

interface OfferPageProps {
  params: Promise<{ locale: string; publicProductId: string; publicLocationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PublicOfferPage({
  params,
  searchParams,
}: OfferPageProps): Promise<React.ReactElement> {
  const { locale: rawLocale, publicProductId, publicLocationId } = await params;
  if (rawLocale !== 'fr' && rawLocale !== 'en') notFound();
  const locale: PublicUiLocale = rawLocale;
  const fr = locale === 'fr';
  const resolvedSearchParams = await searchParams;

  const rawIntent = resolvedSearchParams.intent;
  const initialIntent = rawIntent === 'TIME_RANGE' ? 'TIME_RANGE' : 'DAY_RANGE';
  const initialStartDate = getParamString(resolvedSearchParams.startDate);
  const initialEndDateExclusive = getParamString(resolvedSearchParams.endDateExclusive);
  const initialStartAt = getParamString(resolvedSearchParams.startAt);
  const initialEndAt = getParamString(resolvedSearchParams.endAt);
  const initialVariantId = getParamString(resolvedSearchParams.variantId);
  const pricingIntent = getPricingIntent(
    rawIntent,
    initialStartDate,
    initialEndDateExclusive,
    initialStartAt,
    initialEndAt,
  );

  const db = getDb();
  const offerResult = await getPublicOfferDetails(
    db,
    {
      publicProductId,
      publicLocationId,
      locale,
      ...(pricingIntent ? { intent: pricingIntent } : {}),
      ...(initialVariantId ? { publicVariantId: initialVariantId } : {}),
    },
    { publicationGate: new PostgresPhotoPublicationGate() },
  );

  if (offerResult.kind !== 'SUCCESS') notFound();

  const user = await getAuthenticatedUser();
  const searchUrlParams = toSearchUrlParams(resolvedSearchParams);
  const query = searchUrlParams.toString();
  const backToSearchUrl = `/${locale}/search${query ? `?${query}` : ''}`;
  const otherLocale = fr ? 'en' : 'fr';
  const otherLocaleUrl =
    `/${otherLocale}/offers/${publicProductId}/${publicLocationId}` + (query ? `?${query}` : '');

  return (
    <ClientShell
      localeOverride={locale}
      alternateHref={otherLocaleUrl}
      alternateLabel={fr ? 'English' : 'Français'}
    >
      <OfferPageView
        offer={offerResult.offer}
        locale={locale}
        backToSearchUrl={backToSearchUrl}
        initialIntent={initialIntent}
        initialStartDate={initialStartDate}
        initialEndDateExclusive={initialEndDateExclusive}
        initialStartAt={initialStartAt}
        initialEndAt={initialEndAt}
        initialVariantId={initialVariantId}
        isAuthenticated={user !== null}
      />
    </ClientShell>
  );
}

function getParamString(param: string | string[] | undefined): string {
  if (typeof param === 'string') return param;
  if (Array.isArray(param) && param[0]) return param[0];
  return '';
}

function toSearchUrlParams(values: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') params.set(key, value);
    else if (Array.isArray(value) && value[0]) params.set(key, value[0]);
  }
  return params;
}

function getPricingIntent(
  rawIntent: string | string[] | undefined,
  startDate: string,
  endDateExclusive: string,
  startAt: string,
  endAt: string,
):
  | { kind: 'DAY_RANGE'; startDate: string; endDateExclusive: string }
  | { kind: 'TIME_RANGE'; startAt: string; endAt: string }
  | undefined {
  if (rawIntent === 'DAY_RANGE' && startDate && endDateExclusive && endDateExclusive > startDate) {
    return { kind: 'DAY_RANGE', startDate, endDateExclusive };
  }
  if (rawIntent === 'TIME_RANGE' && startAt && endAt && endAt > startAt) {
    return { kind: 'TIME_RANGE', startAt, endAt };
  }
  return undefined;
}
