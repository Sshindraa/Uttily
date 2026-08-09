import { and, eq } from 'drizzle-orm';
import type { DatabaseClient, DatabaseTransaction } from '@uttily/database';
import { organizationMemberships } from '@uttily/database';
import { failKey } from '../idempotency/idempotency';
import type { IdempotencyRecordRow } from '../idempotency/types';
import { FulfillmentError, isFulfillmentErrorCode } from './fulfillment-errors';
import type { FulfillmentErrorCode } from './fulfillment-errors';
import { FULFILLMENT_OPERATORS } from './operators';
import { BOOKING_STATUSES } from './types';
import type { BookingStatus } from './types';

/**
 * @uttily/core — Helpers internes partagés par les use cases fulfillment (G3A/G3B).
 *
 * Factorise uniquement les helpers dont le comportement doit être strictement
 * identique entre les transitions terrain et les rapports d'état/dommages.
 * Pas d'abstraction générique complexe. Types stricts, aucun any.
 */

/**
 * Type guard : vérifie qu'une valeur est un BookingStatus valide.
 */
export function isBookingStatus(value: unknown): value is BookingStatus {
  return typeof value === 'string' && (BOOKING_STATUSES as readonly string[]).includes(value);
}

/**
 * Vérifie que l'actor a une membership ACTIVE avec un rôle autorisé.
 * @throws FulfillmentError('FORBIDDEN') si la membership est absente, non active ou rôle non autorisé.
 */
export async function verifyFulfillmentMembership(
  tx: DatabaseTransaction,
  organizationId: string,
  actorUserId: string,
): Promise<void> {
  const membership = await tx
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, actorUserId),
      ),
    )
    .limit(1);

  if (membership.length === 0) {
    throw new FulfillmentError(
      'FORBIDDEN',
      `L'utilisateur ${actorUserId} n'est pas membre de l'organisation ${organizationId}.`,
    );
  }

  const m = membership[0]!;
  if (m.status !== 'ACTIVE') {
    throw new FulfillmentError(
      'FORBIDDEN',
      `L'appartenance de l'utilisateur ${actorUserId} n'est pas active (statut: ${m.status}).`,
    );
  }

  if (!FULFILLMENT_OPERATORS.includes(m.role)) {
    throw new FulfillmentError(
      'FORBIDDEN',
      `Le rôle ${m.role} n'est pas autorisé à exécuter les opérations terrain de fulfillment.`,
    );
  }
}

/**
 * Mappe un code d'erreur fulfillment vers un code de statut HTTP.
 */
export function fulfillmentErrorStatusCode(code: FulfillmentErrorCode): number {
  switch (code) {
    case 'VALIDATION':
      return 422;
    case 'BOOKING_NOT_FOUND':
    case 'BOOKING_ITEM_NOT_FOUND':
      return 404;
    case 'ORGANIZATION_MISMATCH':
    case 'FORBIDDEN':
      return 403;
    case 'INVALID_TRANSITION':
    case 'TERMINAL_STATE':
    case 'IDEMPOTENCY_CONFLICT':
    case 'CONCURRENT_MODIFICATION':
    case 'BOOKING_ITEM_MISMATCH':
    case 'REPORT_PHASE_NOT_ALLOWED':
    case 'DAMAGE_REPORT_NOT_ALLOWED':
    case 'INVALID_CONDITION':
      return 409;
    case 'IDEMPOTENCY_REPLAY_INVALID':
      return 500;
    default:
      return 500;
  }
}

/**
 * Marque la clé idempotente comme FAILED dans une transaction séparée.
 * Ne lève jamais : si failKey échoue, l'erreur est avalée (la clé expirera).
 */
export async function persistFulfillmentFailureSafely(
  db: DatabaseClient,
  recordId: string,
  err: FulfillmentError,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await failKey(tx, recordId, {
        responseStatusCode: fulfillmentErrorStatusCode(err.code),
        responseBody: {
          code: err.code,
          message: err.message,
          fromStatus: err.fromStatus,
          toStatus: err.toStatus,
        },
      });
    });
  } catch {
    // La clé PENDING expirera naturellement ; ne pas masquer l'erreur métier originale.
  }
}

/**
 * Reconstruit une FulfillmentError depuis le responseBody FAILED persisté.
 * Valide fromStatus/toStatus contre BOOKING_STATUSES pour éviter tout cast non vérifié.
 * @returns FulfillmentError avec le code, message et fromStatus/toStatus originaux,
 *          ou FulfillmentError('IDEMPOTENCY_REPLAY_INVALID') si le responseBody est malformé.
 */
export function decodePersistedFulfillmentError(record: IdempotencyRecordRow): FulfillmentError {
  const body = record.responseBody;
  if (body === null || typeof body !== 'object' || !('code' in body)) {
    return new FulfillmentError('IDEMPOTENCY_REPLAY_INVALID', 'Réponse FAILED malformée.');
  }
  const errBody = body as {
    code: unknown;
    message: unknown;
    fromStatus?: unknown;
    toStatus?: unknown;
  };
  if (typeof errBody.code !== 'string' || !isFulfillmentErrorCode(errBody.code)) {
    return new FulfillmentError('IDEMPOTENCY_REPLAY_INVALID', "Code d'erreur FAILED invalide.");
  }
  if (typeof errBody.message !== 'string') {
    return new FulfillmentError('IDEMPOTENCY_REPLAY_INVALID', 'Message FAILED invalide.');
  }
  const opts: { fromStatus?: BookingStatus; toStatus?: BookingStatus } = {};
  if (errBody.fromStatus !== undefined) {
    if (!isBookingStatus(errBody.fromStatus)) {
      return new FulfillmentError('IDEMPOTENCY_REPLAY_INVALID', 'fromStatus FAILED invalide.');
    }
    opts.fromStatus = errBody.fromStatus;
  }
  if (errBody.toStatus !== undefined) {
    if (!isBookingStatus(errBody.toStatus)) {
      return new FulfillmentError('IDEMPOTENCY_REPLAY_INVALID', 'toStatus FAILED invalide.');
    }
    opts.toStatus = errBody.toStatus;
  }
  return new FulfillmentError(errBody.code, errBody.message, opts);
}
