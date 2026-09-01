import { createHash } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { DatabaseClient, DbExecutor } from '@uttily/database';
import { categories, lockOrganization, productVariants, products } from '@uttily/database';
import { isActionErrorCode, type ActionErrorCode } from '@uttily/contracts';
import { AuthorizationError } from '../identity/permissions';
import { CatalogError } from './errors';
import { isCommerciallyActiveEquipmentFamily, resolveEquipmentFamily } from './equipment-taxonomy';
import type { ProductRecord } from './types';
import { isValidSlug } from '../identity/slug';
import { completeKey, failKey, lockKey, reserveKey } from '../idempotency';
import type { IdempotencyRecordRow } from '../idempotency';

export const DUPLICATE_PRODUCT_OPERATION = 'DUPLICATE_PRODUCT';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_GENERATED_SLUG_ATTEMPTS = 1000;

export interface DuplicateProductInput {
  organizationId: string;
  sourceProductId: string;
  idempotencyKey: string;
  /** Nom cible optionnel ; à défaut le nom source reçoit le suffixe « (copie) ». */
  name?: string;
  /** Slug cible optionnel ; à défaut un slug unique `<source>-copy[-n]` est généré. */
  slug?: string;
}

type PersistedDuplicateFailure = {
  code: ActionErrorCode;
  message: string;
};

/**
 * Construit un slug lisible et borné pour une copie de produit.
 * La numérotation est déterministe et la recherche d'occupation est faite
 * dans la transaction de duplication, sous verrou d'organisation.
 */
export function buildControlledDuplicateSlug(sourceSlug: string, copyNumber: number): string {
  if (!Number.isSafeInteger(copyNumber) || copyNumber < 1) {
    throw new CatalogError('VALIDATION', 'Le numéro de copie doit être positif.');
  }

  const suffix = copyNumber === 1 ? '-copy' : `-copy-${copyNumber}`;
  const prefixLength = Math.max(2, 60 - suffix.length);
  const prefix = sourceSlug.slice(0, prefixLength).replace(/-+$/g, '');
  return `${prefix}${suffix}`;
}

/**
 * Duplique le catalogue d'un produit dans la même organisation.
 *
 * Sont copiés : nom, description, catégorie et variantes descriptives.
 * Sont volontairement exclus : publication, photos, inventaire, tarifs,
 * réservations, maintenances et tout snapshot transactionnel.
 *
 * La clé d'idempotence est réservée avant la transaction métier, puis la
 * ressource créée est enregistrée dans la même transaction que les variantes.
 */
export async function duplicateProduct(
  db: DatabaseClient,
  input: DuplicateProductInput,
): Promise<ProductRecord> {
  validateInput(input);

  const idempotencyKey = input.idempotencyKey.trim();
  const requestedName = normalizeOptional(input.name);
  const requestedSlug = normalizeOptional(input.slug);

  if (requestedName !== undefined && requestedName.length < 2) {
    throw new CatalogError('VALIDATION', 'Le nom de la copie doit faire au moins 2 caractères.', {
      name: 'Le nom de la copie doit faire au moins 2 caractères.',
    });
  }
  if (requestedSlug !== undefined && !isValidSlug(requestedSlug)) {
    throw new CatalogError('VALIDATION', 'Slug de copie invalide.', {
      slug: 'Le slug doit contenir uniquement des minuscules, chiffres et tirets.',
    });
  }

  const fingerprint = computeDuplicateFingerprint({
    organizationId: input.organizationId,
    sourceProductId: input.sourceProductId,
    name: requestedName ?? null,
    slug: requestedSlug ?? null,
  });

  const reservation = await reserveKey(db, {
    organizationId: input.organizationId,
    operation: DUPLICATE_PRODUCT_OPERATION,
    key: idempotencyKey,
    requestFingerprint: fingerprint,
  });

  if (reservation.kind === 'REPLAY') {
    return replayDuplicateRecord(reservation.record);
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
        return replayDuplicateRecord(lock.record);
      }

      // Sérialise l'allocation des slugs de copie pour cette organisation.
      await lockOrganization(tx, input.organizationId);

      const [source] = await tx
        .select()
        .from(products)
        .where(
          and(
            eq(products.id, input.sourceProductId),
            eq(products.organizationId, input.organizationId),
            isNull(products.deletedAt),
          ),
        )
        .for('update')
        .limit(1);
      if (!source) {
        throw new AuthorizationError('Produit source introuvable dans cette organisation.');
      }

      const [category] = await tx
        .select({ slug: categories.slug, isActive: categories.isActive })
        .from(categories)
        .where(eq(categories.id, source.categoryId))
        .for('update')
        .limit(1);
      if (
        !category ||
        !category.isActive ||
        resolveEquipmentFamily(category.slug).kind !== 'SUPPORTED' ||
        !isCommerciallyActiveEquipmentFamily(category.slug)
      ) {
        throw new CatalogError(
          'VALIDATION',
          'La duplication est réservée aux familles commerciales actives.',
        );
      }

      const sourceVariants = await tx
        .select()
        .from(productVariants)
        .where(and(eq(productVariants.productId, source.id), isNull(productVariants.deletedAt)))
        .orderBy(asc(productVariants.createdAt), asc(productVariants.id));

      const targetName = requestedName ?? `${source.name} (copie)`;
      const target = await insertDuplicateProduct(
        tx,
        input.organizationId,
        source,
        targetName,
        requestedSlug,
      );

      if (sourceVariants.length > 0) {
        await tx.insert(productVariants).values(
          sourceVariants.map((variant) => ({
            productId: target.id,
            name: variant.name,
            skuSuffix: variant.skuSuffix,
            attributes: variant.attributes,
            isActive: variant.isActive,
            // Les champs de prix de compatibilité restent vierges : aucun
            // tarif ou snapshot actif ne doit être dupliqué.
          })),
        );
      }

      const result = mapProduct(target);
      await completeKey(tx, reservation.record.id, {
        resourceId: result.id,
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

function validateInput(input: DuplicateProductInput): void {
  if (!UUID_REGEX.test(input.organizationId)) {
    throw new CatalogError('VALIDATION', 'organizationId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(input.sourceProductId)) {
    throw new CatalogError('VALIDATION', 'sourceProductId doit être un UUID valide.');
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim().length === 0) {
    throw new CatalogError('VALIDATION', "La clé d'idempotence est requise.", {
      idempotencyKey: "La clé d'idempotence est requise.",
    });
  }
  if (input.idempotencyKey.trim().length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new CatalogError(
      'VALIDATION',
      `La clé ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.`,
      {
        idempotencyKey: `La clé ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.`,
      },
    );
  }
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function computeDuplicateFingerprint(input: {
  organizationId: string;
  sourceProductId: string;
  name: string | null;
  slug: string | null;
}): string {
  const canonical = JSON.stringify({
    name: input.name,
    organization_id: input.organizationId,
    source_product_id: input.sourceProductId,
    slug: input.slug,
    v: 'duplicate-product-v1',
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

async function insertDuplicateProduct(
  tx: DbExecutor,
  organizationId: string,
  source: typeof products.$inferSelect,
  targetName: string,
  requestedSlug: string | undefined,
): Promise<typeof products.$inferSelect> {
  for (let copyNumber = 1; copyNumber <= MAX_GENERATED_SLUG_ATTEMPTS; copyNumber += 1) {
    const candidateSlug = requestedSlug ?? buildControlledDuplicateSlug(source.slug, copyNumber);
    const [existing] = await tx
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.organizationId, organizationId),
          eq(products.slug, candidateSlug),
          isNull(products.deletedAt),
        ),
      )
      .limit(1);

    if (existing) {
      if (requestedSlug !== undefined) {
        throw new CatalogError(
          'CONFLICT_SLUG',
          'Ce slug est déjà utilisé pour cette organisation.',
          {
            slug: 'Ce slug est déjà utilisé pour cette organisation.',
          },
        );
      }
      continue;
    }

    // Le verrou d'organisation couvre les duplications concurrentes ;
    // ON CONFLICT protège aussi contre un createProduct concurrent hors de ce flux.
    const [inserted] = await tx
      .insert(products)
      .values({
        organizationId,
        categoryId: source.categoryId,
        name: targetName,
        slug: candidateSlug,
        description: source.description,
        publicationStatus: 'DRAFT',
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;

    if (requestedSlug !== undefined) {
      throw new CatalogError('CONFLICT_SLUG', 'Ce slug est déjà utilisé pour cette organisation.', {
        slug: 'Ce slug est déjà utilisé pour cette organisation.',
      });
    }
  }

  throw new CatalogError('CONFLICT_SLUG', 'Impossible de générer un slug unique pour la copie.');
}

function mapProduct(row: typeof products.$inferSelect): ProductRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    categoryId: row.categoryId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    publicationStatus: row.publicationStatus as ProductRecord['publicationStatus'],
  };
}

function toPersistedFailure(error: unknown): PersistedDuplicateFailure {
  if (error instanceof CatalogError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof AuthorizationError) {
    return { code: 'NOT_FOUND', message: error.message };
  }
  return { code: 'UNKNOWN', message: 'La duplication n’a pas pu être effectuée.' };
}

function replayDuplicateRecord(record: IdempotencyRecordRow): ProductRecord {
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
    throw new CatalogError('UNKNOWN', 'Réponse idempotente de duplication invalide.');
  }
  const body = record.responseBody;
  if (!isProductRecord(body) || body.id !== record.resourceId) {
    throw new CatalogError('UNKNOWN', 'Réponse idempotente de duplication invalide.');
  }
  return body;
}

function isProductRecord(value: unknown): value is ProductRecord {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.id === 'string' &&
    typeof raw.organizationId === 'string' &&
    typeof raw.categoryId === 'string' &&
    typeof raw.name === 'string' &&
    typeof raw.slug === 'string' &&
    typeof raw.description === 'string' &&
    (raw.publicationStatus === 'DRAFT' ||
      raw.publicationStatus === 'PUBLISHED' ||
      raw.publicationStatus === 'ARCHIVED')
  );
}
