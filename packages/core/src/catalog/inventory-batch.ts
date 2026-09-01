import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  categories,
  inventoryItems,
  lockOrganization,
  locations,
  productVariants,
  products,
} from '@uttily/database';
import {
  isActionErrorCode,
  MAX_BULK_INVENTORY_ITEMS,
  type ActionErrorCode,
} from '@uttily/contracts';
import { AuthorizationError } from '../identity/permissions';
import { completeKey, failKey, lockKey, reserveKey } from '../idempotency';
import type { IdempotencyRecordRow } from '../idempotency';
import { isCommerciallyActiveEquipmentFamily } from './equipment-taxonomy';
import { CatalogError, isUniqueViolation } from './errors';

export const CREATE_INVENTORY_ITEMS_BATCH_OPERATION = 'CREATE_INVENTORY_ITEMS_BATCH';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_PREFIX_LENGTH = 32;

export interface CreateInventoryItemsBatchInput {
  organizationId: string;
  productVariantId: string;
  currentLocationId: string;
  count: number;
  /** Préfixe lisible conservé dans le SKU interne ; EQUIP par défaut. */
  prefix?: string;
  idempotencyKey: string;
}

export interface CreateInventoryItemsBatchResult {
  createdCount: number;
  inventoryItemIds: string[];
  internalSkus: string[];
}

type PersistedBatchFailure = {
  code: ActionErrorCode;
  message: string;
};

/**
 * Construit un SKU stable pour une position donnée d'une opération idempotente.
 * Le hash évite de persister la clé d'idempotence dans le SKU tout en garantissant
 * que deux positions d'un même lot restent distinctes.
 */
export function buildInventoryBatchSku(
  prefix: string | undefined,
  ordinal: number,
  idempotencyKey: string,
): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new CatalogError('VALIDATION', 'La position de l’exemplaire doit être positive.');
  }
  if (!idempotencyKey.trim()) {
    throw new CatalogError('VALIDATION', "La clé d'idempotence est requise.");
  }

  const normalizedPrefix = normalizePrefix(prefix);
  const token = createHash('sha256')
    .update(`inventory-items-batch-v1:${idempotencyKey.trim()}`, 'utf8')
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();

  return `${normalizedPrefix}-${token}-${String(ordinal).padStart(3, '0')}`;
}

/**
 * Crée plusieurs exemplaires dans une seule transaction métier.
 *
 * La variante, son produit/catégorie, l'établissement et l'organisation sont
 * vérifiés dans la transaction avant l'INSERT multi-lignes. Les seules lignes
 * métier écrites sont les exemplaires ; les réservations, maintenances et
 * blocages existants ne sont jamais lus pour être modifiés ni réalloués.
 */
export async function createInventoryItemsBatch(
  db: DatabaseClient,
  input: CreateInventoryItemsBatchInput,
): Promise<CreateInventoryItemsBatchResult> {
  const normalized = validateInput(input);
  const fingerprint = computeBatchFingerprint(normalized);
  const reservation = await reserveKey(db, {
    organizationId: normalized.organizationId,
    operation: CREATE_INVENTORY_ITEMS_BATCH_OPERATION,
    key: normalized.idempotencyKey,
    requestFingerprint: fingerprint,
  });

  if (reservation.kind === 'REPLAY') {
    return replayBatchResult(reservation.record);
  }
  if (reservation.kind === 'CONFLICT') {
    throw new CatalogError(
      'CONFLICT_IDEMPOTENCY',
      "La clé d'idempotence a déjà été utilisée avec des paramètres différents.",
    );
  }

  try {
    return await db.transaction(async (tx) => {
      const lock = await lockKey(tx, reservation.record.id);
      if (lock.kind === 'REPLAY') {
        return replayBatchResult(lock.record);
      }

      // Sérialise les lots concurrents de la même organisation. L'index SQL
      // reste l'autorité finale pour les créations unitaires concurrentes.
      await lockOrganization(tx, normalized.organizationId);

      const [variant] = await tx
        .select({
          id: productVariants.id,
          productOrganizationId: products.organizationId,
          variantDeletedAt: productVariants.deletedAt,
          variantIsActive: productVariants.isActive,
          productDeletedAt: products.deletedAt,
          categorySlug: categories.slug,
          categoryIsActive: categories.isActive,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .innerJoin(categories, eq(categories.id, products.categoryId))
        .where(eq(productVariants.id, normalized.productVariantId))
        .for('update')
        .limit(1);

      if (
        !variant ||
        variant.productOrganizationId !== normalized.organizationId ||
        variant.variantDeletedAt !== null ||
        variant.productDeletedAt !== null
      ) {
        throw new AuthorizationError('Variante introuvable.');
      }

      const [location] = await tx
        .select({ organizationId: locations.organizationId, deletedAt: locations.deletedAt })
        .from(locations)
        .where(eq(locations.id, normalized.currentLocationId))
        .for('update')
        .limit(1);

      if (
        !location ||
        location.organizationId !== normalized.organizationId ||
        location.deletedAt !== null
      ) {
        throw new AuthorizationError('Établissement introuvable.');
      }

      if (!variant.variantIsActive) {
        throw new CatalogError('VALIDATION', 'La variante doit être active.');
      }
      if (!variant.categoryIsActive || !isCommerciallyActiveEquipmentFamily(variant.categorySlug)) {
        throw new CatalogError(
          'VALIDATION',
          'La création en série est réservée aux familles commerciales actives.',
        );
      }

      const internalSkus = Array.from({ length: normalized.count }, (_, index) =>
        buildInventoryBatchSku(normalized.prefix, index + 1, normalized.idempotencyKey),
      );

      const existing = await tx
        .select({ internalSku: inventoryItems.internalSku })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.organizationId, normalized.organizationId),
            inArray(inventoryItems.internalSku, internalSkus),
            isNull(inventoryItems.deletedAt),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        const message = 'Un SKU généré est déjà utilisé dans cette organisation.';
        throw new CatalogError('CONFLICT_SKU', message, { internalSku: message });
      }

      let inserted: Array<{ id: string; internalSku: string }>;
      try {
        inserted = await tx
          .insert(inventoryItems)
          .values(
            internalSkus.map((internalSku) => ({
              organizationId: normalized.organizationId,
              productVariantId: normalized.productVariantId,
              internalSku,
              condition: 'NEW' as const,
              status: 'ACTIVE' as const,
              currentLocationId: normalized.currentLocationId,
            })),
          )
          .returning({ id: inventoryItems.id, internalSku: inventoryItems.internalSku });
      } catch (error) {
        if (isUniqueViolation(error, 'inventory_items_organization_sku_active_unique')) {
          const message = 'Un SKU généré est déjà utilisé dans cette organisation.';
          throw new CatalogError('CONFLICT_SKU', message, { internalSku: message });
        }
        if (error instanceof Error && error.message.includes('la même organisation')) {
          throw new CatalogError(
            'VALIDATION',
            "L'établissement ou la variante n'appartient pas à la même organisation que l'exemplaire.",
          );
        }
        throw error;
      }

      if (inserted.length !== normalized.count) {
        throw new CatalogError('UNKNOWN', 'La création des exemplaires est incomplète.');
      }

      const result: CreateInventoryItemsBatchResult = {
        createdCount: inserted.length,
        inventoryItemIds: inserted.map((item) => item.id),
        internalSkus: inserted.map((item) => item.internalSku),
      };

      await completeKey(tx, reservation.record.id, {
        resourceId: result.inventoryItemIds[0]!,
        responseStatusCode: 201,
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

function validateInput(
  input: CreateInventoryItemsBatchInput,
): Required<CreateInventoryItemsBatchInput> {
  if (!UUID_REGEX.test(input.organizationId)) {
    throw new CatalogError('VALIDATION', 'organizationId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(input.productVariantId)) {
    throw new CatalogError('VALIDATION', 'productVariantId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(input.currentLocationId)) {
    throw new CatalogError('VALIDATION', 'currentLocationId doit être un UUID valide.');
  }
  if (
    !Number.isSafeInteger(input.count) ||
    input.count < 1 ||
    input.count > MAX_BULK_INVENTORY_ITEMS
  ) {
    throw new CatalogError(
      'VALIDATION',
      `Le nombre d’exemplaires doit être compris entre 1 et ${MAX_BULK_INVENTORY_ITEMS}.`,
    );
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim().length === 0) {
    throw new CatalogError('VALIDATION', "La clé d'idempotence est requise.", {
      idempotencyKey: "La clé d'idempotence est requise.",
    });
  }

  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new CatalogError(
      'VALIDATION',
      `La clé ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.`,
      { idempotencyKey: `La clé ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.` },
    );
  }

  const prefix = normalizePrefix(input.prefix);
  return {
    organizationId: input.organizationId,
    productVariantId: input.productVariantId,
    currentLocationId: input.currentLocationId,
    count: input.count,
    prefix,
    idempotencyKey,
  };
}

function normalizePrefix(value: string | undefined): string {
  const normalized = value?.trim().toUpperCase() || 'EQUIP';
  if (normalized.length > MAX_PREFIX_LENGTH) {
    throw new CatalogError(
      'VALIDATION',
      `Le préfixe SKU ne doit pas dépasser ${MAX_PREFIX_LENGTH} caractères.`,
      { prefix: `Le préfixe SKU ne doit pas dépasser ${MAX_PREFIX_LENGTH} caractères.` },
    );
  }
  return normalized;
}

function computeBatchFingerprint(input: Required<CreateInventoryItemsBatchInput>): string {
  const canonical = JSON.stringify({
    count: input.count,
    current_location_id: input.currentLocationId,
    organization_id: input.organizationId,
    prefix: input.prefix,
    product_variant_id: input.productVariantId,
    v: 'create-inventory-items-batch-v1',
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function toPersistedFailure(error: unknown): PersistedBatchFailure {
  if (error instanceof CatalogError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof AuthorizationError) {
    return { code: 'NOT_FOUND', message: error.message };
  }
  return { code: 'UNKNOWN', message: 'La création des exemplaires n’a pas pu être effectuée.' };
}

function replayBatchResult(record: IdempotencyRecordRow): CreateInventoryItemsBatchResult {
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
    throw new CatalogError('UNKNOWN', 'Réponse idempotente d’échec invalide.');
  }

  if (record.status !== 'COMPLETED' || record.responseStatusCode !== 201 || !record.resourceId) {
    throw new CatalogError('UNKNOWN', 'Réponse idempotente de création en série invalide.');
  }

  const body = record.responseBody;
  if (!isBatchResult(body) || body.inventoryItemIds[0] !== record.resourceId) {
    throw new CatalogError('UNKNOWN', 'Réponse idempotente de création en série invalide.');
  }
  return body;
}

function isBatchResult(value: unknown): value is CreateInventoryItemsBatchResult {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.createdCount !== 'number' ||
    !Number.isSafeInteger(raw.createdCount) ||
    raw.createdCount < 1
  ) {
    return false;
  }
  if (!Array.isArray(raw.inventoryItemIds) || !Array.isArray(raw.internalSkus)) return false;
  if (
    raw.inventoryItemIds.length !== raw.createdCount ||
    raw.internalSkus.length !== raw.createdCount
  ) {
    return false;
  }
  return (
    raw.inventoryItemIds.every((id) => typeof id === 'string') &&
    raw.internalSkus.every((sku) => typeof sku === 'string')
  );
}
