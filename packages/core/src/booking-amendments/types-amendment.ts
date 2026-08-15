export type LineAction = 'ADD' | 'MODIFY' | 'REMOVE' | 'UNCHANGED';

/**
 * @uttily/core — Types publics pour la mutation createNeutralBookingAmendment (G7M-B2-A).
 *
 * ADR-023 §3-9, §11-13, §15 : amendements NEUTRAL append-only sur réservation
 * CONFIRMED. NEUTRAL et REFUND sont appliqués directement ; SUPPLEMENT est
 * créé localement en HOLD_PENDING avant tout appel Stripe.
 *
 * Le résultat est une union fermée (closed union) : chaque variante correspond
 * à un échec ou succès métier déterministe. Les erreurs inattendues uniquement
 * lèvent NeutralAmendmentError.
 */

/**
 * Intention tarifaire sémantique pour l'amendement neutre.
 */
export type NeutralAmendmentIntent =
  | { readonly kind: 'TIME_RANGE'; readonly startAt: string; readonly endAt: string }
  | { readonly kind: 'DAY_RANGE'; readonly startDate: string; readonly endDateExclusive: string };

/**
 * Commande d'amendement neutre.
 *
 * `expectedLastAppliedAmendmentNumber` protège contre la concurrence (optimistic
 * locking) : l'appelant a lu l'état effectif via getEffectiveBooking et fournit
 * le `lastAppliedAmendmentNumber` observé. Sous les verrous, si la valeur a
 * changé, le résultat est STALE_EFFECTIVE_BOOKING.
 *
 * `intent` porte l'intention tarifaire sémantique (TIME_RANGE ou DAY_RANGE).
 *
 * `desiredLines` décrit l'état CIBLE complet (after). Le diff avec l'état
 * effectif courant détermine les actions ADD/MODIFY/REMOVE/UNCHANGED.
 *
 * `logicalLineId` : présent = ligne existante (identité stable) ; absent = nouvelle
 * ligne (un UUID est généré côté serveur).
 */
export interface NeutralAmendmentCommand {
  readonly bookingId: string;
  readonly expectedLastAppliedAmendmentNumber: number;
  readonly intent: NeutralAmendmentIntent;
  readonly desiredLines: readonly NeutralAmendmentDesiredLine[];
  readonly idempotencyKey: string;
}

/**
 * Ligne désirée dans l'état cible (after).
 */
export interface NeutralAmendmentDesiredLine {
  /** Présent = ligne existante ; absent = nouvelle ligne (UUID généré). */
  readonly logicalLineId?: string;
  readonly variantId: string;
  /** Entier strictement positif (safe integer). */
  readonly quantity: number;
}

/**
 * Résultat fermé de createNeutralBookingAmendment.
 *
 * - SUCCESS : amendement créé et appliqué atomiquement.
 * - REPLAY : clé idempotente déjà terminée, même empreinte — retourne le résultat persisté.
 * - NOT_FOUND : réservation inexistante ou appartenant à une autre organisation (tenant-safe).
 * - FORBIDDEN : utilisateur sans rôle suffisant (OWNER/ADMIN/MANAGER requis).
 * - BOOKING_NOT_CONFIRMED : la réservation n'est pas CONFIRMED.
 * - ACTIVE_AMENDMENT_EXISTS : un amendement HOLD_PENDING ou READY_TO_APPLY existe déjà.
 * - STALE_EFFECTIVE_BOOKING : expectedLastAppliedAmendmentNumber ne correspond pas.
 * - INVALID_INPUT : validation des entrées échouée (UUID, dates, quantités, doublons).
 * - AVAILABILITY_CONFLICT : chevauchement d'inventaire avec une autre réservation.
 * - FINANCIAL_ACTION_REQUIRED : delta non-nul (REFUND ou SUPPLEMENT requis, pas NEUTRAL).
 * - IDEMPOTENCY_CONFLICT : même clé idempotente avec une empreinte différente.
 */
export type NeutralAmendmentResult =
  | { readonly kind: 'SUCCESS'; readonly amendmentId: string; readonly amendmentNumber: number }
  | { readonly kind: 'REPLAY'; readonly amendmentId: string; readonly amendmentNumber: number }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'FORBIDDEN' }
  | { readonly kind: 'BOOKING_NOT_CONFIRMED' }
  | { readonly kind: 'ACTIVE_AMENDMENT_EXISTS' }
  | { readonly kind: 'STALE_EFFECTIVE_BOOKING'; readonly expected: number; readonly actual: number }
  | { readonly kind: 'INVALID_INPUT'; readonly message: string }
  | { readonly kind: 'AVAILABILITY_CONFLICT'; readonly message: string }
  | {
      readonly kind: 'FINANCIAL_ACTION_REQUIRED';
      readonly classification: 'REFUND' | 'SUPPLEMENT';
      readonly deltaMinor: number;
    }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' };

/**
 * Codes d'erreur fermés pour NeutralAmendmentError.
 * Utilisé uniquement pour les erreurs internes inattendues (pas pour les
 * échecs métier qui utilisent l'union NeutralAmendmentResult).
 */
export type NeutralAmendmentErrorCode = 'VALIDATION' | 'INTERNAL';

const NEUTRAL_AMENDMENT_ERROR_CODES: readonly NeutralAmendmentErrorCode[] = [
  'VALIDATION',
  'INTERNAL',
];

/**
 * Type guard : vérifie qu'une valeur est un NeutralAmendmentErrorCode valide.
 */
export function isNeutralAmendmentErrorCode(value: unknown): value is NeutralAmendmentErrorCode {
  return (
    typeof value === 'string' &&
    (NEUTRAL_AMENDMENT_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Erreur typée pour createNeutralBookingAmendment.
 *
 * Pattern identique à EffectiveBookingError : codes fermés, pas de string matching.
 * Préférer retourner un variant de NeutralAmendmentResult pour tous les échecs
 * métier déterministes. Lancer uniquement pour les erreurs internes inattendues.
 */
export class NeutralAmendmentError extends Error {
  readonly code: NeutralAmendmentErrorCode;

  constructor(code: NeutralAmendmentErrorCode, message: string) {
    super(message);
    this.name = 'NeutralAmendmentError';
    this.code = code;
  }
}

/**
 * Commande d'amendement de type REFUND (G7M-B2-B1).
 */
export type RefundAmendmentCommand = NeutralAmendmentCommand;

/**
 * Résultat fermé de createRefundBookingAmendment (G7M-B2-B1).
 */
export type RefundAmendmentResult =
  | {
      readonly kind: 'SUCCESS';
      readonly amendmentId: string;
      readonly amendmentNumber: number;
      readonly refundId: string;
      readonly refundAmountMinor: number;
    }
  | {
      readonly kind: 'REPLAY';
      readonly amendmentId: string;
      readonly amendmentNumber: number;
      readonly refundId: string;
      readonly refundAmountMinor: number;
    }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'FORBIDDEN' }
  | { readonly kind: 'BOOKING_NOT_CONFIRMED' }
  | { readonly kind: 'ACTIVE_AMENDMENT_EXISTS' }
  | { readonly kind: 'STALE_EFFECTIVE_BOOKING'; readonly expected: number; readonly actual: number }
  | { readonly kind: 'INVALID_INPUT'; readonly message: string }
  | { readonly kind: 'AVAILABILITY_CONFLICT'; readonly message: string }
  | {
      readonly kind: 'FINANCIAL_ACTION_REQUIRED';
      readonly classification: 'NEUTRAL' | 'SUPPLEMENT';
      readonly deltaMinor: number;
    }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' };

/** Commande d'initialisation locale d'un supplément (G7M-C1). */
export type SupplementAmendmentCommand = NeutralAmendmentCommand;

/**
 * Résultat fermé de createSupplementBookingAmendment.
 *
 * Aucun client secret ni identifiant provider n'est produit par G7M-C1 : la
 * réponse expose uniquement les identifiants durables et la borne du hold.
 */
export type SupplementAmendmentResult =
  | {
      readonly kind: 'SUCCESS';
      readonly amendmentId: string;
      readonly amendmentNumber: number;
      readonly amendmentPaymentId: string;
      readonly amendmentPaymentAttemptId: string;
      readonly supplementAmountMinor: number;
      readonly holdDeadline: string;
    }
  | {
      readonly kind: 'REPLAY';
      readonly amendmentId: string;
      readonly amendmentNumber: number;
      readonly amendmentPaymentId: string;
      readonly amendmentPaymentAttemptId: string;
      readonly supplementAmountMinor: number;
      readonly holdDeadline: string;
    }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'FORBIDDEN' }
  | { readonly kind: 'BOOKING_NOT_CONFIRMED' }
  | { readonly kind: 'ACTIVE_AMENDMENT_EXISTS' }
  | { readonly kind: 'STALE_EFFECTIVE_BOOKING'; readonly expected: number; readonly actual: number }
  | { readonly kind: 'INVALID_INPUT'; readonly message: string }
  | { readonly kind: 'AVAILABILITY_CONFLICT'; readonly message: string }
  | {
      readonly kind: 'FINANCIAL_ACTION_REQUIRED';
      readonly classification: 'NEUTRAL' | 'REFUND';
      readonly deltaMinor: number;
    }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' };

/** Codes fermés pour les erreurs internes de création locale du supplément. */
export type SupplementAmendmentErrorCode = 'VALIDATION' | 'INTERNAL';

const SUPPLEMENT_AMENDMENT_ERROR_CODES: readonly SupplementAmendmentErrorCode[] = [
  'VALIDATION',
  'INTERNAL',
];

export function isSupplementAmendmentErrorCode(
  value: unknown,
): value is SupplementAmendmentErrorCode {
  return (
    typeof value === 'string' &&
    (SUPPLEMENT_AMENDMENT_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** Erreur typée réservée aux anomalies internes du flux SUPPLEMENT. */
export class SupplementAmendmentError extends Error {
  readonly code: SupplementAmendmentErrorCode;

  constructor(code: SupplementAmendmentErrorCode, message: string) {
    super(message);
    this.name = 'SupplementAmendmentError';
    this.code = code;
  }
}

/**
 * Codes d'erreur fermés pour RefundAmendmentError.
 */
export type RefundAmendmentErrorCode = 'VALIDATION' | 'INTERNAL';

export function isRefundAmendmentErrorCode(value: unknown): value is RefundAmendmentErrorCode {
  return (
    typeof value === 'string' &&
    (NEUTRAL_AMENDMENT_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Erreur typée pour createRefundBookingAmendment.
 */
export class RefundAmendmentError extends Error {
  readonly code: RefundAmendmentErrorCode;

  constructor(code: RefundAmendmentErrorCode, message: string) {
    super(message);
    this.name = 'RefundAmendmentError';
    this.code = code;
  }
}

/**
 * Commande de prévisualisation d'amendement de réservation (G7M-C5-A).
 *
 * Strictement read-only : aucune clé d'idempotence requise.
 */
export interface PreviewBookingAmendmentCommand {
  readonly bookingId: string;
  readonly expectedLastAppliedAmendmentNumber: number;
  readonly intent: NeutralAmendmentIntent;
  readonly desiredLines: readonly NeutralAmendmentDesiredLine[];
}

/**
 * Ligne du diff de prévisualisation avec libellés publics sûrs (G7M-C5-A).
 *
 * Aucune PII, numéro de série ou donnée provider exposée.
 */
export interface PreviewLineDiffEntry {
  readonly logicalLineId: string;
  readonly variantId: string;
  readonly productName: string;
  readonly variantName: string;
  readonly action: LineAction;
  readonly beforeQuantity: number;
  readonly afterQuantity: number;
  readonly beforeLineTotalAmountMinor: number;
  readonly afterLineTotalAmountMinor: number;
}

/**
 * Résultat de prévisualisation réussie (G7M-C5-A).
 */
export interface PreviewBookingAmendmentSuccess {
  readonly kind: 'SUCCESS';
  readonly bookingId: string;
  readonly locationId: string;
  readonly locationTimeZone: string;
  readonly lastAppliedAmendmentNumber: number;
  readonly classification: 'NEUTRAL' | 'REFUND' | 'SUPPLEMENT';
  readonly previousCustomerStartAt: Date;
  readonly previousCustomerEndAt: Date;
  readonly nextCustomerStartAt: Date;
  readonly nextCustomerEndAt: Date;
  readonly previousContractualTotalAmountMinor: number;
  readonly nextContractualTotalAmountMinor: number;
  readonly deltaAmountMinor: number;
  readonly currency: 'EUR';
  readonly supplementCommissionAmountMinor: number | null;
  readonly supplementNetAmountMinor: number | null;
  readonly lines: readonly PreviewLineDiffEntry[];
}

/**
 * Résultat fermé de previewBookingAmendment (G7M-C5-A).
 */
export type PreviewBookingAmendmentResult =
  | PreviewBookingAmendmentSuccess
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'FORBIDDEN' }
  | { readonly kind: 'BOOKING_NOT_CONFIRMED' }
  | { readonly kind: 'ACTIVE_AMENDMENT_EXISTS' }
  | { readonly kind: 'STALE_EFFECTIVE_BOOKING'; readonly expected: number; readonly actual: number }
  | { readonly kind: 'INVALID_INPUT'; readonly message: string }
  | { readonly kind: 'AVAILABILITY_CONFLICT'; readonly message: string };

/**
 * Codes d'erreur fermés pour PreviewBookingAmendmentError.
 */
export type PreviewBookingAmendmentErrorCode = 'VALIDATION' | 'INTERNAL';

const PREVIEW_AMENDMENT_ERROR_CODES: readonly PreviewBookingAmendmentErrorCode[] = [
  'VALIDATION',
  'INTERNAL',
];

export function isPreviewBookingAmendmentErrorCode(
  value: unknown,
): value is PreviewBookingAmendmentErrorCode {
  return (
    typeof value === 'string' &&
    (PREVIEW_AMENDMENT_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Erreur typée pour previewBookingAmendment (erreurs internes inattendues uniquement).
 */
export class PreviewBookingAmendmentError extends Error {
  readonly code: PreviewBookingAmendmentErrorCode;

  constructor(code: PreviewBookingAmendmentErrorCode, message: string) {
    super(message);
    this.name = 'PreviewBookingAmendmentError';
    this.code = code;
  }
}

/**
 * Commande de confirmation d'amendement de réservation (G7M-C5-B).
 */
export interface ConfirmBookingAmendmentCommand {
  readonly bookingId: string;
  readonly expectedLastAppliedAmendmentNumber: number;
  readonly intent: NeutralAmendmentIntent;
  readonly desiredLines: readonly NeutralAmendmentDesiredLine[];
  readonly idempotencyKey: string;
  readonly expectedClassification: 'NEUTRAL' | 'REFUND' | 'SUPPLEMENT';
  readonly expectedDeltaAmountMinor: number;
  readonly expectedNextTotalAmountMinor: number;
}

/**
 * Succès de confirmation pour un amendement NEUTRAL appliqué immédiatement (G7M-C5-B).
 */
export interface ConfirmBookingAmendmentAppliedNeutral {
  readonly kind: 'APPLIED_NEUTRAL';
  readonly amendmentId: string;
  readonly amendmentNumber: number;
  readonly bookingId: string;
  readonly isReplay: boolean;
}

/**
 * Succès de confirmation pour un amendement REFUND appliqué immédiatement avec remboursement PENDING (G7M-C5-B).
 */
export interface ConfirmBookingAmendmentAppliedRefund {
  readonly kind: 'APPLIED_REFUND';
  readonly amendmentId: string;
  readonly amendmentNumber: number;
  readonly bookingId: string;
  readonly refundAmountMinor: number;
  readonly currency: 'EUR';
  readonly isReplay: boolean;
}

/**
 * Succès de confirmation pour un amendement SUPPLEMENT avec hold local en attente de paiement (G7M-C5-B).
 */
export interface ConfirmBookingAmendmentPaymentRequired {
  readonly kind: 'PAYMENT_REQUIRED';
  readonly amendmentId: string;
  readonly amendmentNumber: number;
  readonly bookingId: string;
  readonly supplementAmountMinor: number;
  readonly currency: 'EUR';
  readonly holdDeadline: string;
  readonly isReplay: boolean;
}

/**
 * Union des succès de confirmation d'amendement (G7M-C5-B).
 */
export type ConfirmBookingAmendmentSuccess =
  | ConfirmBookingAmendmentAppliedNeutral
  | ConfirmBookingAmendmentAppliedRefund
  | ConfirmBookingAmendmentPaymentRequired;

/**
 * Résultat fermé de confirmBookingAmendment (G7M-C5-B).
 */
export type ConfirmBookingAmendmentResult =
  | ConfirmBookingAmendmentSuccess
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'FORBIDDEN' }
  | { readonly kind: 'BOOKING_NOT_CONFIRMED' }
  | { readonly kind: 'ACTIVE_AMENDMENT_EXISTS' }
  | { readonly kind: 'STALE_EFFECTIVE_BOOKING'; readonly expected: number; readonly actual: number }
  | { readonly kind: 'AVAILABILITY_CONFLICT'; readonly message: string }
  | { readonly kind: 'INVALID_INPUT'; readonly message: string }
  | { readonly kind: 'PREVIEW_CHANGED' }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'INVALID_STATE' };
