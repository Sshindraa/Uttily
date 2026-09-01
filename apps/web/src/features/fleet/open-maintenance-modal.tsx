'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { openMaintenanceCaseAction } from '@/app/actions/maintenance';
import { getCategoryPresentation } from '@/features/equipment/category-presentation';
import styles from './fleet.module.css';

interface OpenMaintenanceModalProps {
  orgId: string;
  items: {
    id: string;
    internalSku: string;
    productName: string;
    categorySlug: string;
  }[];
}

export function OpenMaintenanceModal({
  orgId,
  items,
}: OpenMaintenanceModalProps): React.ReactElement {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState(items[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('inventoryItemId', selectedItemId);
      formData.append('reason', reason);
      formData.append('notes', notes);
      formData.append('idempotencyKey', crypto.randomUUID());

      const result = await openMaintenanceCaseAction(
        orgId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );

      if (!result.ok) {
        setError(result.message || "Erreur lors de l'ouverture de la maintenance");
        setLoading(false);
        return;
      }

      setIsOpen(false);
      setReason('');
      setNotes('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inattendue.');
    } finally {
      setLoading(false);
    }
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={styles.maintenanceTriggerBtn}
      >
        🔧 Mettre un équipement en maintenance
      </button>
    );
  }

  return (
    <div
      className={styles.modalOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="open-maintenance-title"
    >
      <div className={styles.modalContent}>
        <div className={styles.modalHeader}>
          <h3 id="open-maintenance-title">🔧 Mettre un équipement en maintenance</h3>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className={styles.closeBtn}
            disabled={loading}
            aria-label="Fermer"
          >
            ✕
          </button>
        </div>

        <p className={styles.modalSub}>
          Cet équipement sera immédiatement retiré des disponibilités de réservation jusqu'à sa
          remise en service.
        </p>

        <form onSubmit={handleSubmit} className={styles.form}>
          {error && <div className={styles.formError}>{error}</div>}

          <div className={styles.formGroup}>
            <label htmlFor="select-item">Choisir l’équipement :</label>
            <select
              id="select-item"
              value={selectedItemId}
              onChange={(e) => setSelectedItemId(e.target.value)}
              disabled={loading}
              className={styles.selectInput}
              required
            >
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.internalSku} · {getCategoryPresentation(item.categorySlug).icon}{' '}
                  {getCategoryPresentation(item.categorySlug).singularLabel} · {item.productName}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.formGroup}>
            <label htmlFor="reason-input">Motif de l'intervention :</label>
            <input
              id="reason-input"
              type="text"
              placeholder="Ex : Contrôle technique, accessoire manquant, nettoyage"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={loading}
              className={styles.textInput}
              required
            />
          </div>

          <div className={styles.formGroup}>
            <label htmlFor="notes-input">Notes d'atelier (facultatif) :</label>
            <textarea
              id="notes-input"
              rows={2}
              placeholder="Ex : Pièces commandées, intervention prévue demain"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={loading}
              className={styles.textArea}
            />
          </div>

          <div className={styles.modalFooter}>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              disabled={loading}
              className={styles.cancelBtn}
            >
              Annuler
            </button>
            <button type="submit" disabled={loading} className={styles.submitBtn}>
              {loading ? 'Traitement…' : 'Bloquer & Mettre en maintenance'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
