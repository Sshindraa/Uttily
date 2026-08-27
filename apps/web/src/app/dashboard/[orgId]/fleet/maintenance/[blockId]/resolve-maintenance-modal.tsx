'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  startMaintenanceCaseAction,
  resolveMaintenanceCaseAction,
} from '@/app/actions/maintenance';
import styles from './case-detail.module.css';

interface ResolveMaintenanceModalProps {
  orgId: string;
  maintenanceCaseId: string;
  internalSku: string;
  currentStatus: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
}

export function ResolveMaintenanceModal({
  orgId,
  maintenanceCaseId,
  internalSku,
  currentStatus,
}: ResolveMaintenanceModalProps): React.ReactElement {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [targetCondition, setTargetCondition] = useState<'GOOD' | 'NEW' | 'FAIR'>('GOOD');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStart() {
    setLoading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('maintenanceCaseId', maintenanceCaseId);
      formData.append('idempotencyKey', crypto.randomUUID());

      const result = await startMaintenanceCaseAction(
        orgId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );

      if (!result.ok) {
        setError(result.message || "Erreur lors du démarrage de l'intervention");
        setLoading(false);
        return;
      }

      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inattendue.');
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('maintenanceCaseId', maintenanceCaseId);
      formData.append('targetCondition', targetCondition);
      formData.append('notes', notes);
      formData.append('idempotencyKey', crypto.randomUUID());

      const result = await resolveMaintenanceCaseAction(
        orgId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );

      if (!result.ok) {
        setError(result.message || 'Erreur lors de la remise en service');
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

  if (currentStatus === 'RESOLVED') {
    return <span className={styles.tagAvailable}>✓ Dossier clôturé</span>;
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
      {currentStatus === 'OPEN' && (
        <button
          type="button"
          onClick={handleStart}
          disabled={loading}
          className={styles.startActionBtn}
        >
          {loading ? 'Démarrage…' : '🔧 Commencer l’intervention'}
        </button>
      )}

      {!isOpen ? (
        <button type="button" onClick={() => setIsOpen(true)} className={styles.resolvePrimaryBtn}>
          ✓ Terminer la réparation &amp; Remettre en service →
        </button>
      ) : (
        <div className={styles.modalCard}>
          <div className={styles.modalHeader}>
            <h3>🟢 Remise en service · {internalSku}</h3>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className={styles.closeBtn}
              disabled={loading}
            >
              ✕
            </button>
          </div>

          <p className={styles.modalSub}>
            Validez les réparations effectuées pour lever le blocage et rendre ce vélo à nouveau
            disponible à la location.
          </p>

          <form onSubmit={handleSubmit} className={styles.form}>
            {error && <div className={styles.formError}>{error}</div>}

            <div className={styles.formGroup}>
              <label htmlFor="target-condition">Nouvel état physique du vélo :</label>
              <select
                id="target-condition"
                value={targetCondition}
                onChange={(e) => setTargetCondition(e.target.value as 'GOOD' | 'NEW' | 'FAIR')}
                disabled={loading}
                className={styles.selectInput}
              >
                <option value="GOOD">Bon état / Prêt pour la location</option>
                <option value="NEW">Comme neuf / Révision complète</option>
                <option value="FAIR">État d'usage normal</option>
              </select>
            </div>

            <div className={styles.formGroup}>
              <label htmlFor="intervention-notes">
                Travaux &amp; pièces remplacées (facultatif) :
              </label>
              <textarea
                id="intervention-notes"
                rows={2}
                placeholder="Ex : Plaquettes changées, chaîne lubrifiée, pression vérifiée"
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
                {loading ? 'Validation en cours…' : '✓ Confirmer la remise en service'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
