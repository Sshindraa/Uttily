/**
 * @uttily/core — Module Public Search (G7E-B).
 *
 * Moteur de recherche publique exacte (read-only, informatif).
 * PostgreSQL reste l'autorité des filtres d'inventaire et de disponibilité.
 * Le hold transactionnel (createBookingDraftWithHold) reste l'autorité de
 * réservation.
 *
 * Frontière photos G7F-A : le read model G7D-A NE PEUT PAS être exposé par G7E
 * tant que G7F-A n'a pas fourni le filtre obligatoire des 3 photos.
 * Le `publicationGate` injectable (asynchrone batch, fail-closed) permet
 * d'ajouter le filtre obligatoire des 3 photos fourni par G7F-A.
 */

export { searchPublicOffers } from './search-offers';
export { getPublicOfferDetails } from './get-public-offer-details';
export { resolvePublicBookingAuthority } from './resolve-public-booking-authority';
export { listPublicSearchFilterOptions } from './list-filters';
export {
  createPublicSearchCursorCodec,
  PUBLIC_SEARCH_CONTRACT_VERSION,
  type PublicSearchCursorCodec,
  type CursorFingerprint,
} from './cursor';
export {
  isPointInBbox,
  classifyPublicSearchGeographicMatch,
  isValidPublicSearchViewport,
  normalizePublicSearchViewport,
  publicSearchViewportCenter,
  haversineDistanceMeters,
  roundDistanceForDisplay,
  PUBLIC_SEARCH_RADIUS_TIERS,
} from './geo';

export { PublicSearchError } from './errors';
export type { PublicSearchErrorCode } from './errors';

export type {
  PublicSearchIntent,
  PublicSearchViewport,
  PublicSearchGeographicMatch,
  SearchPublicOffersInput,
  SearchPublicOffersResult,
  PublicOfferSearchItem,
  PublicPriceSummary,
  KeysetTuple,
  CandidateRow,
  PublicProductPublicationGate,
  GetPublicOfferDetailsInput,
  GetPublicOfferDetailsResult,
  PublicOfferDetails,
  PublicOfferVariant,
  PublicOfferOpeningHour,
  PublicOfferPhoto,
  ResolvePublicBookingAuthorityInput,
  ResolvedPublicBookingAuthority,
  ResolvePublicBookingAuthorityResult,
} from './types';
export type {
  PublicSearchDestinationOption,
  PublicSearchCategoryOption,
  PublicSearchFilterOptions,
} from './list-filters';
