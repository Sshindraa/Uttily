'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createConditionReportAction, pickupBookingAction } from '@/app/actions/fulfillment';
import styles from './booking-detail.module.css';

interface DepartureFlowProps {
  orgId: string;
  bookingId: string;
  items: {
    bookingItemId: string;
    internalSku: string;
    serialNumber: string | null;
    currentCondition: string;
  }[];
}

export function DepartureFlow({ orgId, bookingId, items }: DepartureFlowProps): React.ReactElement {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [condition, setCondition] = useState<'GOOD' | 'FAIR' | 'POOR'>('GOOD');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstItem = items[0];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // 1. Enregistrer le rapport d'état au départ si un exemplaire existe
      if (firstItem) {
        const conditionFormData = new FormData();
        conditionFormData.append('bookingId', bookingId);
        conditionFormData.append('bookingItemId', firstItem.bookingItemId);
        conditionFormData.append('phase', 'PICKUP');
        conditionFormData.append('condition', condition);
        conditionFormData.append('notes', notes);
        conditionFormData.append('idempotencyKey', crypto.randomUUID());

        const conditionResult = await createConditionReportAction(
          orgId,
          { ok: false, code: 'UNKNOWN', message: '' },
          conditionFormData,
        );

        if (!conditionResult.ok) {
          setError(conditionResult.message || "Erreur lors de l'enregistrement de l'état");
          setLoading(false);
          return;
        }
      }

      // 2. Transitionner vers ACTIVE (Vélo remis au client)
      const transitionFormData = new FormData();
      transitionFormData.append('bookingId', bookingId);
      transitionFormData.append('idempotencyKey', crypto.randomUUID());

      const pickupResult = await pickupBookingAction(
        orgId,
        { ok: false, code: 'UNKNOWN', message: '' },
        transitionFormData,
      );

      if (!pickupResult.ok) {
        setError(pickupResult.message || 'Erreur lors du départ');
        setLoading(false);
        return;
      }

      setIsOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inattendue.');
    } finally {
      setLoading(false);
    }
  }

  if (!isOpen) {
    return (
      <button type="button" onClick={() => setIsOpen(true)} className={styles.primaryActionBtn}>
        🟢 Préparer &amp; Confirmer le départ →
      </button>
    );
  }

  return (
    <div className={styles.flowModal}>
      <div className={styles.flowHeader}>
        <h3>🟢 Départ · Remise du vélo</h3>
        <button
          type="button"
          onClick={() => setIsOpen(false)}
          className={styles.closeBtn}
          disabled={loading}
        >
          ✕
        </button>
      </div>

      <div className={styles.flowChecklist}>
        <div className={styles.checkRow}>
          <span className={styles.checkIcon}>✓</span>
          <span>Réservation confirmée &amp; Paiement validé</span>
        </div>
        <div className={styles.checkRow}>
          <span className={styles.checkIcon}>✓</span>
          <span>
            Vélo attribué : <strong>{firstItem?.internalSku ?? '—'}</strong>
            {firstItem?.serialNumber ? ` (N° ${firstItem.serialNumber})` : ''}
          </span>
        </div>
      </div>

      <form onSubmit={handleSubmit} className={styles.flowForm}>
        {error && <div className={styles.formError}>{error}</div>}

        <div className={styles.formGroup}>
          <label htmlFor="departure-condition">État de l'exemplaire avant remise :</label>
          <select
            id="departure-condition"
            value={condition}
            onChange={(e) => setCondition(e.target.value as 'GOOD' | 'FAIR' | 'POOR')}
            disabled={loading}
            className={styles.selectInput}
          >
            <option value="GOOD">Très bon état / Prêt à rouler</option>
            <option value="FAIR">Bon état (traces d'usure normales)</option>
            <option value="POOR">À contrôler</option>
          </select>
        </div>

        <div className={styles.formGroup}>
          <label htmlFor="departure-notes">Remarques ou accessoires fournis (facultatif) :</label>
          <input
            id="departure-notes"
            type="text"
            placeholder="Ex : Casque et antivol remis, pression des pneus OK"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={loading}
            className={styles.textInput}
          />
        </div>

        <div className={styles.flowFooter}>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            disabled={loading}
            className={styles.cancelBtn}
          >
            Annuler
          </button>
          <button type="submit" disabled={loading} className={styles.submitBtn}>
            {loading ? 'Validation en cours…' : '✓ Confirmer la remise au client'}
          </button>
        </div>
      </form>
    </div>
  );
}
