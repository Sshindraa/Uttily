/**
 * @uttily/core — Types des documents transactionnels (Lot 6 G5B, ADR-013).
 *
 * La source de vérité des enums est l'enum Drizzle dans @uttily/database.
 * Les types TypeScript sont derives via enumValues pour garantir la coherence
 * avec le schema PostgreSQL.
 */

import {
  documentType,
  outboxEffectType,
  outboxEffectStatus,
  notificationDeliveryStatus,
  documentProcessingFailureCode,
} from '@uttily/database';

export const DOCUMENT_TYPES = documentType.enumValues;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const OUTBOX_EFFECT_TYPES = outboxEffectType.enumValues;
export type OutboxEffectType = (typeof OUTBOX_EFFECT_TYPES)[number];

export const OUTBOX_EFFECT_STATUSES = outboxEffectStatus.enumValues;
export type OutboxEffectStatus = (typeof OUTBOX_EFFECT_STATUSES)[number];

export const NOTIFICATION_DELIVERY_STATUSES = notificationDeliveryStatus.enumValues;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

export const DOCUMENT_PROCESSING_FAILURE_CODES = documentProcessingFailureCode.enumValues;
export type DocumentProcessingFailureCode = (typeof DOCUMENT_PROCESSING_FAILURE_CODES)[number];

/**
 * Document rendu par DocumentRenderer.
 * Le binaire est en Uint8Array (pas de dépendance à Node Buffer).
 */
export interface RenderedDocument {
  readonly content: Uint8Array;
  readonly contentType: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
}

/**
 * Métadonnées d'un objet stocké dans ObjectStorage.
 * checksumSha256 est null si le fournisseur ne persiste pas de checksum fiable.
 */
export interface StoredObjectMetadata {
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string | null;
}

/**
 * Résultat de putIfAbsent : CREATED ou ALREADY_EXISTS avec métadonnées.
 */
export type ObjectStoragePutResult =
  | { readonly kind: 'CREATED' }
  | { readonly kind: 'ALREADY_EXISTS'; readonly metadata: StoredObjectMetadata };

/**
 * Input d'envoi d'email transactionnel.
 * providerIdempotencyKey est OBLIGATOIRE pour la déduplication côté fournisseur.
 */
export interface EmailInput {
  readonly recipientEmail: string;
  readonly templateKey: string;
  readonly providerIdempotencyKey: string;
  readonly variables: Readonly<Record<string, string | number>>;
}

/**
 * Résultat d'un envoi d'email transactionnel via le port provider-neutral.
 * Type fermé : aucun raw Error, cause fournisseur, PII ou secret ne traverse.
 * Le Core normalise TOUTE exception en UNCERTAIN (fail-closed).
 * ADR-013 §13.4, G5H-C2B.
 */
export type EmailSendResult =
  | { readonly kind: 'SENT'; readonly providerMessageId: string }
  | { readonly kind: 'DETERMINISTIC_REFUSAL'; readonly failureCode: EmailDeterministicFailureCode }
  | { readonly kind: 'TRANSIENT_NOT_SENT'; readonly failureCode: EmailTransientFailureCode }
  | { readonly kind: 'UNCERTAIN'; readonly failureCode: EmailUncertainFailureCode };

/**
 * Refus terminal déterministe : l'email n'a PAS été envoyé.
 * Retry automatique interdit.
 */
export type EmailDeterministicFailureCode =
  | 'INVALID_RECIPIENT'
  | 'TEMPLATE_NOT_SUPPORTED'
  | 'PROVIDER_REFUSED_DETERMINISTIC'
  | 'IDEMPOTENT_PAYLOAD_CONFLICT';

/**
 * Refus temporaire mais certainement non envoyé : l'appel a échoué avant
 * toute acceptation possible par le fournisseur. Retry automatique autorisé
 * dans la fenêtre < 24 h.
 */
export type EmailTransientFailureCode = 'CONCURRENT_IDEMPOTENT_REQUESTS' | 'PROVIDER_RATE_LIMITED';

/**
 * Résultat incertain après début d'appel : l'email a PU être envoyé.
 * Retry automatique idempotent autorisé dans la fenêtre < 23 h si
 * attempts < MAX_ATTEMPTS. Sinon transition vers REQUIRES_MANUAL_REVIEW.
 */
export type EmailUncertainFailureCode =
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_NETWORK_ERROR'
  | 'PROVIDER_5XX'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'UNKNOWN_FAILURE_AFTER_CALL_START';
