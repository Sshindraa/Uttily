import { createHash } from 'node:crypto';

/**
 * @uttily/core — Empreintes canoniques pour les rapports d'état et de dommages (G3B).
 *
 * Version v1. Les empreintes sont des SHA-256 hexadécimaux (64 caractères)
 * construits à partir d'un JSON canonique avec champs triés alphabétiquement
 * (ordre d'insertion préservé par JS) et encodage UTF-8.
 */

/**
 * Calcule l'empreinte SHA-256 canonique d'un rapport d'état (G3B, v1).
 * Comprend tous les champs métier normalisés : organizationId, bookingId,
 * bookingItemId, actorUserId, phase, condition, notes (normalisé).
 */
export function computeConditionReportFingerprint(input: {
  organizationId: string;
  bookingId: string;
  bookingItemId: string;
  actorUserId: string;
  phase: string;
  condition: string;
  notes: string | null;
}): string {
  const canonical = {
    actor_user_id: input.actorUserId,
    booking_id: input.bookingId,
    booking_item_id: input.bookingItemId,
    condition: input.condition,
    notes: input.notes,
    operation: 'create_condition_report',
    organization_id: input.organizationId,
    phase: input.phase,
    v: 'v1',
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/**
 * Calcule l'empreinte SHA-256 canonique d'une déclaration de dommage (G3B, v1).
 * Comprend tous les champs métier normalisés : organizationId, bookingId,
 * bookingItemId, actorUserId, description (trimée).
 */
export function computeDamageReportFingerprint(input: {
  organizationId: string;
  bookingId: string;
  bookingItemId: string;
  actorUserId: string;
  description: string;
  blocksInventory?: boolean | undefined;
}): string {
  const canonical = {
    actor_user_id: input.actorUserId,
    blocks_inventory: input.blocksInventory ?? false,
    booking_id: input.bookingId,
    booking_item_id: input.bookingItemId,
    description: input.description,
    operation: 'create_damage_report',
    organization_id: input.organizationId,
    v: 'v1',
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
