/**
 * @uttily/core — Types publics pour la mutation createNeutralBookingAmendment (G7M-B2-A).
 *
 * ADR-023 §3-9, §11-13, §15 : amendements NEUTRAL append-only sur réservation
 * CONFIRMED. Seul le type NEUTRAL (delta financier nul) est implémenté dans ce lot.
 * REFUND et SUPPLEMENT sont différés.
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
