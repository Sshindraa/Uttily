/**
 * @uttily/core — Validation pure des invariants d'un ensemble d'effets outbox
 * (G5D Round 4, ADR-013 §11).
 *
 * Fonction PURE partagée entre Phase A et Phase C. Aucune dépendance SQL, aucun
 * effet de bord. Toutes les vérifications sont déterministes et reproductibles.
 *
 * Invariants validés :
 * 1. Exactement 4 effets.
 * 2. Exactement un effet pour chaque type attendu (GENERATE_CONFIRMATION,
 *    GENERATE_CONTRACT, GENERATE_RECEIPT, SEND_EMAIL).
 * 3. Tous les statuts appartiennent à l'union fermée ('PENDING' | 'COMPLETED' | 'FAILED').
 * 4. idempotency_key exact pour chaque effet : effectIdempotencyKey(outboxEventId, effectType).
 * 5. SEND_EMAIL : storage_key === null, document_id === null.
 * 6. GENERATE_* PENDING : storage_key !== null.
 *    GENERATE_* COMPLETED : document_id !== null et storage_key !== null.
 * 7. storage_key au format UUID quand non-null (ADR-013 : opaque UUID, version non contrainte).
 */

import type { OutboxEffectType } from './types';
import { ALL_EFFECTS, GENERATE_EFFECTS, effectIdempotencyKey } from './effect-mapping';

/** Ligne d'effet validée (forme canonique pour la validation pure). */
export interface EffectValidationRow {
  readonly effectType: OutboxEffectType;
  readonly status: string;
  readonly documentId: string | null;
  readonly storageKey: string | null;
  readonly idempotencyKey: string;
}

/** Regex UUID format (insensible à la casse, ADR-013 : storage_key opaque UUID, version non contrainte). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_STATUSES = new Set(['PENDING', 'COMPLETED', 'FAILED']);

/**
 * Valide un ensemble d'effets outbox pour un événement donné.
 *
 * @param inputs.effects Les effets relus depuis PostgreSQL (forme canoniale).
 * @param inputs.outboxEventId L'ID de l'événement outbox propriétaire des effets.
 * @throws Error('EFFECT_SET_INVARIANT_VIOLATED') si un invariant est violé.
 */
export function validateEffectSet(inputs: {
  readonly effects: readonly EffectValidationRow[];
  readonly outboxEventId: string;
}): void {
  const { effects, outboxEventId } = inputs;

  // 1. Exactement 4 effets.
  if (effects.length !== 4) {
    throw new Error('EFFECT_SET_INVARIANT_VIOLATED');
  }

  // 2. Exactement un effet pour chaque type attendu.
  const expectedTypes = [...ALL_EFFECTS].sort() as string[];
  const actualTypes = effects.map((e) => e.effectType).sort();
  for (let i = 0; i < expectedTypes.length; i++) {
    if (actualTypes[i] !== expectedTypes[i]) {
      throw new Error('EFFECT_SET_INVARIANT_VIOLATED');
    }
  }

  // 3. Tous les statuts appartiennent à l'union fermée.
  for (const e of effects) {
    if (!VALID_STATUSES.has(e.status)) {
      throw new Error('EFFECT_SET_INVARIANT_VIOLATED');
    }
  }

  // 4. idempotency_key exact pour chaque effet.
  for (const e of effects) {
    const expected = effectIdempotencyKey(outboxEventId, e.effectType);
    if (e.idempotencyKey !== expected) {
      throw new Error('EFFECT_SET_INVARIANT_VIOLATED');
    }
  }

  // 5. SEND_EMAIL invariants : storage_key === null, document_id === null.
  const sendEmail = effects.find((e) => e.effectType === 'SEND_EMAIL');
  if (!sendEmail) {
    throw new Error('EFFECT_SET_INVARIANT_VIOLATED');
  }
  if (sendEmail.storageKey !== null || sendEmail.documentId !== null) {
    throw new Error('EFFECT_SET_INVARIANT_VIOLATED');
  }

  // 6 & 7. GENERATE_* invariants + storage_key UUID format.
  for (const e of effects) {
    if (!GENERATE_EFFECTS.includes(e.effectType)) continue;

    if (e.status === 'PENDING') {
      if (e.storageKey === null) {
        throw new Error('EFFECT_SET_INVARIANT_VIOLATED');
      }
    } else if (e.status === 'COMPLETED') {
      if (e.documentId === null || e.storageKey === null) {
        throw new Error('EFFECT_SET_INVARIANT_VIOLATED');
      }
    }

    // storage_key UUID format validation when non-null.
    if (e.storageKey !== null && !UUID_RE.test(e.storageKey)) {
      throw new Error('EFFECT_SET_INVARIANT_VIOLATED');
    }
  }
}
