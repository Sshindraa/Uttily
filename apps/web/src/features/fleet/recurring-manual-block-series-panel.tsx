'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type {
  RecurringManualBlockSeriesMutationResult,
  RecurringManualBlockSeriesView,
  ReleaseRecurringManualBlockOccurrenceResult,
} from '@uttily/core';
import type { ActionResult } from '@uttily/contracts';
import {
  deleteRecurringManualBlockSeriesAction,
  releaseRecurringManualBlockOccurrenceAction,
  resumeRecurringManualBlockSeriesAction,
  suspendRecurringManualBlockSeriesAction,
  updateRecurringManualBlockSeriesAction,
} from '@/app/actions/availability';
import styles from './fleet.module.css';

interface RecurringManualBlockSeriesPanelProps {
  organizationId: string;
  views: RecurringManualBlockSeriesView[];
  items: ReadonlyArray<{
    id: string;
    internalSku: string;
    productName: string;
    variantName: string;
    locationName: string;
  }>;
}

const EMPTY_SERIES_RESULT: ActionResult<RecurringManualBlockSeriesMutationResult> = {
  ok: false,
  code: 'UNKNOWN',
  message: '',
};
const EMPTY_OCCURRENCE_RESULT: ActionResult<ReleaseRecurringManualBlockOccurrenceResult> = {
  ok: false,
  code: 'UNKNOWN',
  message: '',
};

export function RecurringManualBlockSeriesPanel({
  organizationId,
  views,
  items,
}: RecurringManualBlockSeriesPanelProps): React.ReactElement | null {
  const router = useRouter();
  const [editingSeriesId, setEditingSeriesId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (views.length === 0) return null;

  function itemLabel(inventoryItemId: string): string {
    const item = items.find((candidate) => candidate.id === inventoryItemId);
    return item
      ? `${item.internalSku} · ${item.productName} (${item.variantName}) · ${item.locationName}`
      : 'Exemplaire';
  }

  function beginEdit(view: RecurringManualBlockSeriesView): void {
    setEditingSeriesId(view.series.id);
    setStartDate(view.series.startDate);
    setEndDate(view.series.endDate);
    setStartTime(view.series.startTime.slice(0, 5));
    setEndTime(view.series.endTime.slice(0, 5));
    setFeedback(null);
    setError(null);
  }

  async function updateSeries(event: React.FormEvent<HTMLFormElement>, seriesId: string) {
    event.preventDefault();
    setBusyKey(`update:${seriesId}`);
    setError(null);
    const formData = new FormData();
    formData.set('seriesId', seriesId);
    formData.set('startDate', startDate);
    formData.set('endDate', endDate);
    formData.set('startTime', startTime);
    formData.set('endTime', endTime);
    formData.set('idempotencyKey', globalThis.crypto.randomUUID());
    const response = await updateRecurringManualBlockSeriesAction(
      organizationId,
      EMPTY_SERIES_RESULT,
      formData,
    );
    setBusyKey(null);
    if (!response.ok) {
      setError(response.message || 'La série n’a pas pu être modifiée.');
      return;
    }
    setEditingSeriesId(null);
    setFeedback('Série mise à jour ; les occurrences déjà commencées restent inchangées.');
    router.refresh();
  }

  async function transitionSeries(
    seriesId: string,
    action:
      | typeof suspendRecurringManualBlockSeriesAction
      | typeof resumeRecurringManualBlockSeriesAction,
    actionLabel: string,
  ): Promise<void> {
    setBusyKey(`${actionLabel}:${seriesId}`);
    setError(null);
    const formData = new FormData();
    formData.set('seriesId', seriesId);
    formData.set('idempotencyKey', globalThis.crypto.randomUUID());
    const response = await action(organizationId, EMPTY_SERIES_RESULT, formData);
    setBusyKey(null);
    if (!response.ok) {
      setError(response.message || 'La série n’a pas pu être modifiée.');
      return;
    }
    setFeedback(
      actionLabel === 'suspend'
        ? 'Série suspendue sans libérer ses occurrences.'
        : 'Série reprise.',
    );
    router.refresh();
  }

  async function deleteSeries(seriesId: string): Promise<void> {
    if (!globalThis.confirm('Supprimer cette série sans libérer ses occurrences déjà créées ?'))
      return;
    setBusyKey(`delete:${seriesId}`);
    setError(null);
    const formData = new FormData();
    formData.set('seriesId', seriesId);
    formData.set('idempotencyKey', globalThis.crypto.randomUUID());
    const response = await deleteRecurringManualBlockSeriesAction(
      organizationId,
      EMPTY_SERIES_RESULT,
      formData,
    );
    setBusyKey(null);
    if (!response.ok) {
      setError(response.message || 'La série n’a pas pu être supprimée.');
      return;
    }
    setFeedback('Série supprimée ; les occurrences existantes restent auditables.');
    router.refresh();
  }

  async function releaseOccurrence(seriesId: string, occurrenceId: string): Promise<void> {
    setBusyKey(`release:${occurrenceId}`);
    setError(null);
    const formData = new FormData();
    formData.set('seriesId', seriesId);
    formData.set('occurrenceId', occurrenceId);
    formData.set('idempotencyKey', globalThis.crypto.randomUUID());
    const response = await releaseRecurringManualBlockOccurrenceAction(
      organizationId,
      EMPTY_OCCURRENCE_RESULT,
      formData,
    );
    setBusyKey(null);
    if (!response.ok) {
      setError(response.message || 'L’occurrence n’a pas pu être libérée.');
      return;
    }
    setFeedback('Occurrence libérée explicitement.');
    router.refresh();
  }

  return (
    <section aria-labelledby="recurring-series-heading" style={{ marginTop: '2rem' }}>
      <h2 id="recurring-series-heading" style={{ marginBottom: '0.5rem' }}>
        Blocages récurrents
      </h2>
      <p style={{ color: 'var(--ut-color-ink-muted)', marginTop: 0 }}>
        Les séries sont hebdomadaires et chaque occurrence est matérialisée. Suspendre ou supprimer
        une série ne libère jamais silencieusement un blocage existant.
      </p>
      {error && (
        <p role="alert" aria-live="assertive" className={styles.formError}>
          {error}
        </p>
      )}
      {feedback && (
        <p role="status" aria-live="polite" style={{ color: 'var(--ut-color-success)' }}>
          {feedback}
        </p>
      )}
      <div style={{ display: 'grid', gap: '1rem' }}>
        {views.map((view) => {
          const series = view.series;
          const isBusy = busyKey?.endsWith(series.id) ?? false;
          return (
            <article key={series.id} className={styles.modalContent} style={{ maxWidth: 'none' }}>
              <strong>{itemLabel(series.inventoryItemId)}</strong>
              <p style={{ margin: '0.5rem 0', color: 'var(--ut-color-ink-muted)' }}>
                Chaque semaine, du {series.startDate} au {series.endDate},{' '}
                {series.startTime.slice(0, 5)}–{series.endTime.slice(0, 5)} · {series.timeZone} ·{' '}
                <strong>{series.status === 'ACTIVE' ? 'Active' : 'Suspendue'}</strong>
              </p>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className={styles.maintenanceTriggerBtn}
                  onClick={() => beginEdit(view)}
                  disabled={isBusy}
                >
                  Modifier le calendrier
                </button>
                {series.status === 'ACTIVE' ? (
                  <button
                    type="button"
                    className={styles.maintenanceTriggerBtn}
                    onClick={() =>
                      transitionSeries(
                        series.id,
                        suspendRecurringManualBlockSeriesAction,
                        'suspend',
                      )
                    }
                    disabled={isBusy}
                  >
                    Suspendre
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.maintenanceTriggerBtn}
                    onClick={() =>
                      transitionSeries(series.id, resumeRecurringManualBlockSeriesAction, 'resume')
                    }
                    disabled={isBusy}
                  >
                    Reprendre
                  </button>
                )}
                <button
                  type="button"
                  className={styles.maintenanceTriggerBtn}
                  onClick={() => deleteSeries(series.id)}
                  disabled={isBusy}
                >
                  Supprimer la série
                </button>
              </div>
              {editingSeriesId === series.id && (
                <form onSubmit={(event) => updateSeries(event, series.id)} className={styles.form}>
                  <div className={styles.formGroup}>
                    <label htmlFor={`series-start-date-${series.id}`}>
                      Nouvelle date de début :
                    </label>
                    <input
                      id={`series-start-date-${series.id}`}
                      type="date"
                      value={startDate}
                      onChange={(event) => setStartDate(event.target.value)}
                      className={styles.textInput}
                      disabled={busyKey !== null}
                      required
                    />
                  </div>
                  <div className={styles.formGroup}>
                    <label htmlFor={`series-end-date-${series.id}`}>Nouvelle date de fin :</label>
                    <input
                      id={`series-end-date-${series.id}`}
                      type="date"
                      value={endDate}
                      onChange={(event) => setEndDate(event.target.value)}
                      className={styles.textInput}
                      disabled={busyKey !== null}
                      required
                    />
                  </div>
                  <div className={styles.formGroup}>
                    <label htmlFor={`series-start-time-${series.id}`}>
                      Heure locale de début :
                    </label>
                    <input
                      id={`series-start-time-${series.id}`}
                      type="time"
                      value={startTime}
                      onChange={(event) => setStartTime(event.target.value)}
                      className={styles.textInput}
                      disabled={busyKey !== null}
                      required
                    />
                  </div>
                  <div className={styles.formGroup}>
                    <label htmlFor={`series-end-time-${series.id}`}>Heure locale de fin :</label>
                    <input
                      id={`series-end-time-${series.id}`}
                      type="time"
                      value={endTime}
                      onChange={(event) => setEndTime(event.target.value)}
                      className={styles.textInput}
                      disabled={busyKey !== null}
                      required
                    />
                  </div>
                  <button type="submit" className={styles.submitBtn} disabled={busyKey !== null}>
                    {busyKey === `update:${series.id}`
                      ? 'Mise à jour…'
                      : 'Enregistrer le calendrier'}
                  </button>
                </form>
              )}
              <ul style={{ margin: '1rem 0 0', paddingLeft: '1.25rem' }}>
                {view.occurrences.map((occurrence) => (
                  <li key={occurrence.id}>
                    {occurrence.occurrenceDate} ·{' '}
                    {occurrence.status === 'ACTIVE' ? 'Bloqué' : 'Libéré'}
                    {occurrence.status === 'ACTIVE' && (
                      <button
                        type="button"
                        className={styles.closeBtn}
                        onClick={() => releaseOccurrence(series.id, occurrence.id)}
                        disabled={busyKey === `release:${occurrence.id}`}
                        aria-label={`Libérer l'occurrence du ${occurrence.occurrenceDate}`}
                      >
                        Libérer
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>
    </section>
  );
}
