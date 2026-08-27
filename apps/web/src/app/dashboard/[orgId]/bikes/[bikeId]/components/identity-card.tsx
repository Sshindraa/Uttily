import type { UnifiedBike } from '@uttily/core';
import { IdentityDrawer } from './identity-drawer';
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
          <span>🚲</span> Identité commerciale & Modèle
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
              fontWeight: 700,
              color: '#64748b',
              textTransform: 'uppercase',
            }}
          >
            Nom commercial
          </span>
          <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#0f172a', marginTop: '2px' }}>
            {product.name}
          </div>
        </div>

        <div>
          <span
            style={{
              fontSize: '0.8rem',
              fontWeight: 700,
              color: '#64748b',
              textTransform: 'uppercase',
            }}
          >
            Catégorie
          </span>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: '#0f172a', marginTop: '2px' }}>
            🏷️ {product.categoryName}
          </div>
        </div>

        <div>
          <span
            style={{
              fontSize: '0.8rem',
              fontWeight: 700,
              color: '#64748b',
              textTransform: 'uppercase',
            }}
          >
            Variante / Taille
          </span>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: '#0f172a', marginTop: '2px' }}>
            📐 {variant.name} {variant.skuSuffix ? `(${variant.skuSuffix})` : ''}
          </div>
        </div>
      </div>

      <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: '14px' }}>
        <span
          style={{
            fontSize: '0.8rem',
            fontWeight: 700,
            color: '#64748b',
            textTransform: 'uppercase',
          }}
        >
          Description pour les locataires
        </span>
        <p style={{ margin: '4px 0 0 0', fontSize: '0.92rem', color: '#334155', lineHeight: 1.5 }}>
          {product.description || (
            <em style={{ color: '#94a3b8' }}>Aucune description renseignée.</em>
          )}
        </p>
      </div>
    </section>
  );
}
