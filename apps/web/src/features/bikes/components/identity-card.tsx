import type { UnifiedBike } from '@uttily/core';
import { IdentityDrawer } from './identity-drawer';
import { getCategoryDisplayLabel } from '@/features/equipment/category-presentation';
import styles from './components.module.css';

interface IdentityCardProps {
  organizationId: string;
  product: UnifiedBike['product'];
  variant: UnifiedBike['variant'];
  categories: Array<{ id: string; name: string }>;
  isPublicationReady: boolean;
}

export function BikeIdentityCard({
  organizationId,
  product,
  variant,
  categories,
  isPublicationReady,
}: IdentityCardProps): React.ReactElement {
  return (
    <section className={styles.card} aria-labelledby="identity-title">
      <div className={styles.cardHeader}>
        <h2 id="identity-title" className={styles.cardTitle}>
          <span>🧰</span> Identité commerciale & Modèle
        </h2>
        <IdentityDrawer
          organizationId={organizationId}
          productId={product.id}
          productName={product.name}
          description={product.description ?? ''}
          categoryId={product.categoryId}
          categories={categories}
          publicationStatus={product.publicationStatus}
          isPublicationReady={isPublicationReady}
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '16px',
        }}
      >
        <div>
          <span
            style={{
              fontSize: '0.8rem',
              fontWeight: 'var(--ut-weight-bold)',
              color: 'var(--ut-color-ink-muted)',
              textTransform: 'uppercase',
            }}
          >
            Nom commercial
          </span>
          <div
            style={{
              fontSize: '1.05rem',
              fontWeight: 'var(--ut-weight-bold)',
              color: 'var(--ut-color-ink-strong)',
              marginTop: '2px',
            }}
          >
            {product.name}
          </div>
        </div>

        <div>
          <span
            style={{
              fontSize: '0.8rem',
              fontWeight: 'var(--ut-weight-bold)',
              color: 'var(--ut-color-ink-muted)',
              textTransform: 'uppercase',
            }}
          >
            Catégorie
          </span>
          <div
            style={{
              fontSize: '1rem',
              fontWeight: 'var(--ut-weight-bold)',
              color: 'var(--ut-color-ink-strong)',
              marginTop: '2px',
            }}
          >
            🏷️ {getCategoryDisplayLabel(product.categorySlug, product.categoryName)}
          </div>
        </div>

        <div>
          <span
            style={{
              fontSize: '0.8rem',
              fontWeight: 'var(--ut-weight-bold)',
              color: 'var(--ut-color-ink-muted)',
              textTransform: 'uppercase',
            }}
          >
            Version
          </span>
          <div
            style={{
              fontSize: '1rem',
              fontWeight: 'var(--ut-weight-bold)',
              color: 'var(--ut-color-ink-strong)',
              marginTop: '2px',
            }}
          >
            📐 {variant.name}
          </div>
        </div>
      </div>

      <div style={{ borderTop: '1px solid var(--ut-color-surface-soft)', paddingTop: '14px' }}>
        <span
          style={{
            fontSize: '0.8rem',
            fontWeight: 'var(--ut-weight-bold)',
            color: 'var(--ut-color-ink-muted)',
            textTransform: 'uppercase',
          }}
        >
          Description pour les locataires
        </span>
        <p
          style={{
            margin: '4px 0 0 0',
            fontSize: '0.92rem',
            color: 'var(--ut-color-ink)',
            lineHeight: 1.5,
          }}
        >
          {product.description || (
            <em style={{ color: 'var(--ut-color-ink-subtle)' }}>Aucune description renseignée.</em>
          )}
        </p>
      </div>
    </section>
  );
}
