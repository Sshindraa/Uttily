import type { UnifiedBike } from '@uttily/core';

interface NeutralPhotoManagerProps {
  photos: UnifiedBike['photos'];
}

/**
 * Neutral photo presentation for categories without a validated photo module.
 * Upload, storage and publication rules remain outside this component.
 */
export function NeutralPhotoManager({ photos }: NeutralPhotoManagerProps): React.ReactElement {
  return (
    <section
      aria-labelledby="equipment-photos-title"
      style={{
        background: 'var(--ut-color-surface)',
        border: 'var(--ut-border-thin)',
        borderRadius: 'var(--ut-radius-lg)',
        boxShadow: 'var(--ut-shadow-sm)',
        padding: 'var(--ut-space-6)',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <h2
          id="equipment-photos-title"
          style={{
            margin: 0,
            fontSize: '1.1rem',
            fontWeight: 'var(--ut-weight-bold)',
            color: 'var(--ut-color-ink-strong)',
          }}
        >
          <span aria-hidden="true">📸</span> Photos de l’équipement
        </h2>
        <strong
          style={{
            fontSize: '0.88rem',
            color: photos.isComplete ? 'var(--ut-color-success)' : 'var(--ut-color-warning)',
          }}
        >
          {photos.isComplete
            ? `✓ ${photos.count}/${photos.minRequired} photos valides`
            : `${photos.count}/${photos.minRequired} photos valides`}
        </strong>
      </div>

      <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--ut-color-ink-muted)' }}>
        Trois photos valides sont nécessaires avant la mise en ligne de l’équipement.
      </p>

      {photos.items.length > 0 ? (
        <div
          aria-label="Galerie des photos de l’équipement"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
            gap: '0.75rem',
          }}
        >
          {photos.items.map((photo, index) => (
            <img
              key={photo.id}
              src={`/api/public/product-photos/${photo.publicId}`}
              alt={`Photo de l’équipement ${index + 1}`}
              style={{
                width: '100%',
                aspectRatio: '4 / 3',
                objectFit: 'cover',
                borderRadius: 'var(--ut-radius-md)',
                background: 'var(--ut-color-surface-soft)',
              }}
            />
          ))}
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--ut-color-ink-muted)' }}>
          Aucune photo disponible.
        </p>
      )}
    </section>
  );
}
