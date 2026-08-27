import { and, desc, eq, isNull } from 'drizzle-orm';
import type { DatabaseClient, ProductPhotoRecord } from '@uttily/database';
import { productPhotos, products } from '@uttily/database';
import type { PhotoSlotType } from '@uttily/contracts';
import { PhotoError } from './errors';
import type { ProductPhotoStorage } from './storage';
import { validateProductPhoto } from './validate-product-photo';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface UploadProductPhotoInput {
  readonly organizationId: string;
  readonly productId: string;
  /** Identifiant fourni par le client pour rendre le rejeu idempotent. */
  readonly photoId: string;
  readonly slotType?: PhotoSlotType | null | undefined;
  readonly content: Uint8Array;
  readonly declaredContentType?: string | undefined;
}

/**
 * Valide, écrit et rend disponible une photo produit.
 *
 * La base passe par PENDING_UPLOAD avant l'appel fournisseur. L'écriture R2
 * est conditionnelle puis la transition vers AVAILABLE est atomique et
 * conditionnée à PENDING_UPLOAD. Un même photoId rejoué avec les mêmes
 * métadonnées est donc un succès sans overwrite.
 */
export async function uploadProductPhoto(
  db: DatabaseClient,
  storage: ProductPhotoStorage,
  input: UploadProductPhotoInput,
): Promise<ProductPhotoRecord> {
  if (
    !UUID_RE.test(input.organizationId) ||
    !UUID_RE.test(input.productId) ||
    !UUID_RE.test(input.photoId)
  ) {
    throw new PhotoError('PHOTO_VALIDATION_FAILED', 'Identifiant de photo invalide.');
  }

  const validated = validateProductPhoto(input.content, input.declaredContentType);
  const storageKey = `product-photos/${input.organizationId}/${input.productId}/${input.photoId}`;

  const pending = await db.transaction(async (tx) => {
    const [product] = await tx
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.id, input.productId),
          eq(products.organizationId, input.organizationId),
          isNull(products.deletedAt),
        ),
      )
      .for('update')
      .limit(1);
    if (!product) throw new PhotoError('PHOTO_NOT_FOUND', 'Produit introuvable.');

    const [existing] = await tx
      .select()
      .from(productPhotos)
      .where(eq(productPhotos.id, input.photoId))
      .limit(1);
    if (existing) {
      assertReplayable(existing, input, validated, storageKey);
      return { kind: 'EXISTING' as const, record: existing };
    }

    const [lastPhoto] = await tx
      .select({ sortOrder: productPhotos.sortOrder })
      .from(productPhotos)
      .where(
        and(
          eq(productPhotos.productId, input.productId),
          eq(productPhotos.organizationId, input.organizationId),
        ),
      )
      .orderBy(desc(productPhotos.sortOrder))
      .limit(1);

    const [inserted] = await tx
      .insert(productPhotos)
      .values({
        id: input.photoId,
        organizationId: input.organizationId,
        productId: input.productId,
        storageKey,
        slotType: input.slotType ?? null,
        contentType: validated.contentType,
        byteSize: validated.byteSize,
        widthPx: validated.widthPx,
        heightPx: validated.heightPx,
        checksumSha256: validated.checksumSha256,
        sortOrder: (lastPhoto?.sortOrder ?? -1) + 1,
        fileState: 'PENDING_UPLOAD',
      })
      .onConflictDoNothing({ target: productPhotos.id })
      .returning();

    if (inserted) return { kind: 'PENDING' as const, record: inserted };

    const [raced] = await tx
      .select()
      .from(productPhotos)
      .where(eq(productPhotos.id, input.photoId))
      .limit(1);
    if (!raced) throw new PhotoError('PHOTO_UPLOAD_FAILED', 'La photo n’a pas pu être préparée.');
    assertReplayable(raced, input, validated, storageKey);
    return { kind: 'EXISTING' as const, record: raced };
  });

  if (pending.kind === 'EXISTING' && pending.record.fileState === 'AVAILABLE') {
    return pending.record;
  }

  let objectCreated = false;
  try {
    const stored = await storage.putIfAbsent({
      key: storageKey,
      content: validated.content,
      contentType: validated.contentType,
      checksumSha256: validated.checksumSha256,
      sizeBytes: validated.byteSize,
    });
    objectCreated = stored.kind === 'CREATED';
    if (stored.kind === 'ALREADY_EXISTS' && !sameStorageMetadata(stored.metadata, validated)) {
      throw new PhotoError(
        'PHOTO_CONFLICT',
        'Un objet photo existant ne correspond pas au fichier envoyé.',
      );
    }

    const [available] = await db.transaction(async (tx) =>
      tx
        .update(productPhotos)
        .set({ fileState: 'AVAILABLE', updatedAt: new Date() })
        .where(
          and(
            eq(productPhotos.id, input.photoId),
            eq(productPhotos.organizationId, input.organizationId),
            eq(productPhotos.fileState, 'PENDING_UPLOAD'),
          ),
        )
        .returning(),
    );
    if (available) return available;

    const [replayed] = await db
      .select()
      .from(productPhotos)
      .where(eq(productPhotos.id, input.photoId))
      .limit(1);
    if (replayed?.fileState === 'AVAILABLE') return replayed;
    throw new PhotoError('PHOTO_UPLOAD_FAILED', 'La photo n’a pas pu être finalisée.');
  } catch (error) {
    if (error instanceof PhotoError && error.code === 'PHOTO_CONFLICT') {
      await db
        .update(productPhotos)
        .set({
          fileState: 'REJECTED',
          rejectionReason: 'Upload non finalisé.',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(productPhotos.id, input.photoId),
            eq(productPhotos.organizationId, input.organizationId),
            eq(productPhotos.fileState, 'PENDING_UPLOAD'),
          ),
        )
        .catch(() => undefined);
    }

    // Une clé est dédiée à un photoId : supprimer après échec ne peut pas
    // effacer l'objet d'une autre photo. Le rejeu repassera par putIfAbsent.
    if (objectCreated) await storage.deleteIfPresent(storageKey).catch(() => undefined);
    if (error instanceof PhotoError) throw error;
    throw new PhotoError(
      'PHOTO_UPLOAD_FAILED',
      'Le stockage de la photo est temporairement indisponible.',
      {
        cause: error,
      },
    );
  }
}

function assertReplayable(
  record: ProductPhotoRecord,
  input: UploadProductPhotoInput,
  validated: ReturnType<typeof validateProductPhoto>,
  storageKey: string,
): void {
  if (
    record.organizationId !== input.organizationId ||
    record.productId !== input.productId ||
    record.storageKey !== storageKey
  ) {
    throw new PhotoError('PHOTO_NOT_FOUND', 'Photo introuvable.');
  }
  if (
    record.contentType !== validated.contentType ||
    record.byteSize !== validated.byteSize ||
    record.widthPx !== validated.widthPx ||
    record.heightPx !== validated.heightPx ||
    record.checksumSha256 !== validated.checksumSha256
  ) {
    throw new PhotoError('PHOTO_CONFLICT', 'Ce rejeu idempotent contient un fichier différent.');
  }
  if (record.fileState === 'DELETED' || record.fileState === 'REJECTED') {
    throw new PhotoError('PHOTO_CONFLICT', 'Cette photo ne peut plus être réutilisée.');
  }
}

function sameStorageMetadata(
  actual: { contentType: string; sizeBytes: number; checksumSha256: string | null },
  expected: ReturnType<typeof validateProductPhoto>,
): boolean {
  return (
    actual.contentType === expected.contentType &&
    actual.sizeBytes === expected.byteSize &&
    actual.checksumSha256 === expected.checksumSha256
  );
}
