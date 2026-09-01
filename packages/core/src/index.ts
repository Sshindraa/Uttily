/**
 * @uttily/core — Module Identity & Organizations (Lot 1).
 *
 * Source de vérité des rôles, permissions et invariants métier.
 * Indépendant de Next.js et de Clerk. Les actions serveur de apps/web
 * délèguent à ce module.
 */

export * from './identity/permissions';
export * from './identity/types';
export * from './identity/slug';
export * from './identity/time-zone';
export * from './identity/organizations';
export * from './identity/memberships';
export * from './identity/locations';
export * from './identity/invitations';
export * from './identity/schedule';
export * from './identity/public-app-url';
export * from './identity/audit';
export * from './identity/provisioning';

// Lot 2A — Catalogue et inventaire physique.
export * from './catalog/index';

// Lot 3 — Disponibilité et blocages (InventoryBlock).
export * from './availability/index';

// Lot 4 — Prix et calcul des jours civils.
export * from './pricing/index';

// Chantier 22-B0 — moteur serveur fermé des frais marketplace.
export * from './marketplace-fees/index';

// Lot 4 — Idempotence persistée.
export * from './idempotency/index';

// Lot 4 — Création atomique de brouillon de réservation.
export * from './booking-drafts/index';

// Lot 5 — Résolution des termes financiers (ADR-010).
export * from './financial-terms/index';

// Lot 5 — Adapter Stripe et provider de paiement (ADR-010).
export * from './payments/index';

// Lot 5 — Initiation de paiement (ADR-010 §7).
export * from './payment-initiation/index';

// Lot 5 — Onboarding Stripe Connect et projection du compte connecté (ADR-010 §3.3, §16 étape 4).
export * from './connected-accounts/index';

// Lot 5 — Traitement des webhooks Stripe (ADR-010 §9, §10, §11, §13, §14).
export * from './webhook-handler/index';

// Phase 7A — Moteur de réconciliation des paiements (ADR-010 §12).
export * from './payment-reconciliation';

// Phase 8 — Exécution idempotente des compensations (ADR-010 §13).
export * from './compensation-execution';

// G7M-B2-B2 — Exécution worker des refunds d'amendement REFUND.
export * from './refund-request-execution';

// G5D — Module commun de revendication d'événements outbox (ADR-013 §7).
export {
  type KnownHandlerSelection,
  validateHandlerSelection,
  type IncrementStrategy,
  type ClaimedOutboxEvent,
  type ClaimEligibility,
  claimOutboxBatch,
  poseLease,
  validateClaimEligibility,
  validateBatchLimit as validateOutboxBatchLimit,
  BOOKING_CONFIRMED_SELECTION,
  REFUND_REQUEST_SELECTION,
  MAX_BATCH_LIMIT as OUTBOX_MAX_BATCH_LIMIT,
  DEFAULT_BATCH_LIMIT as OUTBOX_DEFAULT_BATCH_LIMIT,
  MAX_ATTEMPTS as OUTBOX_MAX_ATTEMPTS,
  BASE_BACKOFF_INTERVAL as OUTBOX_BASE_BACKOFF_INTERVAL,
  getBackoffIntervalSeconds as getOutboxBackoffIntervalSeconds,
} from './outbox-claim';

// Phase 10 G1 — Machine à états pure des bookings (ADR-011).
export * from './fulfillment/index';

// Phase 10 G5B — Documents transactionnels : schéma et contrats (ADR-013).
export * from './transactional-documents';

// Pricing Plans — G7P-B1 (flexible pricing engine, read-only quote).
export {
  quoteFlexiblePricing,
  computeQuote,
  loadPricingContext,
  isWithinOpeningHours,
  isDayRangeBoundariesCompatibleWithSchedule,
  validateDayRangeBoundariesAgainstSchedule,
  FlexiblePricingError,
  type QuoteFlexiblePricingInput,
  type QuoteFlexiblePricingResult,
  type QuoteLine,
  type QuoteLineHourly,
  type QuoteLineFixedDuration,
  type QuoteLineDaily,
  type FlexiblePricingIntent,
  type SelectedWindow,
  type FlexiblePricingErrorCode,
  type PricingContext,
  type ResolvedPlan,
  type ResolvedWindow,
  type ResolvedTier,
  type ResolvedTranslation,
  getVariantPricingSummary,
  saveDailyPricingPlanDraft,
  activateDailyPricingPlan,
  type PricingPlanSummary,
  type VariantPricingOverview,
  type DiscountTierSummary,
  type SaveDailyPricingPlanDraftInput,
} from './pricing-plans';

// G7D-A — Moteur de recherche publique exacte (read-only, informatif).
export {
  searchPublicOffers,
  getPublicOfferDetails,
  resolvePublicBookingAuthority,
  listPublicSearchFilterOptions,
  createPublicSearchCursorCodec,
  isPointInBbox,
  classifyPublicSearchGeographicMatch,
  isValidPublicSearchViewport,
  normalizePublicSearchViewport,
  publicSearchViewportCenter,
  haversineDistanceMeters,
  roundDistanceForDisplay,
  PUBLIC_SEARCH_RADIUS_TIERS,
  PublicSearchError,
  type SearchPublicOffersInput,
  type SearchPublicOffersResult,
  type PublicOfferSearchItem,
  type PublicPriceSummary,
  type PublicSearchIntent,
  type PublicSearchViewport,
  type PublicSearchGeographicMatch,
  type PublicSearchErrorCode,
  type KeysetTuple,
  type PublicProductPublicationGate,
  type PublicSearchCursorCodec,
  type CursorFingerprint,
  type PublicSearchDestinationOption,
  type PublicSearchCategoryOption,
  type PublicSearchFilterOptions,
  type GetPublicOfferDetailsInput,
  type GetPublicOfferDetailsResult,
  type PublicOfferDetails,
  type PublicOfferVariant,
  type PublicOfferOpeningHour,
  type PublicOfferPhoto,
  type ResolvePublicBookingAuthorityInput,
  type ResolvedPublicBookingAuthority,
  type ResolvePublicBookingAuthorityResult,
} from './public-search';

// G7F-A2 — Photos et publication gate.
export * from './photos';

// G7G — Projection read-only des signaux maintenance du dashboard.
export * from './dashboard';

// G8B-3B4 — Badge professionnel calculé côté serveur et révocable.
export * from './professional-verification';

// G7H-A — Fondations analytics first-party privacy-first.
export * from './product-analytics';

// G7M-B1 — Projection canonique getEffectiveBooking (ADR-023 §4.1, read-only).
export * from './booking-amendments';

// Chantier 9 — Domaine Maintenance & Atelier.
export * from './maintenance';

// Chantier 10 — Planning Opérationnel.
export * from './planning';

// Chantier 11 — Revenus & Versements.
export * from './finances';

// Chantier 18-B — logs opérationnels serveur et signaux de santé internes.
export * from './observability';

// Chantier 12 — Annulations & Remboursements.
export * from './cancellations';

// Chantier 13 — Notifications Transactionnelles.
export * from './notifications';

// Chantier 14 — Espace Locataire & Post-réservation.
export * from './customer-bookings';

// Chantier 16 — Back-office Uttily & Support V1.
export * from './support';

// Chantier 20-A — Contrôle non destructif de readiness LIVE.
export * from './live-readiness';
