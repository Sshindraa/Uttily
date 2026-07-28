import { eq } from 'drizzle-orm';
import type { DbExecutor } from '@uttily/database';
import { categories } from '@uttily/database';
import type { CategoryRecord, CreateCategoryInput, UpdateCategoryInput } from './types';
import { isValidSlug } from '../identity/slug';
import { AuthorizationError } from '../identity/permissions';

/**
 * Compte la profondeur d'une catégorie en remontant la chaîne parent_id.
 * Racine = profondeur 1. Retourne 0 si parentId est null.
 * Détecte les cycles (auto-référence ou ancêtre devenu descendant).
 */
async function computeDepth(db: DbExecutor, parentId: string | null): Promise<number> {
  if (!parentId) return 0;
  let depth = 0;
  let current: string | null = parentId;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current)) {
      throw new Error(`Cycle détecté dans la hiérarchie des catégories (id: ${current}).`);
    }
    visited.add(current);
    depth += 1;
    const [row] = await db
      .select({ parentId: categories.parentId })
      .from(categories)
      .where(eq(categories.id, current))
      .limit(1);
    if (!row) throw new AuthorizationError(`Catégorie parente introuvable: ${current}.`);
    current = row.parentId;
    if (depth > 100) throw new Error('Profondeur de catégorie excessive : cycle probable.');
  }
  return depth;
}

export async function createCategory(
  db: DbExecutor,
  input: CreateCategoryInput,
): Promise<CategoryRecord> {
  const slug = input.slug.trim().toLowerCase();
  if (!isValidSlug(slug)) throw new Error('Slug de catégorie invalide.');
  const name = input.name.trim();
  if (name.length < 2) throw new Error('Le nom doit faire au moins 2 caractères.');

  if (input.parentId) {
    const [parent] = await db
      .select()
      .from(categories)
      .where(eq(categories.id, input.parentId))
      .limit(1);
    if (!parent) throw new AuthorizationError(`Catégorie parente introuvable: ${input.parentId}.`);
    if (!parent.isActive) throw new Error('La catégorie parente est inactive.');
    const depth = await computeDepth(db, input.parentId);
    if (depth + 1 > 3) throw new Error('Profondeur de catégorie maximale (3) dépassée.');
  }

  const [row] = await db
    .insert(categories)
    .values({
      parentId: input.parentId ?? null,
      slug,
      name,
      description: input.description ?? null,
      isActive: true,
    })
    .returning();
  if (!row) throw new Error('Échec de création de la catégorie.');
  return mapCategory(row);
}

export async function listCategories(db: DbExecutor): Promise<CategoryRecord[]> {
  const rows = await db.select().from(categories);
  return rows.map(mapCategory);
}

export async function listActiveCategories(db: DbExecutor): Promise<CategoryRecord[]> {
  const rows = await db.select().from(categories).where(eq(categories.isActive, true));
  return rows.map(mapCategory);
}

export async function getCategory(db: DbExecutor, id: string): Promise<CategoryRecord | null> {
  const [row] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
  return row ? mapCategory(row) : null;
}

export async function updateCategory(
  db: DbExecutor,
  id: string,
  input: UpdateCategoryInput,
): Promise<CategoryRecord> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 2) throw new Error('Le nom doit faire au moins 2 caractères.');
    patch.name = name;
  }
  if (input.description !== undefined) patch.description = input.description;

  const [row] = await db.update(categories).set(patch).where(eq(categories.id, id)).returning();
  if (!row) throw new AuthorizationError('Catégorie introuvable.');
  return mapCategory(row);
}

/**
 * Désactive une catégorie (is_active → false).
 * Refusée par PostgreSQL (trigger) si des produits PUBLISHED l'utilisent.
 */
export async function deactivateCategory(db: DbExecutor, id: string): Promise<CategoryRecord> {
  const [row] = await db
    .update(categories)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(categories.id, id))
    .returning();
  if (!row) throw new AuthorizationError('Catégorie introuvable.');
  return mapCategory(row);
}

/**
 * Réactive une catégorie (is_active → true).
 * Vérifie que le parent (si présent) est actif ; le trigger PostgreSQL
 * rejette également la réactivation si le parent est inactif.
 */
export async function restoreCategory(db: DbExecutor, id: string): Promise<CategoryRecord> {
  // Vérification préalable côté domaine pour un message clair.
  const [existing] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
  if (!existing) throw new AuthorizationError('Catégorie introuvable.');
  if (existing.parentId) {
    const [parent] = await db
      .select({ isActive: categories.isActive })
      .from(categories)
      .where(eq(categories.id, existing.parentId))
      .limit(1);
    if (!parent) throw new Error('Catégorie parente introuvable.');
    if (!parent.isActive) {
      throw new Error(
        "Réactivation refusée : la catégorie parente est inactive. Réactivez le parent d'abord.",
      );
    }
  }

  const [row] = await db
    .update(categories)
    .set({ isActive: true, updatedAt: new Date() })
    .where(eq(categories.id, id))
    .returning();
  if (!row) throw new AuthorizationError('Catégorie introuvable.');
  return mapCategory(row);
}

function mapCategory(row: typeof categories.$inferSelect): CategoryRecord {
  return {
    id: row.id,
    parentId: row.parentId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
  };
}
