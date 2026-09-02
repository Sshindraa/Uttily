'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { RecurringManualBlockSeriesMutationResult } from '@uttily/core';
import type { ActionResult } from '@uttily/contracts';
import { createRecurringManualBlockSeriesAction } from '@/app/actions/availability';
import styles from './fleet.module.css';

interface OpenRecurringManualBlockModalProps {
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

const EMPTY_RESULT: ActionResult<RecurringManualBlockSeriesMutationResult> = {
  ok: false,
  code: 'UNKNOWN',
  message: '',
};

export function OpenRecurringManualBlockModal({
  orgId,
  item,
  onCompleted,
}: OpenRecurringManualBlockModalProps): React.ReactElement {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  function open(): void {
    setIdempotencyKey(globalThis.crypto.randomUUID());
    setStartDate('');
    setEndDate('');
    setStartTime('');
    setEndTime('');
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
    formData.set('startDate', startDate);
    formData.set('endDate', endDate);
    formData.set('startTime', startTime);
    formData.set('endTime', endTime);
    formData.set('timeZone', item.locationTimeZone ?? '');
    formData.set('idempotencyKey', idempotencyKey);

    try {
      const response = await createRecurringManualBlockSeriesAction(orgId, EMPTY_RESULT, formData);
      if (!response.ok) {
        setError(response.message || 'La série de blocages n’a pas pu être créée.');
        return;
      }
      setIsOpen(false);
      setResult(`${response.data.occurrenceCount} blocage(s) récurrent(s) planifié(s).`);
      onCompleted?.();
      router.refresh();
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : 'La série de blocages n’a pas pu être créée.',
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
        Planifier un blocage récurrent
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
          aria-labelledby="recurring-manual-block-title"
          onClick={() => !loading && setIsOpen(false)}
        >
          <div className={styles.modalContent} onClick={(event) => event.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3 id="recurring-manual-block-title">Planifier un blocage récurrent</h3>
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
              Une série concerne cet exemplaire uniquement. Elle est hebdomadaire, limitée à 12
              semaines et matérialisée immédiatement dans la disponibilité.
            </p>
            <p className={styles.modalSub}>
              Fuseau de l’établissement : <strong>{item.locationTimeZone ?? 'inconnu'}</strong>. Une
              heure inexistante ou ambiguë lors d’un changement d’heure sera refusée.
            </p>

            <form onSubmit={handleSubmit} className={styles.form}>
              {error && (
                <div className={styles.formError} role="alert" aria-live="assertive">
                  {error}
                </div>
              )}
              <div className={styles.formGroup}>
                <label htmlFor="recurring-block-start-date">Date de début :</label>
                <input
                  id="recurring-block-start-date"
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                  disabled={loading}
                  className={styles.textInput}
                  required
                />
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="recurring-block-end-date">Date de fin :</label>
                <input
                  id="recurring-block-end-date"
                  type="date"
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                  disabled={loading}
                  className={styles.textInput}
                  required
                />
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="recurring-block-start-time">Heure locale de début :</label>
                <input
                  id="recurring-block-start-time"
                  type="time"
                  value={startTime}
                  onChange={(event) => setStartTime(event.target.value)}
                  disabled={loading}
                  className={styles.textInput}
                  required
                />
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="recurring-block-end-time">Heure locale de fin :</label>
                <input
                  id="recurring-block-end-time"
                  type="time"
                  value={endTime}
                  onChange={(event) => setEndTime(event.target.value)}
                  disabled={loading}
                  className={styles.textInput}
                  required
                />
              </div>
              <p className={styles.modalSub}>
                Les conflits avec une réservation, un hold, une maintenance ou un autre blocage
                annulent toute la série. Suspendre ou supprimer la série ne libère pas les
                occurrences déjà créées ; leur libération est explicite.
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
                  {loading ? 'Planification en cours…' : 'Confirmer la série'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
