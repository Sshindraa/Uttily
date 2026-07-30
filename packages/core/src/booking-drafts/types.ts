import type { ActionErrorCode } from '@uttily/contracts';
import type { VariantPricingSnapshot } from '../pricing/types';

/**
 * Ligne d'entrée pour la création d'un brouillon de réservation.
 * Le client ne fournit JAMAIS : prix, devise, taxes, commission, fuseau,
 * marges, snapshots, politique d'annulation.
 */
export interface CreateBookingDraftInputLine {
  variantId: string;
  quantity: number;
}

/**
 * Entrée de la primitive de haut niveau `createBookingDraftWithHold`.
 *
 * Toutes les données fournies par le client sont sémantiques (identifiants,
 * dates, lignes). Les champs monétaires et de snapshot sont calculés
 * côté serveur.
 */
export interface CreateBookingDraftInput {
  organizationId: string;
  locationId: string;
  customerUserId: string;
  customerStartAt: Date;
  customerEndAt: Date;
  lines: CreateBookingDraftInputLine[];
  idempotencyKey: string;
}

/** Allocation d'un exemplaire physique à une ligne de brouillon. */
export interface BookingDraftAllocation {
  allocationId: string;
  inventoryBlockId: string;
  inventoryItemId: string;
  internalSku: string;
}

/** Ligne de la réponse JSON stable d'un brouillon de réservation. */
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
 * Corps de réponse JSON stable d'un brouillon de réservation en succès (ADR-009).
 * Sérialisé tel quel dans idempotency_records.response_body pour le replay.
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
  billableUnit: 'DAY';
  billableUnitCount: number;
  subtotalAmountMinor: number;
  mandatoryFeesAmountMinor: number;
  totalAmountMinor: number;
  taxStatus: 'UNDETERMINED';
  taxAmountMinor: null;
  taxRateBps: null;
  commissionAmountMinor: null;
  cancellationPolicySnapshot: {
    policy_code: string;
    policy_version: string;
    timezone: string;
  };
  lines: BookingDraftResponseLine[];
}

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
  body: BookingDraftResponseBody;
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
