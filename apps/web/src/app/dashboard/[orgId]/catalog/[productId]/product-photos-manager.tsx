'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { deleteProductPhotoAction, uploadProductPhotoAction } from '@/app/actions/product-photos';
import type { ActionResult } from '@uttily/contracts';
import type { ProductPhotoSummary } from '@uttily/core';
import styles from './product-photos-manager.module.css';

import { BIKE_PHOTO_SLOTS, type PhotoSlotType } from '@uttily/contracts';
import { PhotoCoachModal, PhotoProgress } from '@/components/photo-coach';

type UploadState = ActionResult<ProductPhotoSummary> | { ok: true; data: null };
type DeleteState = ActionResult<null> | { ok: true; data: null };
const initialUploadState: UploadState = { ok: true, data: null };
const initialDeleteState: DeleteState = { ok: true, data: null };

export function ProductPhotosManager({
  orgId,
  productId,
  photos,
}: {
  orgId: string;
  productId: string;
  photos: ProductPhotoSummary[];
}): React.ReactElement {
  const router = useRouter();
  const [isCoachOpen, setIsCoachOpen] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<PhotoSlotType>('FULL_BIKE');
  const availablePhotos = photos.filter((photo) => photo.fileState === 'AVAILABLE');
  const availableCount = availablePhotos.length;

  const hasFullBike = availablePhotos.some((p) => p.slotType === 'FULL_BIKE');
  const hasDrivetrain = availablePhotos.some((p) => p.slotType === 'DRIVETRAIN');
  const hasBrakesTires = availablePhotos.some((p) => p.slotType === 'BRAKES_TIRES');

  const nextSuggestedSlot: PhotoSlotType = !hasFullBike
    ? 'FULL_BIKE'
    : !hasDrivetrain
      ? 'DRIVETRAIN'
      : !hasBrakesTires
        ? 'BRAKES_TIRES'
        : 'FULL_BIKE';

  const handleOpenCoach = (slot: PhotoSlotType = nextSuggestedSlot) => {
    setSelectedSlot(slot);
    setIsCoachOpen(true);
  };

  return (
    <section className={styles.section} aria-labelledby="product-photos-heading">
      <h2 id="product-photos-heading">Photos du produit</h2>
      <p>
        {availableCount} photo(s) valide(s). Trois photos distinctes sont nécessaires avant la
        publication. JPEG, PNG ou WebP, 10 Mo maximum, 200 à 8000 pixels.
      </p>

      <div className={styles.coachBar}>
        <PhotoProgress
          slots={{ hasFullBike, hasDrivetrain, hasBrakesTires }}
          totalRequiredSlots={3}
        />
        <div>
          <button
            type="button"
            className={styles.coachButton}
            onClick={() => handleOpenCoach(nextSuggestedSlot)}
          >
            📸 Ouvrir le Photo Coach Uttily ({BIKE_PHOTO_SLOTS[nextSuggestedSlot].title})
          </button>
        </div>
      </div>

      <PhotoCoachModal
        orgId={orgId}
        productId={productId}
        slotType={selectedSlot}
        isOpen={isCoachOpen}
        onClose={() => setIsCoachOpen(false)}
        onPhotoUploaded={() => {
          router.refresh();
        }}
      />

      <PhotoUploadForm orgId={orgId} productId={productId} />
      {photos.length === 0 ? (
        <p>Aucune photo ajoutée.</p>
      ) : (
        <ol className={styles.grid}>
          {photos.map((photo, index) => (
            <PhotoCard
              key={photo.id}
              orgId={orgId}
              productId={productId}
              photo={photo}
              position={index + 1}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function PhotoUploadForm({
  orgId,
  productId,
}: {
  orgId: string;
  productId: string;
}): React.ReactElement {
  const [photoId, setPhotoId] = useState(() => crypto.randomUUID());
  const [state, formAction] = useActionState<UploadState, FormData>(
    (previous, formData) =>
      uploadProductPhotoAction(orgId, previous as ActionResult<ProductPhotoSummary>, formData),
    initialUploadState,
  );
  const router = useRouter();

  useEffect(() => {
    if (state.ok && state.data) {
      setPhotoId(crypto.randomUUID());
      router.refresh();
    }
  }, [router, state]);

  return (
    <form action={formAction} className={styles.form} encType="multipart/form-data">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="photoId" value={photoId} />
      <label htmlFor="product-photo-file">Ajouter une photo</label>
      <input
        id="product-photo-file"
        name="file"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        required
        aria-describedby="product-photo-help product-photo-error"
      />
      <p id="product-photo-help" className={styles.help}>
        Le contenu réel est contrôlé côté serveur avant tout envoi au stockage.
      </p>
      {!state.ok && (
        <p id="product-photo-error" className={styles.error} role="alert" aria-live="polite">
          {state.message}
        </p>
      )}
      <SubmitButton label="Téléverser" />
    </form>
  );
}

function PhotoCard({
  orgId,
  productId,
  photo,
  position,
}: {
  orgId: string;
  productId: string;
  photo: ProductPhotoSummary;
  position: number;
}): React.ReactElement {
  const [replacementId, setReplacementId] = useState(() => crypto.randomUUID());
  const [uploadState, replaceAction] = useActionState<UploadState, FormData>(
    (previous, formData) =>
      uploadProductPhotoAction(orgId, previous as ActionResult<ProductPhotoSummary>, formData),
    initialUploadState,
  );
  const deleteSubmitted = useRef(false);
  const [deleteState, deleteAction] = useActionState<DeleteState, FormData>(
    (previous, formData) => {
      deleteSubmitted.current = true;
      return deleteProductPhotoAction(orgId, previous, formData);
    },
    initialDeleteState,
  );
  const router = useRouter();

  useEffect(() => {
    if (uploadState.ok && uploadState.data) {
      setReplacementId(crypto.randomUUID());
      router.refresh();
    }
  }, [router, uploadState]);
  useEffect(() => {
    if (deleteSubmitted.current && deleteState.ok && deleteState.data === null) {
      deleteSubmitted.current = false;
      router.refresh();
    }
  }, [deleteState, router]);

  return (
    <li className={styles.card}>
      {photo.fileState === 'AVAILABLE' ? (
        <img
          src={`/api/dashboard/${orgId}/catalog/${productId}/photos/${photo.id}`}
          alt={`Photo ${position} du produit`}
          className={styles.preview}
        />
      ) : (
        <div className={styles.placeholder} aria-label="Aperçu indisponible">
          {photo.fileState}
        </div>
      )}
      <p>
        <strong>Photo {position}</strong>
        {photo.slotType && BIKE_PHOTO_SLOTS[photo.slotType] ? (
          <span>
            {' '}
            — <em>{BIKE_PHOTO_SLOTS[photo.slotType].title}</em>
          </span>
        ) : null}{' '}
        — {photo.fileState}
        {photo.widthPx && photo.heightPx ? ` — ${photo.widthPx}×${photo.heightPx}px` : ''}
      </p>
      {photo.rejectionReason && <p className={styles.error}>{photo.rejectionReason}</p>}
      <form action={replaceAction} className={styles.form} encType="multipart/form-data">
        <input type="hidden" name="productId" value={productId} />
        <input type="hidden" name="photoId" value={replacementId} />
        <input type="hidden" name="replacePhotoId" value={photo.id} />
        <label htmlFor={`replace-photo-${photo.id}`}>Remplacer cette photo</label>
        <input
          id={`replace-photo-${photo.id}`}
          name="file"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          required
        />
        {!uploadState.ok && (
          <p className={styles.error} role="alert">
            {uploadState.message}
          </p>
        )}
        <SubmitButton label="Remplacer" />
      </form>
      <form action={deleteAction}>
        <input type="hidden" name="productId" value={productId} />
        <input type="hidden" name="photoId" value={photo.id} />
        {!deleteState.ok && (
          <p className={styles.error} role="alert">
            {deleteState.message}
          </p>
        )}
        <DeleteButton />
      </form>
    </li>
  );
}

function SubmitButton({ label }: { label: string }): React.ReactElement {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? '…' : label}
    </button>
  );
}

function DeleteButton(): React.ReactElement {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={styles.deleteButton}>
      {pending ? '…' : 'Supprimer'}
    </button>
  );
}
