/**
 * @uttily/core — Mapping effets → types de documents et clés d'idempotence
 * (G5D, ADR-013 §3, §5).
 *
 * Les 4 effets d'un événement BOOKING_CONFIRMED.v1 :
 * - GENERATE_CONFIRMATION → document type CONFIRMATION, template booking-confirmation-technical-v1
 * - GENERATE_CONTRACT → document type CONTRACT, template rental-contract-technical-v1
 * - GENERATE_RECEIPT → document type RECEIPT, template payment-receipt-technical-v1
 * - SEND_EMAIL → pas de document (G5E hors scope), document_id=NULL, storage_key=NULL
 *
 * Les clés d'idempotence sont stables, distinctes par événement+effet, versionnées
 * et non sensibles (aucun bookingId, email, nom ou adresse).
 */

import type { OutboxEffectType, DocumentType } from './types';

export const EFFECT_TO_DOCUMENT_TYPE: Record<OutboxEffectType, DocumentType | null> = {
  GENERATE_CONFIRMATION: 'CONFIRMATION',
  GENERATE_CONTRACT: 'CONTRACT',
  GENERATE_RECEIPT: 'RECEIPT',
  SEND_EMAIL: null,
};

export const EFFECT_TO_TEMPLATE_KEY: Record<OutboxEffectType, string | null> = {
  GENERATE_CONFIRMATION: 'booking-confirmation-technical-v1',
  GENERATE_CONTRACT: 'rental-contract-technical-v1',
  GENERATE_RECEIPT: 'payment-receipt-technical-v1',
  SEND_EMAIL: null,
};

export const GENERATE_EFFECTS: readonly OutboxEffectType[] = [
  'GENERATE_CONFIRMATION',
  'GENERATE_CONTRACT',
  'GENERATE_RECEIPT',
] as const;

export const ALL_EFFECTS: readonly OutboxEffectType[] = [
  'GENERATE_CONFIRMATION',
  'GENERATE_CONTRACT',
  'GENERATE_RECEIPT',
  'SEND_EMAIL',
] as const;

/**
 * Clé d'idempotence pour un effet outbox.
 * Formule : doc_effect_{outboxEventId}_{effectType}_v1
 * Stable, distincte par événement+effet, versionnée, non sensible.
 */
export function effectIdempotencyKey(outboxEventId: string, effectType: OutboxEffectType): string {
  return `doc_effect_${outboxEventId}_${effectType}_v1`;
}

/**
 * Clé d'idempotence pour un document.
 * Formule : doc_{outboxEventId}_{documentType}_v1
 * Stable, distincte par événement+type, versionnée, non sensible.
 */
export function documentIdempotencyKey(outboxEventId: string, documentType: DocumentType): string {
  return `doc_${outboxEventId}_${documentType}_v1`;
}
