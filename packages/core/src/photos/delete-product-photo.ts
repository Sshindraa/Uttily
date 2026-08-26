/**
 * @uttily/core — Module Photos (G7F-A2).
 *
 * Suppression (soft delete) d'une photo produit.
 *
 * `deleteProductPhoto` effectue un soft delete transactionnel :
 * - `SELECT ... FOR UPDATE` sur le produit parent (via la photo).
 * - Vérification multi-tenant (`organization_id`).
 * - Si le produit est `PUBLISHED` et le compte de photos valides après
 *   suppression serait < 3 → `PhotoError('PHOTO_DELETION_WOULD_BREAK_PUBLICATION')`.
 * - Soft delete : `file_state` → `DELETED`, `deleted_at` → `now()`.
 * - Aucun outbox event (reporté à G7F-B).
 * - Idempotence : si la photo est déjà `DELETED`, retour sans erreur.
 *
 * Le trigger PostgreSQL `guard_product_photo_deletion` assure une
 * defense-in-depth au niveau base de données.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { productPhotos, products } from '@uttily/database';
import { PhotoError } from './errors';
import type { ProductPhotoStorage } from './storage';

/**
 * Supprime (soft delete) une photo produit.
 *
 * @param db Client de base de données.
 * @param organizationId Identifiant de l'organisation (multi-tenant).
 * @param photoId Identifiant de la photo à supprimer.
 * @throws {PhotoError} `PHOTO_NOT_FOUND` si la photo n'existe pas ou
 *   n'appartient pas à l'organisation.
 * @throws {PhotoError} `PHOTO_DELETION_WOULD_BREAK_PUBLICATION` si la
 *   suppression ferait passer un produit `PUBLISHED` sous le seuil de 3 photos.
 */
export async function deleteProductPhoto(
  db: DatabaseClient,
  organizationId: string,
  photoId: string,
  storage?: ProductPhotoStorage,
): Promise<void> {
  let storageKey: string | null = null;
  await db.transaction(async (tx) => {
    // 1. Charge la photo et vérifie l'appartenance multi-tenant.
    const [photo] = await tx
      .select()
      .from(productPhotos)
      .where(eq(productPhotos.id, photoId))
      .limit(1);

    if (!photo) {
      throw new PhotoError('PHOTO_NOT_FOUND', 'Photo introuvable.');
    }

    // Vérification multi-tenant.
    if (photo.organizationId !== organizationId) {
      throw new PhotoError('PHOTO_NOT_FOUND', 'Photo introuvable.');
    }

    // Idempotence : si déjà DELETED, retour sans erreur (replay sûr).
    if (photo.fileState === 'DELETED') {
      storageKey = photo.storageKey;
      return;
    }

    storageKey = photo.storageKey;

    // 2. SELECT FOR UPDATE sur le produit parent.
    // Ordre de verrouillage : products avant product_photos (anti-deadlock).
    const [product] = await tx
      .select()
      .from(products)
      .where(
        and(
          eq(products.id, photo.productId),
          eq(products.organizationId, organizationId),
          isNull(products.deletedAt),
        ),
      )
      .for('update')
      .limit(1);

    if (!product) {
      throw new PhotoError('PHOTO_NOT_FOUND', 'Photo introuvable.');
    }

    // 3. Si le produit est PUBLISHED, vérifier le compte après suppression.
    if (product.publicationStatus === 'PUBLISHED') {
      // Compte les photos valides actuelles.
      const [countRow] = await tx
        .select({ value: sql<number>`count(*)::integer` })
        .from(productPhotos)
        .where(
          and(
            eq(productPhotos.productId, photo.productId),
            eq(productPhotos.organizationId, organizationId),
            eq(productPhotos.fileState, 'AVAILABLE'),
            isNull(productPhotos.deletedAt),
          ),
        );

      const currentValidCount = Number(countRow?.value ?? 0);

      // Si la photo à supprimer est valide, le compte après = current - 1.
      const isPhotoValid = photo.fileState === 'AVAILABLE' && photo.deletedAt === null;
      const countAfter = isPhotoValid ? currentValidCount - 1 : currentValidCount;

      if (countAfter < 3) {
        throw new PhotoError(
          'PHOTO_DELETION_WOULD_BREAK_PUBLICATION',
          'La suppression de cette photo ferait passer le produit publié sous le seuil de 3 photos valides.',
        );
      }
    }

    // 4. Soft delete : file_state → DELETED, deleted_at → now().
    // Aucun outbox event (reporté à G7F-B).
    await tx
      .update(productPhotos)
      .set({
        fileState: 'DELETED',
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(productPhotos.id, photoId));
  });

  // La suppression physique est effectuée après le commit DB. Si le
  // fournisseur échoue, un rejeu retrouve DELETED et retente l'opération.
  if (storage && storageKey) await storage.deleteIfPresent(storageKey);
}
