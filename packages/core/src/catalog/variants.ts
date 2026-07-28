import { and, eq, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { productVariants, products } from '@uttily/database';
import type { ProductVariantRecord, CreateVariantInput, UpdateVariantInput } from './types';
import { AuthorizationError } from '../identity/permissions';
import { CatalogError } from './errors';

/**
 * Vérifie qu'un produit appartient à l'organisation et n'est pas supprimé.
 * Lance AuthorizationError si non trouvé.
 */
async function requireProductInOrg(
  db: DatabaseClient,
  organizationId: string,
  productId: string,
): Promise<void> {
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        eq(products.id, productId),
        eq(products.organizationId, organizationId),
        isNull(products.deletedAt),
      ),
    )
    .limit(1);
  if (!product) throw new AuthorizationError('Produit introuvable dans cette organisation.');
}

/**
 * Vérifie qu'une variante appartient à un produit de l'organisation.
 * Retourne la variante ou null.
 */
async function findVariantInOrg(
  db: DatabaseClient,
  organizationId: string,
  variantId: string,
): Promise<ProductVariantRecord | null> {
  // Récupère la variante + le product_id, puis vérifie l'appartenance.
  const [variant] = await db
    .select()
    .from(productVariants)
    .where(and(eq(productVariants.id, variantId), isNull(productVariants.deletedAt)))
    .limit(1);
  if (!variant) return null;

  // Vérifie que le produit parent appartient à l'organisation.
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        eq(products.id, variant.productId),
        eq(products.organizationId, organizationId),
        isNull(products.deletedAt),
      ),
    )
    .limit(1);
  if (!product) return null;

  return mapVariant(variant);
}

/**
 * Crée une variante pour un produit.
 * Vérifie que le produit appartient à l'organisation avant création.
 */
export async function createVariant(
  db: DatabaseClient,
  input: CreateVariantInput,
): Promise<ProductVariantRecord> {
  const name = input.name.trim();
  if (name.length < 1) {
    const msg = 'Le nom de la variante est requis.';
    throw new CatalogError('VALIDATION', msg, { name: msg });
  }

  await requireProductInOrg(db, input.organizationId, input.productId);

  const [row] = await db
    .insert(productVariants)
    .values({
      productId: input.productId,
      name,
      skuSuffix: input.skuSuffix ?? null,
      attributes: input.attributes ?? {},
      isActive: true,
    })
    .returning();
  if (!row) throw new CatalogError('UNKNOWN', 'Échec de création de la variante.');
  return mapVariant(row);
}

/**
 * Liste les variantes d'un produit appartenant à l'organisation.
 */
export async function listVariants(
  db: DatabaseClient,
  organizationId: string,
  productId: string,
): Promise<ProductVariantRecord[]> {
  // Vérifie l'appartenance du produit à l'organisation.
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        eq(products.id, productId),
        eq(products.organizationId, organizationId),
        isNull(products.deletedAt),
      ),
    )
    .limit(1);
  if (!product) return [];

  const rows = await db
    .select()
    .from(productVariants)
    .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt)));
  return rows.map(mapVariant);
}

/**
 * Liste les variantes actives d'un produit appartenant à l'organisation.
 */
export async function listActiveVariants(
  db: DatabaseClient,
  organizationId: string,
  productId: string,
): Promise<ProductVariantRecord[]> {
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        eq(products.id, productId),
        eq(products.organizationId, organizationId),
        isNull(products.deletedAt),
      ),
    )
    .limit(1);
  if (!product) return [];

  const rows = await db
    .select()
    .from(productVariants)
    .where(
      and(
        eq(productVariants.productId, productId),
        eq(productVariants.isActive, true),
        isNull(productVariants.deletedAt),
      ),
    );
  return rows.map(mapVariant);
}

/**
 * Récupère une variante appartenant à l'organisation.
 */
export async function getVariant(
  db: DatabaseClient,
  organizationId: string,
  variantId: string,
): Promise<ProductVariantRecord | null> {
  return findVariantInOrg(db, organizationId, variantId);
}

/**
 * Met à jour une variante appartenant à l'organisation.
 * product_id est immuable (garanti par trigger PostgreSQL et par le domaine).
 */
export async function updateVariant(
  db: DatabaseClient,
  organizationId: string,
  variantId: string,
  input: UpdateVariantInput,
): Promise<ProductVariantRecord> {
  const existing = await findVariantInOrg(db, organizationId, variantId);
  if (!existing) throw new AuthorizationError('Variante introuvable dans cette organisation.');

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 1) {
      const msg = 'Le nom de la variante est requis.';
      throw new CatalogError('VALIDATION', msg, { name: msg });
    }
    patch.name = name;
  }
  if (input.skuSuffix !== undefined) patch.skuSuffix = input.skuSuffix;
  if (input.attributes !== undefined) patch.attributes = input.attributes;

  const [row] = await db
    .update(productVariants)
    .set(patch)
    .where(eq(productVariants.id, variantId))
    .returning();
  if (!row) throw new AuthorizationError('Variante introuvable.');
  return mapVariant(row);
}

/**
 * Désactive une variante appartenant à l'organisation.
 * Rejetée par PostgreSQL (trigger) si c'est la dernière variante active du produit.
 */
export async function deactivateVariant(
  db: DatabaseClient,
  organizationId: string,
  variantId: string,
): Promise<ProductVariantRecord> {
  const existing = await findVariantInOrg(db, organizationId, variantId);
  if (!existing) throw new AuthorizationError('Variante introuvable dans cette organisation.');

  try {
    const [row] = await db
      .update(productVariants)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(productVariants.id, variantId))
      .returning();
    if (!row) throw new AuthorizationError('Variante introuvable.');
    return mapVariant(row);
  } catch (err) {
    // Le trigger guard_last_active_variant lève une exception si c'est la dernière
    // variante active. On la mappe vers CatalogError('LAST_ACTIVE_VARIANT', ...).
    if (err instanceof Error && err.message.includes('dernière variante active')) {
      throw new CatalogError(
        'LAST_ACTIVE_VARIANT',
        'Impossible de désactiver ou supprimer la dernière variante active du produit.',
      );
    }
    throw err;
  }
}

/**
 * Suppression logique d'une variante appartenant à l'organisation.
 * Rejetée par PostgreSQL (trigger) si c'est la dernière variante active.
 */
export async function deleteVariant(
  db: DatabaseClient,
  organizationId: string,
  variantId: string,
): Promise<void> {
  const existing = await findVariantInOrg(db, organizationId, variantId);
  if (!existing) throw new AuthorizationError('Variante introuvable dans cette organisation.');

  try {
    await db
      .update(productVariants)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(productVariants.id, variantId));
  } catch (err) {
    // Le trigger guard_last_active_variant lève une exception si c'est la dernière
    // variante active. On la mappe vers CatalogError('LAST_ACTIVE_VARIANT', ...).
    if (err instanceof Error && err.message.includes('dernière variante active')) {
      throw new CatalogError(
        'LAST_ACTIVE_VARIANT',
        'Impossible de désactiver ou supprimer la dernière variante active du produit.',
      );
    }
    throw err;
  }
}

function mapVariant(row: typeof productVariants.$inferSelect): ProductVariantRecord {
  return {
    id: row.id,
    productId: row.productId,
    name: row.name,
    skuSuffix: row.skuSuffix,
    attributes: row.attributes as Record<string, unknown>,
    isActive: row.isActive,
  };
}
