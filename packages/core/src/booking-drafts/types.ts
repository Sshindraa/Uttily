import type { ActionErrorCode } from '@uttily/contracts';
import type { VariantPricingSnapshot } from '../pricing/types';
import type { PricingWindowSnapshot } from '../pricing-plans/types';

/**
 * Ligne d'entrée pour la création d'un brouillon de réservation.
 * Le client ne fournit JAMAIS : prix, devise, taxes, commission, fuseau,
 * marges, snapshots, politique d'annulation.
 */
export interface CreateBookingDraftInputLine {
  variantId: string;
  quantity: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// G7P-B2-B — Discriminated union for input (LEGACY vs FLEXIBLE)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entrée legacy pour la création d'un brouillon de réservation.
 * `pricingMode` est obligatoire et explicite ('LEGACY').
 */
export interface LegacyCreateBookingDraftInput {
  pricingMode: 'LEGACY';
  organizationId: string;
  locationId: string;
  customerUserId: string;
  customerStartAt: Date;
  customerEndAt: Date;
  lines: CreateBookingDraftInputLine[];
  idempotencyKey: string;
}

/**
 * Intent flexible pour le mode FLEXIBLE.
 * - TIME_RANGE : plage horaire précise (startAt, endAt en heure locale du lieu).
 * - DAY_RANGE : plage de jours civils (startDate inclusif, endDateExclusive exclusif).
 */
export type FlexibleBookingDraftIntent =
  /**
   * `startAt` et `endAt` sont des chaînes de date+heure locale au format
   * ISO 8601 SANS offset de fuseau horaire (ex : "2026-08-08T22:08:00").
   * Elles représentent l'heure locale dans le fuseau IANA du lieu de location
   * (ex : Europe/Paris). La conversion en UTC est effectuée par le système
   * via `localDateTimeStringToUtc` avec le fuseau du lieu, et le résultat UTC
   * est stocké dans `customer_start_at` / `customer_end_at`.
   * Le `pricing_intent_snapshot` stocke les chaînes locales telles quelles
   * (pas la conversion UTC) afin d'être lisible et indépendant du fuseau.
   */
  | { kind: 'TIME_RANGE'; startAt: string; endAt: string }
  | { kind: 'DAY_RANGE'; startDate: string; endDateExclusive: string };

/**
 * Entrée flexible pour la création d'un brouillon de réservation.
 * Le client fournit un intent sémantique (TIME_RANGE ou DAY_RANGE),
 * une locale, et des lignes. Le moteur de pricing flexible calcule
 * tous les montants et snapshots côté serveur.
 */
export interface FlexibleCreateBookingDraftInput {
  pricingMode: 'FLEXIBLE';
  organizationId: string;
  locationId: string;
  customerUserId: string;
  locale: string;
  intent: FlexibleBookingDraftIntent;
  lines: CreateBookingDraftInputLine[];
  idempotencyKey: string;
}

/**
 * Entrée de la primitive de haut niveau `createBookingDraftWithHold`.
 *
 * Union discriminée sur `pricingMode` :
 * - `undefined` ou `'LEGACY'` → chemin legacy (compatibilité ascendante).
 * - `'FLEXIBLE'` → chemin flexible (moteur G7P-B1).
 */
export type CreateBookingDraftInput =
  LegacyCreateBookingDraftInput | FlexibleCreateBookingDraftInput;

/** Allocation d'un exemplaire physique à une ligne de brouillon. */
export interface BookingDraftAllocation {
  allocationId: string;
  inventoryBlockId: string;
  inventoryItemId: string;
  internalSku: string;
}

/** Ligne de la réponse JSON stable d'un brouillon de réservation (legacy). */
export interface BookingDraftResponseLine {
  lineId: string;
  variantId: string;
  quantity: number;
  unitPriceAmountMinor: number;
  billableUnitCount: number;
  lineTotalAmountMinor: number;
  currency: 'EUR';
  variantSnapshot: VariantPricingSnapshot;
  allocations: BookingDraftAllocation[];
}

/**
 * Ligne de la réponse JSON stable d'un brouillon flexible.
 * Étend la ligne legacy avec les champs de snapshot de pricing flexible.
 */
export interface FlexibleBookingDraftResponseLine extends BookingDraftResponseLine {
  pricingPlanId: string;
  pricingPlanVersion: number;
  pricingPlanType: 'HOURLY' | 'FIXED_DURATION' | 'DAILY';
  pricingPublicLabel: string;
  pricingRequestedDurationMinutes: number | null;
  pricingBilledDurationMinutes: number | null;
  pricingCoveredDurationMinutes: number | null;
  pricingBilledDays: number | null;
  pricingSelectedWindow: PricingWindowSnapshot | null;
  pricingDiscountThresholdDays: number | null;
  pricingDiscountPercent: number | null;
  pricingAmountBeforeDiscountMinor: number | null;
  pricingAmountAfterDiscountMinor: number | null;
}

/**
 * Corps de réponse JSON stable d'un brouillon de réservation en succès (ADR-009).
 * Sérialisé tel quel dans idempotency_records.response_body pour le replay.
 *
 * `billableUnit` est élargi à `'DAY' | 'MINUTE'` pour supporter le mode flexible
 * (TIME_RANGE → MINUTE). Le chemin legacy fixe toujours `'DAY'`.
 */
export interface BookingDraftResponseBody {
  draftId: string;
  status: 'HELD';
  organizationId: string;
  locationId: string;
  customerUserId: string;
  customerStartAt: string;
  customerEndAt: string;
  blockedStartAt: string;
  blockedEndAt: string;
  expiresAt: string;
  currency: 'EUR';
  billableUnit: 'DAY' | 'MINUTE';
  billableUnitCount: number;
  subtotalAmountMinor: number;
  mandatoryFeesAmountMinor: number;
  totalAmountMinor: number;
  // G7P-B2-C Round 3 (P0-2) — tax/commission are UNDETERMINED/null at draft
  // stage per ADR-010 §6 for both legacy and flexible drafts. They are resolved
  // at payment initiation and copied from `payments` during confirmation.
  taxStatus: 'UNDETERMINED';
  taxAmountMinor: null;
  taxRateBps: number | null;
  commissionAmountMinor: null;
  cancellationPolicySnapshot: {
    policy_code: string;
    policy_version: string;
    timezone: string;
  };
  lines: BookingDraftResponseLine[];
}

/**
 * Corps de réponse JSON stable d'un brouillon flexible en succès.
 * Étend le corps legacy avec les métadonnées de pricing flexible.
 * Les lignes sont du type `FlexibleBookingDraftResponseLine[]`.
 */
export interface FlexibleBookingDraftResponseBody extends BookingDraftResponseBody {
  pricingSnapshotVersion: 'flexible-pricing-v1';
  pricingAlgorithmVersion: string;
  pricingRoundingRuleVersion: string;
  pricingIntentType: 'TIME_RANGE' | 'DAY_RANGE';
  pricingIntentSnapshot: Record<string, unknown>;
  pricingResolvedLocale: string;
  timezone: string;
  lines: FlexibleBookingDraftResponseLine[];
}

/** Union des corps de réponse en succès (legacy ou flexible). */
export type BookingDraftSuccessBody = BookingDraftResponseBody | FlexibleBookingDraftResponseBody;

/**
 * Corps de réponse JSON stable d'un échec métier persisté (ADR-009).
 * Sérialisé tel quel dans idempotency_records.response_body pour le replay.
 */
export interface BookingDraftFailureBody {
  error: ActionErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface CreateBookingDraftSuccess {
  kind: 'SUCCESS';
  statusCode: 201;
  resourceId: string;
  body: BookingDraftSuccessBody;
}

export interface CreateBookingDraftFailure {
  kind: 'FAILURE';
  statusCode: 400 | 404 | 409;
  resourceId: null;
  body: BookingDraftFailureBody;
}

/** Résultat discriminé de `createBookingDraftWithHold`. */
export type CreateBookingDraftResult = CreateBookingDraftSuccess | CreateBookingDraftFailure;

// ─────────────────────────────────────────────────────────────────────────────
// Lot 4, étape 5 — Expiration batch des brouillons (ADR-009 §15)
// ─────────────────────────────────────────────────────────────────────────────

/** Anomalie d'invariant détectée pendant l'expiration batch. */
export interface BatchExpirationAnomaly {
  draftId: string;
  reason: string;
  details: Record<string, unknown>;
}

/** Brouillon expiré avec succès. */
export interface BatchExpirationExpired {
  draftId: string;
  expiredAt: string; // ISO 8601
  blockIds: string[];
  allocationIds: string[];
}

/** Résultat de l'expiration batch. */
export interface ExpireBookingDraftsBatchResult {
  expired: BatchExpirationExpired[];
  anomalies: BatchExpirationAnomaly[];
  processedCount: number;
  expiredCount: number;
  anomalyCount: number;
  batchLimit: number;
}
