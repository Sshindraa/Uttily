/**
 * @uttily/core — Sélection de handler pour la revendication d'événements outbox
 * (G5D, ADR-013 §7).
 *
 * La sélection est un type union FERMÉ. Un handler ne doit jamais prendre un
 * événement appartenant à un autre handler. Seules les sélections connues
 * (BOOKING_CONFIRMED, PAYMENT_COMPENSATION) sont acceptées par claimOutboxBatch.
 *
 * Aucune construction SQL à partir de valeurs libres — les valeurs sont
 * utilisées comme paramètres bindés dans les requêtes paramétrées (sql template),
 * jamais interpolées via sql.raw.
 */

/**
 * Sélection de handler connue (union fermée).
 *
 * Chaque variante porte un `kind` discriminant, les trois champs de filtrage
 * (eventType, eventVersion, aggregateType) et garantit qu'un handler ne claim
 * que ses propres événements.
 */
export type KnownHandlerSelection =
  | {
      readonly kind: 'BOOKING_CONFIRMED';
      readonly eventType: 'BOOKING_CONFIRMED';
      readonly eventVersion: 'v1';
      readonly aggregateType: 'BOOKING';
    }
  | {
      readonly kind: 'PAYMENT_COMPENSATION';
      readonly eventType: 'PAYMENT_COMPENSATION_REQUESTED';
      readonly eventVersion: 'v1';
      readonly aggregateType: 'PAYMENT';
    };

/** Sélection de handler pour BOOKING_CONFIRMED.v1/BOOKING (pipeline documentaire). */
export const BOOKING_CONFIRMED_SELECTION: KnownHandlerSelection = {
  kind: 'BOOKING_CONFIRMED',
  eventType: 'BOOKING_CONFIRMED',
  eventVersion: 'v1',
  aggregateType: 'BOOKING',
} as const;

/** Sélection de handler pour PAYMENT_COMPENSATION_REQUESTED.v1/PAYMENT (compensation). */
export const PAYMENT_COMPENSATION_SELECTION: KnownHandlerSelection = {
  kind: 'PAYMENT_COMPENSATION',
  eventType: 'PAYMENT_COMPENSATION_REQUESTED',
  eventVersion: 'v1',
  aggregateType: 'PAYMENT',
} as const;

/**
 * Valide qu'une sélection inconnue correspond exactement à une KnownHandlerSelection
 * fermée. Vérifie le `kind` discriminant + les valeurs exactes des tuples.
 *
 * @throws Error si la sélection est invalide ou inconnue.
 */
const REQUIRED_KEYS = ['kind', 'eventType', 'eventVersion', 'aggregateType'] as const;
const REQUIRED_KEYS_SORTED = [...REQUIRED_KEYS].sort();

export function validateHandlerSelection(selection: unknown): KnownHandlerSelection {
  if (typeof selection !== 'object' || selection === null) {
    throw new Error('HandlerSelection invalide : doit être un objet');
  }
  if (Array.isArray(selection)) {
    throw new Error("HandlerSelection invalide : un tableau n'est pas une sélection valide");
  }
  const s = selection as Record<string, unknown>;

  // Reject objects with extra or missing keys — exactly the 4 required keys.
  const actualKeys = Object.keys(s).sort();
  if (actualKeys.length !== REQUIRED_KEYS_SORTED.length) {
    throw new Error('HandlerSelection invalide : nombre de clés incorrect');
  }
  for (let i = 0; i < REQUIRED_KEYS_SORTED.length; i++) {
    if (actualKeys[i] !== REQUIRED_KEYS_SORTED[i]) {
      throw new Error('HandlerSelection invalide : clés manquantes ou supplémentaires');
    }
  }

  if (s.kind === 'BOOKING_CONFIRMED') {
    if (
      s.eventType === 'BOOKING_CONFIRMED' &&
      s.eventVersion === 'v1' &&
      s.aggregateType === 'BOOKING'
    ) {
      return {
        kind: 'BOOKING_CONFIRMED',
        eventType: 'BOOKING_CONFIRMED',
        eventVersion: 'v1',
        aggregateType: 'BOOKING',
      };
    }
    throw new Error('HandlerSelection BOOKING_CONFIRMED invalide : champs incorrects');
  }
  if (s.kind === 'PAYMENT_COMPENSATION') {
    if (
      s.eventType === 'PAYMENT_COMPENSATION_REQUESTED' &&
      s.eventVersion === 'v1' &&
      s.aggregateType === 'PAYMENT'
    ) {
      return {
        kind: 'PAYMENT_COMPENSATION',
        eventType: 'PAYMENT_COMPENSATION_REQUESTED',
        eventVersion: 'v1',
        aggregateType: 'PAYMENT',
      };
    }
    throw new Error('HandlerSelection PAYMENT_COMPENSATION invalide : champs incorrects');
  }
  throw new Error('HandlerSelection invalide : kind inconnu ou absent');
}
