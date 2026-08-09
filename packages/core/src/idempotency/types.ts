import type { IdempotencyRecord } from '@uttily/database';

/**
 * Payload canonique pour le calcul de l'empreinte (ADR-009 section 12).
 * Version v1. Les champs monétaires sont exclus (calculés server-side).
 * Les champs non sémantiques (User-Agent, IP, session) sont exclus.
 */
export interface IdempotentPayload {
  organizationId: string;
  locationId: string;
  customerUserId: string;
  customerStartAt: Date;
  customerEndAt: Date;
  lines: IdempotentPayloadLine[];
}

export interface IdempotentPayloadLine {
  variantId: string;
  quantity: number;
}

/**
 * Payload canonique pour le calcul de l'empreinte flexible (G7P-B2-B).
 * Version v2. Inclut `pricingMode`, `locale` et `intent` canonique.
 * Le marqueur de version `v: 'v2'` empêche toute collision avec les
 * empreintes legacy (v1).
 */
export interface FlexibleIdempotentPayload {
  organizationId: string;
  locationId: string;
  customerUserId: string;
  locale: string;
  intent: FlexibleIntentCanonical;
  lines: IdempotentPayloadLine[];
  pricingMode: 'FLEXIBLE';
}

/**
 * Forme canonique de l'intent pour l'empreinte flexible.
 * - TIME_RANGE : startAt/endAt en chaînes de date+heure locale ISO 8601 sans
 *   offset (ex : "2026-08-08T22:08:00"). L'empreinte est basée sur l'entrée
 *   locale du client, pas sur la conversion UTC.
 * - DAY_RANGE : startDate/endDateExclusive en YYYY-MM-DD.
 */
export type FlexibleIntentCanonical =
  | { kind: 'TIME_RANGE'; startAt: string; endAt: string }
  | { kind: 'DAY_RANGE'; startDate: string; endDateExclusive: string };

/**
 * Statut d'un enregistrement d'idempotence.
 */
export type IdempotencyStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

/**
 * Résultat de la réservation d'une clé d'idempotence (ADR-009 section 11b).
 * - ACQUIRED : la clé a été créée en PENDING (ou un PENDING expiré a été repris).
 *   Cette transaction exécute la création, puis appelle completeKey/failKey.
 * - PENDING : même empreinte, opération en cours — l'appelant doit poursuivre vers
 *   `lockKey` (qui attendra le verrou puis retournera la réponse persistée).
 * - REPLAY : un enregistrement terminal (COMPLETED ou FAILED) existe avec la même
 *   empreinte. L'appelant doit retourner la réponse persistée sans réexécuter.
 * - CONFLICT : la même clé existe avec une empreinte différente. HTTP 409.
 */
export type IdempotencyReservation =
  | { kind: 'ACQUIRED'; record: IdempotencyRecordRow }
  | { kind: 'PENDING'; record: IdempotencyRecordRow }
  | { kind: 'REPLAY'; record: IdempotencyRecordRow }
  | { kind: 'CONFLICT'; record: IdempotencyRecordRow };

/**
 * Résultat du verrouillage d'une clé d'idempotence (ADR-009 section 11b étape 2).
 * - LOCKED : la ligne est PENDING et verrouillée par cette transaction, qui exécute
 *   la création puis appelle completeKey/failKey.
 * - REPLAY : la ligne est terminée (COMPLETED ou FAILED) — retourner exactement la
 *   réponse persistée.
 */
export type LockKeyResult =
  | { kind: 'LOCKED'; record: IdempotencyRecordRow }
  | { kind: 'REPLAY'; record: IdempotencyRecordRow };

/**
 * Représentation d'une ligne idempotency_records (alignée sur le schéma).
 */
export interface IdempotencyRecordRow {
  id: string;
  organizationId: string;
  operation: string;
  key: string;
  requestFingerprint: string;
  status: IdempotencyStatus;
  resourceId: string | null;
  responseStatusCode: number | null;
  responseBody: unknown;
  createdAt: Date;
  completedAt: Date | null;
  pendingTimeoutAt: Date | null;
}

/**
 * Réponse persistée d'une opération idempotente terminée.
 */
export interface IdempotentResponse {
  statusCode: number;
  body: unknown;
  resourceId: string | null;
}

/**
 * Convertit une ligne Drizzle en IdempotencyRecordRow typé.
 */
export function toRow(r: IdempotencyRecord): IdempotencyRecordRow {
  return {
    id: r.id,
    organizationId: r.organizationId,
    operation: r.operation,
    key: r.key,
    requestFingerprint: r.requestFingerprint,
    status: r.status as IdempotencyStatus,
    resourceId: r.resourceId,
    responseStatusCode: r.responseStatusCode,
    responseBody: r.responseBody,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    pendingTimeoutAt: r.pendingTimeoutAt,
  };
}
