import React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPublicOfferDetails, PostgresPhotoPublicationGate } from '@uttily/core';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import type { PublicUiLocale } from '@/lib/public-search';
import { OfferBookingForm } from './offer-booking-form';
import styles from './offer.module.css';

interface OfferPageProps {
  params: Promise<{ locale: string; publicProductId: string; publicLocationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const WEEKDAY_NAMES_FR = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const WEEKDAY_NAMES_EN = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

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

  if (offerResult.kind !== 'SUCCESS') {
    notFound();
  }

  const { offer } = offerResult;
  const user = await getAuthenticatedUser();

  // Construire l'URL de retour vers la recherche
  const searchUrlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedSearchParams)) {
    if (typeof value === 'string') searchUrlParams.set(key, value);
    else if (Array.isArray(value) && value[0]) searchUrlParams.set(key, value[0]);
  }
  const backToSearchUrl = `/${locale}/search${searchUrlParams.toString() ? `?${searchUrlParams.toString()}` : ''}`;

  const otherLocale = fr ? 'en' : 'fr';
  const otherLocaleUrl = `/${otherLocale}/offers/${publicProductId}/${publicLocationId}${searchUrlParams.toString() ? `?${searchUrlParams.toString()}` : ''}`;

  const weekdayNames = fr ? WEEKDAY_NAMES_FR : WEEKDAY_NAMES_EN;

  return (
    <main className={styles.page} lang={locale}>
      <header className={styles.header}>
        <Link href={`/${locale}/search`} className={styles.brand}>
          Uttily
        </Link>
        <nav aria-label={fr ? 'Langue' : 'Language'}>
          <Link href={otherLocaleUrl} hrefLang={otherLocale}>
            {fr ? 'English' : 'Français'}
          </Link>
          {user ? (
            <Link href={`/${locale}/account/bookings`}>{fr ? 'Mes locations' : 'My bookings'}</Link>
          ) : (
            <Link
              href={`/sign-in?redirect_url=${encodeURIComponent(
                `/${locale}/offers/${publicProductId}/${publicLocationId}${searchUrlParams.toString() ? `?${searchUrlParams.toString()}` : ''}`,
              )}`}
            >
              {fr ? 'Espace loueur' : 'Renter portal'}
            </Link>
          )}
        </nav>
      </header>

      <div className={styles.container}>
        <div className={styles.breadcrumbNav}>
          <Link href={backToSearchUrl} className={styles.backLink}>
            ← {fr ? 'Retour aux résultats de recherche' : 'Back to search results'}
          </Link>
        </div>

        <div className={styles.grid}>
          <div className={styles.detailsSection}>
            <article className={styles.productCard}>
              <p className={styles.eyebrow}>{offer.organizationPublicDisplayName}</p>
              <h1 className={styles.productTitle}>{offer.productName}</h1>
              {offer.price ? (
                <p
                  style={{
                    margin: '0 0 1rem',
                    color: 'var(--accent)',
                    fontSize: '1.25rem',
                    fontWeight: 800,
                  }}
                >
                  {offer.price.publicLabel}{' '}
                  {new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
                    style: 'currency',
                    currency: offer.price.currency,
                  }).format(offer.price.customerTotalAmountMinor / 100)}
                </p>
              ) : null}
              {offer.price ? (
                <p className={styles.priceHint}>
                  {fr
                    ? 'Prix indicatif selon les critères actuels. Le montant final sera recalculé lors de la réservation.'
                    : 'Indicative price for the current criteria. The final amount is recalculated when booking.'}
                </p>
              ) : null}
              {offer.photos.length > 0 ? (
                <div
                  className={styles.photoGallery}
                  aria-label={fr ? 'Photos du produit' : 'Product photos'}
                >
                  {offer.photos.map((photo, index) => (
                    <img
                      key={photo.publicPhotoId}
                      src={`/api/public/product-photos/${photo.publicPhotoId}`}
                      alt={
                        fr
                          ? `Photo ${index + 1} de ${offer.productName}`
                          : `Photo ${index + 1} of ${offer.productName}`
                      }
                      className={styles.productPhoto}
                    />
                  ))}
                </div>
              ) : null}
              {offer.productDescription ? (
                <p className={styles.productDescription}>{offer.productDescription}</p>
              ) : null}
            </article>

            <section className={styles.infoSection} aria-labelledby="location-heading">
              <h2 id="location-heading" className={styles.sectionTitle}>
                {fr ? 'Lieu de retrait et restitution' : 'Pickup & return location'}
              </h2>
              <p className={styles.infoText}>
                <strong>{offer.locationName}</strong>
                <br />
                {offer.addressLine1}
                {offer.addressLine2 ? `, ${offer.addressLine2}` : ''}
                <br />
                {offer.postalCode ? `${offer.postalCode} ` : ''}
                {offer.city}, {offer.countryCode}
              </p>
              <p className={styles.infoText}>
                <small>
                  {fr ? 'Fuseau horaire du lieu :' : 'Location timezone:'} {offer.timeZone}
                </small>
              </p>
            </section>

            {offer.openingHours.length > 0 ? (
              <section className={styles.infoSection} aria-labelledby="hours-heading">
                <h2 id="hours-heading" className={styles.sectionTitle}>
                  {fr ? 'Horaires d’ouverture' : 'Opening hours'}
                </h2>
                <ul className={styles.hoursList}>
                  {offer.openingHours.map((h, i) => (
                    <li key={i} className={styles.hourItem}>
                      <span className={styles.hourDay}>{weekdayNames[h.weekday] ?? h.weekday}</span>
                      <span className={styles.hourTime}>
                        {h.openTime.slice(0, 5)} - {h.closeTime.slice(0, 5)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          <aside>
            <OfferBookingForm
              offer={offer}
              locale={locale}
              initialIntent={initialIntent}
              initialStartDate={initialStartDate}
              initialEndDateExclusive={initialEndDateExclusive}
              initialStartAt={initialStartAt}
              initialEndAt={initialEndAt}
              initialVariantId={initialVariantId}
              isAuthenticated={user !== null}
            />
          </aside>
        </div>
      </div>
    </main>
  );
}

function getParamString(param: string | string[] | undefined): string {
  if (typeof param === 'string') return param;
  if (Array.isArray(param) && param[0]) return param[0];
  return '';
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
