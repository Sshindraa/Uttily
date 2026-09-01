import Link from 'next/link';
import type { PublicOfferDetails } from '@uttily/core';
import type { PublicUiLocale } from '@/lib/public-search';
import { OfferBookingForm } from './offer-booking-form';
import styles from './offer.module.css';

export interface OfferPageViewProps {
  offer: PublicOfferDetails;
  locale: PublicUiLocale;
  backToSearchUrl: string;
  initialIntent: 'DAY_RANGE' | 'TIME_RANGE';
  initialStartDate: string;
  initialEndDateExclusive: string;
  initialStartAt: string;
  initialEndAt: string;
  initialVariantId: string;
  isAuthenticated: boolean;
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

export function OfferPageView({
  offer,
  locale,
  backToSearchUrl,
  initialIntent,
  initialStartDate,
  initialEndDateExclusive,
  initialStartAt,
  initialEndAt,
  initialVariantId,
  isAuthenticated,
}: OfferPageViewProps): React.ReactElement {
  const fr = locale === 'fr';
  const weekdayNames = fr ? WEEKDAY_NAMES_FR : WEEKDAY_NAMES_EN;

  return (
    <main className={styles.page} lang={locale}>
      <div className={styles.container}>
        <div className={styles.breadcrumbNav}>
          <Link href={backToSearchUrl} className={styles.backLink}>
            ← {fr ? 'Retour aux résultats de recherche' : 'Back to search results'}
          </Link>
        </div>

        <div className={styles.grid}>
          <div className={styles.detailsSection}>
            <article className={styles.productCard}>
              <div className={styles.organizationHeading}>
                <p className={styles.eyebrow}>{offer.organizationPublicDisplayName}</p>
                {offer.professionalVerificationStatus === 'eligible' ? (
                  <span
                    className={styles.verifiedBadge}
                    title={
                      fr
                        ? 'Informations professionnelles et capacité de location vérifiées par Uttily.'
                        : 'Professional information and rental capability verified by Uttily.'
                    }
                  >
                    ✓ {fr ? 'Loueur professionnel vérifié' : 'Verified professional renter'}
                  </span>
                ) : null}
              </div>
              <h1 className={styles.productTitle}>{offer.productName}</h1>
              {offer.price ? (
                <p
                  style={{
                    margin: '0 0 1rem',
                    color: 'var(--accent)',
                    fontSize: '1.25rem',
                    fontWeight: 'var(--ut-weight-bold)',
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
              isAuthenticated={isAuthenticated}
            />
          </aside>
        </div>
      </div>
    </main>
  );
}
