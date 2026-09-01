'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { uploadProductPhotoAction } from '@/app/actions/product-photos';

interface NeutralPhotoUploaderProps {
  organizationId: string;
  productId: string;
  photos: ReadonlyArray<{ id: string; publicId: string }>;
  count: number;
  minRequired: number;
  isComplete: boolean;
}

/**
 * Upload neutre pour les catégories sans module photo validé.
 * Le stockage, les permissions et la règle de publication restent dans Core.
 */
export function NeutralPhotoUploader({
  organizationId,
  productId,
  photos,
  count,
  minRequired,
  isComplete,
}: NeutralPhotoUploaderProps): React.ReactElement {
  const router = useRouter();
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setError(null);
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.set('productId', productId);
      formData.set('photoId', crypto.randomUUID());
      formData.set('file', file);

      const result = await uploadProductPhotoAction(
        organizationId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );
      if (!result.ok) {
        setError(result.message || 'Erreur lors de l’envoi de la photo.');
        return;
      }

      router.refresh();
    } catch {
      setError('Une erreur inattendue est survenue lors de l’enregistrement.');
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <section
      aria-labelledby="neutral-photos-title"
      style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        <h2 id="neutral-photos-title" style={{ margin: 0, fontSize: '1.1rem' }}>
          📸 Photos de l’équipement
        </h2>
        <strong
          style={{ color: isComplete ? 'var(--ut-color-success)' : 'var(--ut-color-warning)' }}
        >
          {count}/{minRequired} photos valides
        </strong>
      </div>

      <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--ut-color-ink-muted)' }}>
        Trois photos valides sont nécessaires avant la mise en ligne de l’équipement.
      </p>

      {error && (
        <div role="alert" style={{ color: 'var(--ut-color-danger)', fontSize: '0.88rem' }}>
          {error}
        </div>
      )}

      {photos.length > 0 ? (
        <div
          aria-label="Galerie des photos de l’équipement"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
            gap: '12px',
          }}
        >
          {photos.map((photo, index) => (
            <img
              key={photo.id}
              src={`/api/public/product-photos/${photo.publicId}`}
              alt={`Photo de l’équipement ${index + 1}`}
              style={{
                width: '100%',
                aspectRatio: '4 / 3',
                objectFit: 'cover',
                borderRadius: '10px',
              }}
            />
          ))}
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--ut-color-ink-muted)' }}>
          Aucune photo disponible.
        </p>
      )}

      <label
        htmlFor={`neutral-photo-upload-${productId}`}
        style={{
          alignSelf: 'flex-start',
          display: 'inline-flex',
          alignItems: 'center',
          minHeight: '44px',
          padding: '10px 14px',
          borderRadius: '10px',
          background: 'var(--ut-color-primary)',
          color: 'white',
          fontWeight: 'var(--ut-weight-bold)',
          cursor: isUploading ? 'wait' : 'pointer',
          opacity: isUploading ? 0.7 : 1,
        }}
      >
        {isUploading ? 'Envoi…' : 'Ajouter une photo'}
        <input
          id={`neutral-photo-upload-${productId}`}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleFileChange}
          disabled={isUploading}
          style={{
            position: 'absolute',
            width: '1px',
            height: '1px',
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
          }}
        />
      </label>
    </section>
  );
}
