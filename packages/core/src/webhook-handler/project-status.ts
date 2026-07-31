/**
 * @uttily/core — Projection monotone du statut de tentative (Lot 5, ADR-010 §11).
 *
 * Fonction pure testable unitairement. Le statut local est une projection
 * monotone : un statut terminal ne régresse jamais. Un événement inconnu ou un
 * statut non pris en charge ne doit pas être silencieusement transformé en
 * statut connu (fail-closed).
 */

import { TERMINAL_ATTEMPT_STATUSES } from './types';

/** Résultat de la projection monotone. */
export interface ProjectionResult {
  /** Nouveau statut local à appliquer, ou null si l'événement doit être ignoré. */
  newStatus: string | null;
  /** true si l'événement a été ignoré (désordre ou déjà terminal). */
  ignored: boolean;
}

/**
 * Projette le statut d'un événement webhook vers le statut local de la
 * tentative de paiement, en respectant la monotonicité.
 *
 * Règles (ADR-010 §11) :
 * - `payment_intent.succeeded` → SUCCEEDED (terminal).
 * - `payment_intent.processing` → PROCESSING (non terminal). Ignoré si déjà terminal.
 * - `payment_intent.payment_failed` → REQUIRES_PAYMENT_METHOD. Ignoré si déjà terminal.
 * - `payment_intent.canceled` → CANCELLED (terminal).
 * - Un statut terminal ne régresse jamais.
 * - Un événement inconnu → ignored (fail-closed, pas de transformation silencieuse).
 *
 * @param eventType Type d'événement Stripe (ex: 'payment_intent.succeeded').
 * @param currentStatus Statut local actuel de la tentative.
 * @returns ProjectionResult avec le nouveau statut ou ignored.
 */
export function projectAttemptStatus(eventType: string, currentStatus: string): ProjectionResult {
  const isTerminal = (TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(currentStatus);

  // Si déjà terminal, on ignore tout événement non-terminal (pas de régression).
  // Les événements terminaux (succeeded/canceled) sont gérés explicitement plus bas
  // car ils peuvent légitimement arriver en doublon (idempotence).

  switch (eventType) {
    case 'payment_intent.succeeded':
      // SUCCEEDED est terminal. Si déjà SUCCEEDED, doublon → ignoré.
      if (currentStatus === 'SUCCEEDED') {
        return { newStatus: null, ignored: true };
      }
      // Si déjà terminal avec un autre statut (FAILED/CANCELLED), c'est une
      // incohérence — on ne régresse pas. L'appelant doit détecter l'anomalie.
      if (isTerminal) {
        return { newStatus: null, ignored: true };
      }
      return { newStatus: 'SUCCEEDED', ignored: false };

    case 'payment_intent.canceled':
      // CANCELLED est terminal. Si déjà CANCELLED, doublon → ignoré.
      if (currentStatus === 'CANCELLED') {
        return { newStatus: null, ignored: true };
      }
      // Si déjà terminal avec un autre statut (SUCCEEDED/FAILED), incohérence.
      if (isTerminal) {
        return { newStatus: null, ignored: true };
      }
      return { newStatus: 'CANCELLED', ignored: false };

    case 'payment_intent.processing':
      // PROCESSING est non terminal. Si déjà terminal, on ignore (pas de régression).
      if (isTerminal) {
        return { newStatus: null, ignored: true };
      }
      // Si déjà PROCESSING, pas de changement.
      if (currentStatus === 'PROCESSING') {
        return { newStatus: null, ignored: true };
      }
      return { newStatus: 'PROCESSING', ignored: false };

    case 'payment_intent.payment_failed':
      // REQUIRES_PAYMENT_METHOD est non terminal. Si déjà terminal, on ignore.
      if (isTerminal) {
        return { newStatus: null, ignored: true };
      }
      // Si déjà REQUIRES_PAYMENT_METHOD, pas de changement.
      if (currentStatus === 'REQUIRES_PAYMENT_METHOD') {
        return { newStatus: null, ignored: true };
      }
      return { newStatus: 'REQUIRES_PAYMENT_METHOD', ignored: false };

    default:
      // Événement inconnu ou non géré → fail-closed (ignoré, pas de transformation).
      return { newStatus: null, ignored: true };
  }
}

/**
 * Détermine si un événement webhook est plus ancien que le dernier traité
 * pour le même PaymentIntent, en utilisant le timestamp Stripe
 * (`provider_event_created_at`).
 *
 * @param eventCreatedAt Timestamp de l'événement reçu (Unix secondes).
 * @param lastProcessedCreatedAt Timestamp du dernier événement traité (Unix secondes), ou null si aucun.
 * @returns true si l'événement est plus ancien (désordre).
 */
export function isStaleEvent(
  eventCreatedAt: number,
  lastProcessedCreatedAt: number | null,
): boolean {
  if (lastProcessedCreatedAt === null) {
    return false;
  }
  return eventCreatedAt < lastProcessedCreatedAt;
}
