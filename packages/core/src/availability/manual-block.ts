import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { inventoryBlocks, inventoryItems, locations, lockOrganization } from '@uttily/database';
import { isActionErrorCode, type ActionErrorCode } from '@uttily/contracts';
import { LocalToUtcError, localDateTimeStringToUtc } from '../pricing-plans/local-to-utc';
import { CatalogError } from '../catalog/errors';
import { AuthorizationError } from '../identity/permissions';
import { completeKey, failKey, lockKey, reserveKey } from '../idempotency';
import type { IdempotencyRecordRow } from '../idempotency';
import { releaseBlock } from './blocks';
import type { InventoryBlockRecord } from './types';

export const CREATE_MANUAL_BLOCK_OPERATION = 'CREATE_MANUAL_BLOCK';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const LOCAL_DATETIME_MINUTE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const LOCAL_DATETIME_SECOND_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

export interface CreateManualBlockInput {
  organizationId: string;
  inventoryItemId: string;
  locationId: string;
  /** Date/heure locale de l'établissement, sans offset. */
  startAt: string;
  /** Date/heure locale de l'établissement, sans offset. */
  endAt: string;
  idempotencyKey: string;
  actorUserId?: string | null;
}

export interface CreateManualBlockResult {
  kind: 'APPLIED';
  blockId: string;
  organizationId: string;
  inventoryItemId: string;
  timeZone: string;
  blockedStartAt: string;
  blockedEndAt: string;
}

interface NormalizedCreateManualBlockInput extends Omit<
  CreateManualBlockInput,
  'startAt' | 'endAt' | 'idempotencyKey'
> {
  startAt: string;
  endAt: string;
  idempotencyKey: string;
}

interface PostgresError {
  code?: string;
  constraint_name?: string;
  constraint?: string;
}

type PersistedManualBlockFailure = {
  code: ActionErrorCode;
  message: string;
};

/**
 * Normalise la précision de l'input HTML datetime-local sans accepter d'offset.
 * Le serveur reste l'autorité de la conversion dans le fuseau de l'établissement.
 */
export function normalizeManualBlockLocalDateTime(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CatalogError('VALIDATION', 'Une date et une heure sont requises.', {
      [field]: 'Une date et une heure sont requises.',
    });
  }

  const normalized = value.trim();
  if (LOCAL_DATETIME_MINUTE_REGEX.test(normalized)) return `${normalized}:00`;
  if (LOCAL_DATETIME_SECOND_REGEX.test(normalized)) return normalized;

  const message = 'Format attendu : AAAA-MM-JJTHH:MM, sans fuseau ni décalage.';
  throw new CatalogError('VALIDATION', message, { [field]: message });
}

/** Convertit une période locale dans le fuseau fourni et vérifie son ordre. */
export function convertManualBlockLocalPeriod(
  startAt: string,
  endAt: string,
  timeZone: string,
): { startAt: Date; endAt: Date } {
  const normalizedStartAt = normalizeManualBlockLocalDateTime(startAt, 'startAt');
  const normalizedEndAt = normalizeManualBlockLocalDateTime(endAt, 'endAt');

  let convertedStartAt: Date;
  let convertedEndAt: Date;
  try {
    convertedStartAt = localDateTimeStringToUtc(normalizedStartAt, timeZone);
  } catch (error) {
    throw toLocalDateValidationError(error, 'startAt');
  }
  try {
    convertedEndAt = localDateTimeStringToUtc(normalizedEndAt, timeZone);
  } catch (error) {
    throw toLocalDateValidationError(error, 'endAt');
  }

  if (convertedEndAt <= convertedStartAt) {
    const message = 'La date de fin doit être après la date de début.';
    throw new CatalogError('VALIDATION', message, { endAt: message });
  }

  return { startAt: convertedStartAt, endAt: convertedEndAt };
}

/**
 * Rend un exemplaire indisponible ponctuellement.
 *
 * La clé d'idempotence couvre l'exemplaire, l'établissement et la période
 * locale. L'exemplaire et l'établissement sont verrouillés avant l'insert ;
 * la contrainte PostgreSQL `no_overlapping_blocks` reste l'autorité finale
 * contre les réservations, holds et maintenances concurrents.
 */
export async function createManualBlock(
  db: DatabaseClient,
  input: CreateManualBlockInput,
): Promise<CreateManualBlockResult> {
  const normalized = normalizeInput(input);
  const requestFingerprint = computeFingerprint(normalized);
  const reservation = await reserveKey(db, {
    organizationId: normalized.organizationId,
    operation: CREATE_MANUAL_BLOCK_OPERATION,
    key: normalized.idempotencyKey,
    requestFingerprint,
  });

  if (reservation.kind === 'REPLAY') return replayResult(reservation.record);
  if (reservation.kind === 'CONFLICT') {
    throw new CatalogError(
      'CONFLICT_IDEMPOTENCY',
      "La clé d'idempotence a déjà été utilisée avec une période ou un exemplaire différent.",
    );
  }

  try {
    return await db.transaction(async (tx) => {
      const lock = await lockKey(tx, reservation.record.id);
      if (lock.kind === 'REPLAY') return replayResult(lock.record);

      await lockOrganization(tx, normalized.organizationId);

      const [item] = await tx
        .select()
        .from(inventoryItems)
        .where(eq(inventoryItems.id, normalized.inventoryItemId))
        .for('update')
        .limit(1);
      if (!item || item.organizationId !== normalized.organizationId || item.deletedAt !== null) {
        throw new CatalogError('NOT_FOUND', 'Exemplaire introuvable dans cette organisation.');
      }
      if (item.status !== 'ACTIVE') {
        throw new CatalogError(
          'VALIDATION',
          "Seul un exemplaire actif peut faire l'objet d'un blocage manuel.",
        );
      }

      const [location] = await tx
        .select({
          id: locations.id,
          organizationId: locations.organizationId,
          timeZone: locations.timeZone,
        })
        .from(locations)
        .where(and(eq(locations.id, normalized.locationId), isNull(locations.deletedAt)))
        .limit(1);
      if (!location || location.organizationId !== normalized.organizationId) {
        throw new CatalogError('NOT_FOUND', 'Établissement introuvable dans cette organisation.');
      }
      if (item.currentLocationId !== location.id) {
        throw new CatalogError(
          'VALIDATION',
          "L'établissement sélectionné n'est pas l'établissement courant de l'exemplaire.",
        );
      }

      const period = convertManualBlockLocalPeriod(
        normalized.startAt,
        normalized.endAt,
        location.timeZone,
      );

      let row: typeof inventoryBlocks.$inferSelect | undefined;
      try {
        [row] = await tx
          .insert(inventoryBlocks)
          .values({
            organizationId: normalized.organizationId,
            inventoryItemId: normalized.inventoryItemId,
            type: 'MANUAL_BLOCK',
            status: 'ACTIVE',
            customerStartAt: period.startAt,
            customerEndAt: period.endAt,
            blockedStartAt: period.startAt,
            blockedEndAt: period.endAt,
            // Un blocage manuel n'expire jamais automatiquement.
            expiresAt: null,
            sourceId: null,
            createdBy: normalized.actorUserId ?? null,
          })
          .returning();
      } catch (error) {
        if (isExclusionViolation(error, 'no_overlapping_blocks')) {
          throw new CatalogError(
            'CONFLICT_BLOCK',
            'Cette période entre en conflit avec une réservation, un hold ou une maintenance.',
          );
        }
        throw error;
      }
      if (!row) throw new CatalogError('UNKNOWN', 'Échec de création du blocage manuel.');

      const result: CreateManualBlockResult = {
        kind: 'APPLIED',
        blockId: row.id,
        organizationId: normalized.organizationId,
        inventoryItemId: normalized.inventoryItemId,
        timeZone: location.timeZone,
        blockedStartAt: row.blockedStartAt.toISOString(),
        blockedEndAt: row.blockedEndAt.toISOString(),
      };

      await completeKey(tx, reservation.record.id, {
        resourceId: row.id,
        responseStatusCode: 200,
        responseBody: result,
      });
      return result;
    });
  } catch (error) {
    const failure = toPersistedFailure(error);
    await db
      .transaction(async (tx) => {
        await failKey(tx, reservation.record.id, {
          responseStatusCode: failure.code === 'UNKNOWN' ? 500 : 400,
          responseBody: failure,
        });
      })
      .catch(() => undefined);
    throw error;
  }
}

/** Libère uniquement un blocage manuel via la transition RELEASED existante. */
export async function releaseManualBlock(
  db: DatabaseClient,
  organizationId: string,
  blockId: string,
): Promise<InventoryBlockRecord> {
  return releaseBlock(db, organizationId, blockId, 'MANUAL_BLOCK');
}

function normalizeInput(input: CreateManualBlockInput): NormalizedCreateManualBlockInput {
  if (!UUID_REGEX.test(input.organizationId)) {
    throw new CatalogError('VALIDATION', 'organizationId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(input.inventoryItemId)) {
    throw new CatalogError('VALIDATION', 'inventoryItemId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(input.locationId)) {
    throw new CatalogError('VALIDATION', 'locationId doit être un UUID valide.');
  }
  const idempotencyKey =
    typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  if (idempotencyKey.length === 0) {
    throw new CatalogError('VALIDATION', "La clé d'idempotence est requise.", {
      idempotencyKey: "La clé d'idempotence est requise.",
    });
  }
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new CatalogError(
      'VALIDATION',
      `La clé ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.`,
      { idempotencyKey: `La clé ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.` },
    );
  }

  return {
    organizationId: input.organizationId,
    inventoryItemId: input.inventoryItemId,
    locationId: input.locationId,
    startAt: normalizeManualBlockLocalDateTime(input.startAt, 'startAt'),
    endAt: normalizeManualBlockLocalDateTime(input.endAt, 'endAt'),
    idempotencyKey,
    actorUserId: input.actorUserId ?? null,
  };
}

function computeFingerprint(input: NormalizedCreateManualBlockInput): string {
  const canonical = JSON.stringify({
    organization_id: input.organizationId,
    inventory_item_id: input.inventoryItemId,
    location_id: input.locationId,
    start_at: input.startAt,
    end_at: input.endAt,
    v: 'create-manual-block-v1',
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function toLocalDateValidationError(error: unknown, field: 'startAt' | 'endAt'): CatalogError {
  if (error instanceof LocalToUtcError) {
    const message =
      error.code === 'AMBIGUOUS_LOCAL_TIME'
        ? "Cette heure est ambiguë dans le fuseau de l'établissement. Choisissez une autre heure."
        : "Cette date/heure n'est pas valide dans le fuseau de l'établissement.";
    return new CatalogError('VALIDATION', message, { [field]: message });
  }
  throw error;
}

function isExclusionViolation(err: unknown, constraintName: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const pgError = err as PostgresError;
  return (
    pgError.code === '23P01' &&
    (pgError.constraint_name === constraintName || pgError.constraint === constraintName)
  );
}

function toPersistedFailure(error: unknown): PersistedManualBlockFailure {
  if (error instanceof CatalogError) return { code: error.code, message: error.message };
  if (error instanceof AuthorizationError) return { code: 'NOT_FOUND', message: error.message };
  return { code: 'UNKNOWN', message: 'Le blocage manuel n’a pas pu être créé.' };
}

function replayResult(record: IdempotencyRecordRow): CreateManualBlockResult {
  if (record.status === 'FAILED') {
    const body = record.responseBody;
    if (
      typeof body === 'object' &&
      body !== null &&
      'code' in body &&
      isActionErrorCode(body.code) &&
      'message' in body &&
      typeof body.message === 'string'
    ) {
      throw new CatalogError(body.code, body.message);
    }
    throw new CatalogError('UNKNOWN', 'Réponse idempotente de blocage manuel invalide.');
  }

  if (record.status !== 'COMPLETED' || record.responseStatusCode !== 200 || !record.resourceId) {
    throw new CatalogError('UNKNOWN', 'Réponse idempotente de blocage manuel invalide.');
  }
  const body = record.responseBody;
  if (!isManualBlockResult(body) || body.blockId !== record.resourceId) {
    throw new CatalogError('UNKNOWN', 'Réponse idempotente de blocage manuel invalide.');
  }
  return body;
}

function isManualBlockResult(value: unknown): value is CreateManualBlockResult {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    raw.kind === 'APPLIED' &&
    typeof raw.blockId === 'string' &&
    UUID_REGEX.test(raw.blockId) &&
    typeof raw.organizationId === 'string' &&
    UUID_REGEX.test(raw.organizationId) &&
    typeof raw.inventoryItemId === 'string' &&
    UUID_REGEX.test(raw.inventoryItemId) &&
    typeof raw.timeZone === 'string' &&
    typeof raw.blockedStartAt === 'string' &&
    typeof raw.blockedEndAt === 'string'
  );
}
