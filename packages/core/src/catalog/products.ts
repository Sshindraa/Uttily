import { and, eq, inArray, isNull, count, sql } from 'drizzle-orm';
import type { DatabaseClient, DbExecutor } from '@uttily/database';
import { categories, products, productVariants, productPhotos } from '@uttily/database';
import { REQUIRED_BIKE_PHOTO_SLOTS } from '@uttily/contracts';
import type {
  ProductRecord,
  CreateProductInput,
  UpdateProductInput,
  PublicationStatus,
} from './types';
import { isValidSlug, slugify } from '../identity/slug';
import { AuthorizationError } from '../identity/permissions';
import { CatalogError, isUniqueViolation } from './errors';
import { missingRequiredBikePhotoSlots } from '../photos/photo-publication-rules';
import { isHistoricalPaddleCategorySlug } from './equipment-taxonomy';

/**
 * Crée un produit et sa variante "Standard" atomiquement.
 * Le produit est créé en DRAFT ; la publication est une opération distincte.
 */
export async function createProduct(
  db: DatabaseClient,
  input: CreateProductInput,
): Promise<ProductRecord> {
  const name = input.name.trim();
  if (name.length < 2) {
    const msg = 'Le nom du produit doit faire au moins 2 caractères.';
    throw new CatalogError('VALIDATION', msg, { name: msg });
  }
  const slug = input.slug ? input.slug : slugify(name);
  if (!isValidSlug(slug)) {
    const msg = 'Slug invalide.';
    throw new CatalogError('VALIDATION', msg, { slug: msg });
  }
  const description = input.description ?? '';

  // Vérifie que la catégorie existe et est active.
  const [cat] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.id, input.categoryId), eq(categories.isActive, true)))
    .limit(1);
  if (!cat) {
    const msg = 'Catégorie inexistante ou désactivée.';
    throw new CatalogError('VALIDATION', msg, { categoryId: msg });
  }
  if (isHistoricalPaddleCategorySlug(cat.slug)) {
    const msg = 'La catégorie historique paddle n’est pas une famille commerciale active.';
    throw new CatalogError('VALIDATION', msg, { categoryId: msg });
  }

  return await db.transaction(async (tx) => {
    // Vérifie l'unicité du slug dans l'organisation.
    const existing = await tx
      .select()
      .from(products)
      .where(
        and(
          eq(products.organizationId, input.organizationId),
          eq(products.slug, slug),
          isNull(products.deletedAt),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      const msg = 'Ce slug est déjà utilisé pour cette organisation.';
      throw new CatalogError('CONFLICT_SLUG', msg, { slug: msg });
    }

    let product: typeof products.$inferSelect | undefined;
    try {
      [product] = await tx
        .insert(products)
        .values({
          organizationId: input.organizationId,
          categoryId: input.categoryId,
          name,
          slug,
          description,
          publicationStatus: 'DRAFT',
        })
        .returning();
    } catch (err) {
      // Concurrence : une insertion concurrente peut faire échouer l'index unique.
      if (isUniqueViolation(err, 'products_organization_slug_active_unique')) {
        const msg = 'Ce slug est déjà utilisé pour cette organisation.';
        throw new CatalogError('CONFLICT_SLUG', msg, { slug: msg });
      }
      throw err;
    }
    if (!product) throw new CatalogError('UNKNOWN', 'Échec de création du produit.');

    // Crée la variante "Standard" atomiquement.
    await tx.insert(productVariants).values({
      productId: product.id,
      name: 'Standard',
      attributes: {},
      isActive: true,
    });

    return mapProduct(product);
  });
}

export async function listProducts(
  db: DatabaseClient,
  organizationId: string,
): Promise<ProductRecord[]> {
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.organizationId, organizationId), isNull(products.deletedAt)));
  return rows.map(mapProduct);
}

export async function getProduct(
  db: DatabaseClient,
  organizationId: string,
  productId: string,
): Promise<ProductRecord | null> {
  const [row] = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.organizationId, organizationId),
        eq(products.id, productId),
        isNull(products.deletedAt),
      ),
    )
    .limit(1);
  return row ? mapProduct(row) : null;
}

export async function updateProduct(
  db: DatabaseClient,
  organizationId: string,
  productId: string,
  input: UpdateProductInput,
): Promise<ProductRecord> {
  return await db.transaction(async (tx) => {
    // Verrouille le produit pour lire son état de publication de façon cohérente.
    const [product] = await tx
      .select()
      .from(products)
      .where(
        and(
          eq(products.organizationId, organizationId),
          eq(products.id, productId),
          isNull(products.deletedAt),
        ),
      )
      .for('update')
      .limit(1);
    if (!product) throw new AuthorizationError('Produit introuvable.');

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length < 2) {
        const msg = 'Le nom doit faire au moins 2 caractères.';
        throw new CatalogError('VALIDATION', msg, { name: msg });
      }
      patch.name = name;
    }
    if (input.description !== undefined) {
      // Refuse une description vide si le produit est PUBLISHED.
      if (product.publicationStatus === 'PUBLISHED' && input.description.trim().length === 0) {
        const msg = 'La description ne peut pas être vide sur un produit publié.';
        throw new CatalogError('VALIDATION', msg, { description: msg });
      }
      patch.description = input.description;
    }
    if (input.slug !== undefined) {
      const slug = input.slug.trim();
      if (!isValidSlug(slug)) {
        const msg = 'Slug invalide.';
        throw new CatalogError('VALIDATION', msg, { slug: msg });
      }
      // Vérifie l'unicité du slug dans l'organisation (exclut le produit courant).
      const existing = await tx
        .select()
        .from(products)
        .where(
          and(
            eq(products.organizationId, organizationId),
            eq(products.slug, slug),
            isNull(products.deletedAt),
          ),
        )
        .limit(1);
      if (existing.length > 0 && existing[0]!.id !== productId) {
        const msg = 'Ce slug est déjà utilisé pour cette organisation.';
        throw new CatalogError('CONFLICT_SLUG', msg, { slug: msg });
      }
      patch.slug = slug;
    }
    if (input.categoryId !== undefined) {
      // Verrouille la catégorie cible pour éviter une désactivation concurrente.
      const [cat] = await tx
        .select()
        .from(categories)
        .where(eq(categories.id, input.categoryId))
        .for('update')
        .limit(1);
      if (!cat) {
        const msg = 'Catégorie inexistante.';
        throw new CatalogError('VALIDATION', msg, { categoryId: msg });
      }
      if (!cat.isActive) {
        const msg = 'Catégorie désactivée.';
        throw new CatalogError('VALIDATION', msg, { categoryId: msg });
      }
      if (isHistoricalPaddleCategorySlug(cat.slug)) {
        const msg = 'La catégorie historique paddle n’est pas une famille commerciale active.';
        throw new CatalogError('VALIDATION', msg, { categoryId: msg });
      }
      patch.categoryId = input.categoryId;
    }

    const [row] = await tx
      .update(products)
      .set(patch)
      .where(eq(products.id, productId))
      .returning();
    if (!row) throw new CatalogError('UNKNOWN', 'Échec de la mise à jour.');
    return mapProduct(row);
  });
}

/**
 * Collecte les échecs de readiness pour la publication d'un produit.
 * Source unique de vérité partagée entre `publishProduct` (dans une transaction,
 * après verrouillage du produit) et `getProductPublicationReadiness` (lecture
 * ponctuelle hors transaction).
 *
 * ATTENTION : cette fonction ne re-verrouille PAS le produit ni la catégorie.
 * - Dans `publishProduct`, le verrou FOR UPDATE sur le produit est déjà posé
 *   avant l'appel ; la catégorie est verrouillée séparément par `publishProduct`.
 * - Hors transaction (read model), on fait une lecture cohérente ponctuelle
 *   (acceptable pour l'affichage).
 *
 * Règles vérifiées (ordre identique à l'implémentation historique) :
 * 1. nom ≥ 2 caractères
 * 2. description non vide
 * 3. catégorie active
 * 4. au moins une variante active
 * 5. au moins 3 photos valides (file_state = 'AVAILABLE', checksums distincts)
 * 6. pour la catégorie `bike`, les trois slots canoniques d'ADR-031
 *
 * @returns tableau de messages d'erreur (vide si le produit est prêt à publier).
 *          ["Produit introuvable."] si le produit n'existe pas.
 */
/**
 * Évalue les prérequis de publication pour un ensemble de produits en requêtes groupées sans N+1.
 * Source unique de vérité pour les invariants de publication d'Uttily :
 * - Nom ≥ 2 caractères
 * - Description non vide
 * - Catégorie active
 * - Au moins 1 variante active
 * - Au moins 3 photos valides (checksums distincts)
 * - Pour un vélo, `HERO_PROFILE`, `THREE_QUARTER_FRONT` et `SECONDARY_VIEW`
 */
export async function collectPublicationFailuresBatch(
  tx: DbExecutor,
  productIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (productIds.length === 0) return result;

  for (const id of productIds) {
    result.set(id, []);
  }

  // 1. Lit les produits et leur catégorie
  const productRows = await tx
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
      categoryId: products.categoryId,
      categoryIsActive: categories.isActive,
      categorySlug: categories.slug,
    })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(and(inArray(products.id, productIds), isNull(products.deletedAt)));

  const foundIds = new Set<string>();
  const categorySlugByProduct = new Map<string, string | null>();

  for (const row of productRows) {
    foundIds.add(row.id);
    categorySlugByProduct.set(row.id, row.categorySlug);
    const failures: string[] = [];
    if (row.name.trim().length < 2) failures.push('Le nom doit faire au moins 2 caractères.');
    if (row.description.trim().length === 0) failures.push('La description est requise.');
    if (!row.categoryIsActive) failures.push('La catégorie est inexistante ou désactivée.');
    if (isHistoricalPaddleCategorySlug(row.categorySlug)) {
      failures.push('La catégorie historique paddle n’est pas une famille commerciale active.');
    }
    result.set(row.id, failures);
  }

  for (const id of productIds) {
    if (!foundIds.has(id)) {
      result.set(id, ['Produit introuvable.']);
    }
  }

  // 2. Compte les variantes actives groupées par productId
  const variantCounts = await tx
    .select({
      productId: productVariants.productId,
      value: count(),
    })
    .from(productVariants)
    .where(
      and(
        inArray(productVariants.productId, productIds),
        eq(productVariants.isActive, true),
        isNull(productVariants.deletedAt),
      ),
    )
    .groupBy(productVariants.productId);

  const activeVariantsByProduct = new Map<string, number>(
    variantCounts.map((r) => [r.productId, Number(r.value)]),
  );

  for (const id of productIds) {
    if (foundIds.has(id)) {
      const vCount = activeVariantsByProduct.get(id) ?? 0;
      if (vCount === 0) {
        result.get(id)?.push('Au moins une variante active est requise.');
      }
    }
  }

  // 3. Compte les photos valides distinctes groupées par productId
  const photoCounts = await tx
    .select({
      productId: productPhotos.productId,
      value: sql<number>`count(distinct ${productPhotos.checksumSha256})::integer`,
    })
    .from(productPhotos)
    .where(
      and(
        inArray(productPhotos.productId, productIds),
        eq(productPhotos.fileState, 'AVAILABLE'),
        isNull(productPhotos.deletedAt),
        sql`${productPhotos.checksumSha256} IS NOT NULL`,
      ),
    )
    .groupBy(productPhotos.productId);

  const distinctPhotosByProduct = new Map<string, number>(
    photoCounts.map((r) => [r.productId, Number(r.value)]),
  );

  // Les vélos ont trois slots canoniques obligatoires (ADR-031). Les autres
  // catégories restent soumises au minimum générique de trois checksums.
  const requiredBikeSlotRows = await tx
    .select({
      productId: productPhotos.productId,
      slotType: productPhotos.slotType,
    })
    .from(productPhotos)
    .where(
      and(
        inArray(productPhotos.productId, productIds),
        eq(productPhotos.fileState, 'AVAILABLE'),
        isNull(productPhotos.deletedAt),
        sql`${productPhotos.checksumSha256} IS NOT NULL`,
        inArray(productPhotos.slotType, [...REQUIRED_BIKE_PHOTO_SLOTS]),
      ),
    )
    .groupBy(productPhotos.productId, productPhotos.slotType);

  const bikeSlotsByProduct = new Map<string, Set<string | null>>();
  for (const row of requiredBikeSlotRows) {
    const slots = bikeSlotsByProduct.get(row.productId) ?? new Set<string | null>();
    slots.add(row.slotType);
    bikeSlotsByProduct.set(row.productId, slots);
  }

  for (const id of productIds) {
    if (foundIds.has(id)) {
      const pCount = distinctPhotosByProduct.get(id) ?? 0;
      if (pCount < 3) {
        result.get(id)?.push('Au moins 3 photos valides sont requises pour la publication.');
      }

      const missingBikeSlots = missingRequiredBikePhotoSlots(
        categorySlugByProduct.get(id),
        bikeSlotsByProduct.get(id) ?? new Set<string | null>(),
      );
      if (missingBikeSlots.length > 0) {
        result.get(id)?.push(`Slots photo vélo manquants : ${missingBikeSlots.join(', ')}.`);
      }
    }
  }

  return result;
}

/**
 * Collecte les raisons bloquant la publication d'un produit.
 * Délègue directement à collectPublicationFailuresBatch.
 */
export async function collectPublicationFailures(
  tx: DbExecutor,
  productId: string,
): Promise<string[]> {
  const batch = await collectPublicationFailuresBatch(tx, [productId]);
  return batch.get(productId) ?? ['Produit introuvable.'];
}

/**
 * Publie un produit : DRAFT ou ARCHIVED → PUBLISHED.
 * Invariants de complétude (délégués à `collectPublicationFailures`) :
 * - nom ≥ 2 caractères
 * - description non vide
 * - catégorie active (verrouillée pendant la transaction)
 * - au moins une variante active
 * - au moins 3 photos valides (file_state = 'AVAILABLE', checksums distincts)
 * - pour un vélo, une photo disponible dans chacun des trois slots canoniques
 * Pas d'exemplaire requis : un produit publié sans stock est un état légitime.
 */
export async function publishProduct(
  db: DatabaseClient,
  organizationId: string,
  productId: string,
): Promise<ProductRecord> {
  return await db.transaction(async (tx) => {
    // Verrouille le produit.
    const [product] = await tx
      .select()
      .from(products)
      .where(
        and(
          eq(products.organizationId, organizationId),
          eq(products.id, productId),
          isNull(products.deletedAt),
        ),
      )
      .for('update')
      .limit(1);
    if (!product) throw new AuthorizationError('Produit introuvable.');

    // Verrouille la catégorie pour empêcher une désactivation concurrente
    // entre la vérification et la transition PUBLISHED.
    // La catégorie est verrouillée FOR UPDATE ci-dessus ; le verrou est maintenu
    // par la transaction pendant l'exécution de collectPublicationFailures.
    await tx
      .select()
      .from(categories)
      .where(eq(categories.id, product.categoryId))
      .for('update')
      .limit(1);

    // Vérifie la readiness via le helper partagé.
    const failures = await collectPublicationFailures(tx, product.id);
    if (failures.length > 0) {
      throw new CatalogError(
        'PUBLISH_INCOMPLETE',
        `Publication impossible:\n- ${failures.join('\n- ')}`,
      );
    }

    const [row] = await tx
      .update(products)
      .set({ publicationStatus: 'PUBLISHED', updatedAt: new Date() })
      .where(eq(products.id, productId))
      .returning();
    if (!row) throw new CatalogError('UNKNOWN', 'Échec de la publication.');
    return mapProduct(row);
  });
}

/**
 * Archive un produit : PUBLISHED → ARCHIVED. Réversible via restoreArchivedProduct.
 */
export async function archiveProduct(
  db: DatabaseClient,
  organizationId: string,
  productId: string,
): Promise<ProductRecord> {
  const [row] = await db
    .update(products)
    .set({ publicationStatus: 'ARCHIVED', updatedAt: new Date() })
    .where(and(eq(products.id, productId), eq(products.organizationId, organizationId)))
    .returning();
  if (!row) throw new AuthorizationError('Produit introuvable.');
  return mapProduct(row);
}

/**
 * Restaure un produit archivé : ARCHIVED → PUBLISHED.
 * Réexécute toutes les règles de publication (comme publishProduct).
 */
export async function restoreArchivedProduct(
  db: DatabaseClient,
  organizationId: string,
  productId: string,
): Promise<ProductRecord> {
  return publishProduct(db, organizationId, productId);
}

/**
 * Suppression logique (soft delete) : positionne deleted_at.
 * Distinct de l'archivage (état métier réversible).
 */
export async function deleteProduct(
  db: DatabaseClient,
  organizationId: string,
  productId: string,
): Promise<void> {
  await db
    .update(products)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(products.id, productId), eq(products.organizationId, organizationId)));
}

function mapProduct(row: typeof products.$inferSelect): ProductRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    categoryId: row.categoryId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    publicationStatus: row.publicationStatus as PublicationStatus,
  };
}
