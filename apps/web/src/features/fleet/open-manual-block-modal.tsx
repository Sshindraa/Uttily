'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CreateManualBlockResult } from '@uttily/core';
import type { ActionResult } from '@uttily/contracts';
import { createManualBlockAction } from '@/app/actions/availability';
import styles from './fleet.module.css';

interface OpenManualBlockModalProps {
  orgId: string;
  item: {
    id: string;
    internalSku: string;
    productName: string;
    variantName: string;
    locationId: string;
    locationName: string;
    locationTimeZone: string | undefined;
  };
  onCompleted?: () => void;
}

const EMPTY_RESULT: ActionResult<CreateManualBlockResult> = {
  ok: false,
  code: 'UNKNOWN',
  message: '',
};

export function OpenManualBlockModal({
  orgId,
  item,
  onCompleted,
}: OpenManualBlockModalProps): React.ReactElement {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  function open(): void {
    setIdempotencyKey(globalThis.crypto.randomUUID());
    setStartAt('');
    setEndAt('');
    setError(null);
    setResult(null);
    setIsOpen(true);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const formData = new FormData();
    formData.set('inventoryItemId', item.id);
    formData.set('locationId', item.locationId);
    formData.set('startAt', startAt);
    formData.set('endAt', endAt);
    formData.set('idempotencyKey', idempotencyKey);

    try {
      const response = await createManualBlockAction(orgId, EMPTY_RESULT, formData);
      if (!response.ok) {
        setError(response.message || 'Le blocage manuel n’a pas pu être créé.');
        return;
      }

      setIsOpen(false);
      setResult('Exemplaire rendu indisponible sur la période demandée.');
      onCompleted?.();
      router.refresh();
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : 'Le blocage manuel n’a pas pu être créé.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        className={styles.maintenanceTriggerBtn}
        aria-haspopup="dialog"
      >
        Bloquer temporairement
      </button>
      {result && (
        <p role="status" aria-live="polite" style={{ margin: 0 }}>
          {result}
        </p>
      )}
      {isOpen && (
        <div
          className={styles.modalOverlay}
          role="dialog"
          aria-modal="true"
          aria-labelledby="manual-block-title"
          onClick={() => !loading && setIsOpen(false)}
        >
          <div className={styles.modalContent} onClick={(event) => event.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3 id="manual-block-title">Bloquer temporairement un exemplaire</h3>
              <button
                type="button"
                onClick={() => !loading && setIsOpen(false)}
                className={styles.closeBtn}
                disabled={loading}
                aria-label="Fermer"
              >
                ✕
              </button>
            </div>

            <p className={styles.modalSub}>
              {item.internalSku} · {item.productName} ({item.variantName}) · {item.locationName}
            </p>
            <p className={styles.modalSub}>
              Les horaires sont interprétés dans le fuseau de l’établissement
              {item.locationTimeZone ? ` (${item.locationTimeZone})` : ''}. Le blocage reste actif
              jusqu’à sa libération manuelle.
            </p>

            <form onSubmit={handleSubmit} className={styles.form}>
              {error && (
                <div className={styles.formError} role="alert" aria-live="assertive">
                  {error}
                </div>
              )}
              <div className={styles.formGroup}>
                <label htmlFor="manual-block-start">Début du blocage :</label>
                <input
                  id="manual-block-start"
                  type="datetime-local"
                  value={startAt}
                  onChange={(event) => setStartAt(event.target.value)}
                  disabled={loading}
                  className={styles.textInput}
                  required
                />
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="manual-block-end">Fin du blocage :</label>
                <input
                  id="manual-block-end"
                  type="datetime-local"
                  value={endAt}
                  onChange={(event) => setEndAt(event.target.value)}
                  disabled={loading}
                  className={styles.textInput}
                  required
                />
              </div>
              <p className={styles.modalSub}>
                Le blocage ne modifie ni le statut, ni l’état physique, ni les réservations, ni les
                maintenances de l’exemplaire. Toute réservation, hold ou maintenance chevauchante
                sera refusée.
              </p>
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
                  {loading ? 'Blocage en cours…' : 'Confirmer le blocage'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
