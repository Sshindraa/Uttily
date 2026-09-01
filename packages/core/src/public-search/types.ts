import type { DatabaseClient } from '@uttily/database';
import type { ProfessionalVerificationStatus } from '../professional-verification';

// ─────────────────────────────────────────────────────────────────────────────
// Intent & Constraints
// ─────────────────────────────────────────────────────────────────────────────

export type PublicSearchIntent =
  /**
   * `startAt` et `endAt` sont des chaînes ISO strictes (YYYY-MM-DDTHH:mm).
   * Elles représentent l'heure locale dans le fuseau IANA du lieu de location.
   * La conversion en UTC est effectuée PAR LOCATION via localDateTimeStringToUtc.
   */
  | { kind: 'TIME_RANGE'; startAt: string; endAt: string }
  /**
   * `startDate` et `endDateExclusive` sont des dates civiles strictes
   * (YYYY-MM-DD). L'intervalle est semi-ouvert [startDate, endDateExclusive[.
   */
  | { kind: 'DAY_RANGE'; startDate: string; endDateExclusive: string };

/**
 * Zone géographique explicitement choisie par l'utilisateur sur la carte.
 *
 * `west > east` est le cas valide d'une zone traversant l'antiméridien.
 * L'absence de cette valeur signifie la bbox canonique de la destination.
 */
export interface PublicSearchViewport {
  kind: 'VIEWPORT';
  south: number;
  west: number;
  north: number;
  east: number;
}

export type PublicSearchGeographicMatch =
  'EXACT' | 'RADIUS_10KM' | 'RADIUS_25KM' | 'RADIUS_50KM' | 'VIEWPORT_ALTERNATIVE';

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchPublicOffersInput {
  /** Identifiant public (UUID) de la destination — jamais l'ID primaire interne. */
  destinationPublicId: string;
  /** Locale demandée (fr/en ou variantes fr-FR/en-GB). */
  locale: string;
  /** Intention temporelle de recherche. */
  intent: PublicSearchIntent;
  /** Filtre optionnel par catégorie (ID interne UUID). Inclut les descendants actifs. */
  categoryId?: string;
  /**
   * Zone choisie explicitement sur la carte. La destination reste l'ancre
   * canonique obligatoire, même lorsque cette zone est fournie.
   */
  viewport?: PublicSearchViewport;
  /** Taille de page : défaut 24, min 1, max 48. Hors bornes → INVALID_INPUT. */
  pageSize?: number;
  /** Curseur opaque base64 versionné pour la pagination keyset. */
  cursor?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output — Read model public
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Résumé public du prix calculé côté serveur.
 * Informatif jusqu'au hold. Aucun ID interne de plan n'est exposé.
 */
export interface PublicPriceSummary {
  currency: 'EUR';
  /** Base marchande avant frais marketplace (subtotal + frais obligatoires). */
  marketplaceFeeBaseAmountMinor: number;
  customerServiceFeeAmountMinor: number;
  customerTotalAmountMinor: number;
  marketplaceFeeRuleVersion: string;
  /** Alias de compatibilité de la surface publique : désormais all-in client. */
  totalAmountMinor: number;
  planType: 'HOURLY' | 'FIXED_DURATION' | 'DAILY';
  publicLabel: string;
  requestedDurationMinutes: number | null;
  billedDurationMinutes: number | null;
  billedDays: number | null;
  discountPercent: number | null;
}

/**
 * Offre publique groupée par (publicProductId, publicLocationId).
 * Si plusieurs variantes sont disponibles pour le même couple, l'offre au
 * total le moins cher est sélectionnée (tie-breakers déterministes existants).
 *
 * Aucun ID interne (organizationId, locationId, productId, variantId,
 * inventoryItemId, pricingPlanId), legalName, email, SKU, numéro de série,
 * quantité exacte disponible ou détail de bloc n'est exposé.
 */
export interface PublicOfferSearchItem {
  publicProductId: string;
  publicLocationId: string;
  organizationPublicDisplayName: string;
  productName: string;
  locationName: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  postalCode: string | null;
  countryCode: string;
  latitude: number;
  longitude: number;
  /** Distance arrondie pour l'affichage (en mètres). */
  distanceMeters: number;
  isAvailable: true;
  /** Exact dans la bbox de destination, ou alternative dans le viewport. */
  geographicMatch: PublicSearchGeographicMatch;
  price: PublicPriceSummary;
}

export interface SearchPublicOffersResult {
  items: PublicOfferSearchItem[];
  /** Curseur pour la page suivante, ou null en fin de résultats. */
  nextCursor: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tuple keyset pour la pagination : (rawDistanceMeters, publicProductId, publicLocationId).
 * rawDistanceMeters conserve sa précision pour le tri et le curseur.
 */
export interface KeysetTuple {
  rawDistanceMeters: number;
  publicProductId: string;
  publicLocationId: string;
}

/**
 * Ligne candidate brute issue de la requête SQL ensembliste.
 * Contient les IDs internes nécessaires au calcul, mais qui ne sont
 * JAMAIS exposés dans le read model public.
 */
export interface CandidateRow {
  // IDs internes (non exposés)
  organizationId: string;
  locationId: string;
  productId: string;
  variantId: string;
  // IDs publics (exposés)
  publicProductId: string;
  publicLocationId: string;
  // Affichage
  organizationPublicDisplayName: string;
  productName: string;
  locationName: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  postalCode: string | null;
  countryCode: string;
  latitude: number;
  longitude: number;
  // Tri
  rawDistanceMeters: number;
  // Contexte pour le pricing
  timeZone: string;
  operatingCurrency: string;
  prepBufferMinutes: number;
  cleanupBufferMinutes: number;
}

/**
 * Interface du gating de publication publique (G7F-A).
 *
 * G7F-A fournira l'implémentation PostgreSQL réelle (au moins trois photos).
 * Le moteur de recherche publique exige une dépendance explicite.
 * Aucun prédicat synchrone, aucune implémentation par défaut permissive,
 * aucun `() => true` n'est accepté.
 */
export interface PublicProductPublicationGate {
  filterEligibleProductIds(
    db: DatabaseClient,
    productIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public offer detail projection (Bridge Public Search → Booking Hold)
// ─────────────────────────────────────────────────────────────────────────────

export interface GetPublicOfferDetailsInput {
  publicProductId: string;
  publicLocationId: string;
  locale?: string;
  /** Intention de réservation demandée, quand la page d'offre provient d'une recherche. */
  intent?: PublicSearchIntent;
  /** Variante publique choisie ; sans valeur, le prix indicatif le moins cher est retenu. */
  publicVariantId?: string;
}

export interface PublicOfferVariant {
  publicVariantId: string;
  name: string;
}

export interface PublicOfferOpeningHour {
  weekday: number;
  openTime: string;
  closeTime: string;
}

export interface PublicOfferPhoto {
  /** Identifiant public uniquement ; l'ID primaire n'est jamais exposé. */
  publicPhotoId: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  widthPx: number;
  heightPx: number;
}

export interface PublicOfferDetails {
  publicProductId: string;
  publicLocationId: string;
  organizationPublicDisplayName: string;
  /** Badge public uniquement lorsque la vérification LIVE est éligible. */
  professionalVerificationStatus?: ProfessionalVerificationStatus;
  productName: string;
  productDescription: string;
  locationName: string;
  timeZone: string;
  operatingCurrency: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  postalCode: string | null;
  countryCode: string;
  /** Prix all-in demandé, ou prix indicatif le moins cher sans intention de réservation. */
  price?: PublicPriceSummary;
  variants: PublicOfferVariant[];
  photos: PublicOfferPhoto[];
  openingHours: PublicOfferOpeningHour[];
}

export type GetPublicOfferDetailsResult =
  | { readonly kind: 'SUCCESS'; readonly offer: PublicOfferDetails }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'INVALID_INPUT' };

// ─────────────────────────────────────────────────────────────────────────────
// Public booking authority resolver (Bridge Server Action / Security Guards)
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvePublicBookingAuthorityInput {
  publicProductId: string;
  publicLocationId: string;
  publicVariantId: string;
}

export interface ResolvedPublicBookingAuthority {
  organizationId: string;
  locationId: string;
  productId: string;
  variantId: string;
  timeZone: string;
  operatingCurrency: string;
}

export type ResolvePublicBookingAuthorityResult =
  | { readonly kind: 'SUCCESS'; readonly authority: ResolvedPublicBookingAuthority }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'INVALID_INPUT' };
