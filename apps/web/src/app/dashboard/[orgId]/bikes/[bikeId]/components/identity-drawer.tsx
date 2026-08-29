'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  updateProductAction,
  publishProductAction,
  archiveProductAction,
  restoreArchivedProductAction,
} from '@/app/actions/products';
import styles from './components.module.css';

interface IdentityDrawerProps {
  organizationId: string;
  productId: string;
  productName: string;
  description: string;
  categoryId: string;
  categories: Array<{ id: string; name: string }>;
  publicationStatus: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  isPublicationReady: boolean;
}

export function IdentityDrawer({
  organizationId,
  productId,
  productName,
  description,
  categoryId,
  categories,
  publicationStatus,
  isPublicationReady,
}: IdentityDrawerProps): React.ReactElement {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState(productName);
  const [desc, setDesc] = useState(description);
  const [selectedCatId, setSelectedCatId] = useState(categoryId);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUpdate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const formData = new FormData();
      formData.set('productId', productId);
      formData.set('name', name);
      formData.set('description', desc);
      formData.set('categoryId', selectedCatId);

      const res = await updateProductAction(
        organizationId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );

      if (!res.ok) {
        throw new Error(res.message || 'Erreur lors de la mise à jour des informations.');
      }

      setIsOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue.');
    } finally {
      setIsLoading(false);
    }
  }

  async function handlePublish(): Promise<void> {
    setError(null);
    setIsLoading(true);
    try {
      const formData = new FormData();
      formData.set('productId', productId);
      const res = await publishProductAction(
        organizationId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );
      if (!res.ok) throw new Error(res.message || 'Erreur lors de la publication.');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue.');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleArchive(): Promise<void> {
    setError(null);
    setIsLoading(true);
    try {
      const formData = new FormData();
      formData.set('productId', productId);
      const res = await archiveProductAction(
        organizationId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );
      if (!res.ok) throw new Error(res.message || 'Erreur lors de l’archivage.');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue.');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRestore(): Promise<void> {
    setError(null);
    setIsLoading(true);
    try {
      const formData = new FormData();
      formData.set('productId', productId);
      const res = await restoreArchivedProductAction(
        organizationId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );
      if (!res.ok) throw new Error(res.message || 'Erreur lors de la restauration.');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue.');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => setIsOpen(true)} className={styles.actionBtn}>
          ✏️ Modifier les informations
        </button>

        {publicationStatus === 'DRAFT' && isPublicationReady && (
          <button
            type="button"
            onClick={handlePublish}
            disabled={isLoading}
            className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
          >
            🚀 {isLoading ? 'Publication…' : 'Mettre en ligne mon vélo'}
          </button>
        )}

        {publicationStatus === 'PUBLISHED' && (
          <button
            type="button"
            onClick={handleArchive}
            disabled={isLoading}
            className={styles.actionBtn}
            style={{ color: '#dc2626' }}
          >
            {isLoading ? 'Archivage…' : 'Archiver'}
          </button>
        )}

        {publicationStatus === 'ARCHIVED' && (
          <button
            type="button"
            onClick={handleRestore}
            disabled={isLoading}
            className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
          >
            {isLoading ? 'Restauration…' : 'Restaurer le vélo'}
          </button>
        )}
      </div>

      {error && (
        <div
          style={{
            padding: '10px',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#b91c1c',
            borderRadius: '8px',
            fontSize: '0.85rem',
          }}
        >
          {error}
        </div>
      )}

      {isOpen && (
        <div className={styles.drawerOverlay} onClick={() => !isLoading && setIsOpen(false)}>
          <div
            className={styles.drawerContent}
            role="dialog"
            aria-modal="true"
            aria-labelledby="identity-drawer-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.drawerHeader}>
              <h3 id="identity-drawer-title" className={styles.drawerTitle}>
                📝 Modifier l’identité du vélo
              </h3>
              <button
                type="button"
                onClick={() => !isLoading && setIsOpen(false)}
                className={styles.closeBtn}
                disabled={isLoading}
                aria-label="Fermer"
              >
                ✕
              </button>
            </div>

            <form
              onSubmit={handleUpdate}
              style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
            >
              <div className={styles.formGroup}>
                <label htmlFor="edit-name" className={styles.formLabel}>
                  Nom commercial du vélo :
                </label>
                <input
                  id="edit-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={styles.inputField}
                  required
                  disabled={isLoading}
                />
              </div>

              <div className={styles.formGroup}>
                <label htmlFor="edit-category" className={styles.formLabel}>
                  Catégorie de vélo :
                </label>
                <select
                  id="edit-category"
                  value={selectedCatId}
                  onChange={(e) => setSelectedCatId(e.target.value)}
                  className={styles.inputField}
                  required
                  disabled={isLoading}
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className={styles.formGroup}>
                <label htmlFor="edit-desc" className={styles.formLabel}>
                  Description commerciale :
                </label>
                <textarea
                  id="edit-desc"
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  className={styles.textareaField}
                  required
                  disabled={isLoading}
                />
              </div>

              <div className={styles.drawerFooter}>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  disabled={isLoading}
                  className={styles.actionBtn}
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={isLoading}
                  className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
                >
                  {isLoading ? 'Enregistrement…' : 'Enregistrer les modifications'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
