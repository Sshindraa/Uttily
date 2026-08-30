'use client';

import { useState } from 'react';
import {
  previewBookingCancellationAction,
  cancelConfirmedBookingAction,
} from '@/app/actions/cancellations';
import type { CancellationActorReason, CancellationPreviewResult } from '@uttily/core';
import styles from './booking-detail.module.css';

interface CancellationFlowProps {
  orgId: string;
  bookingId: string;
}

export function CancellationFlow({ orgId, bookingId }: CancellationFlowProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [actorReason, setActorReason] = useState<CancellationActorReason>('MERCHANT_CANCELLATION');
  const [preview, setPreview] = useState<CancellationPreviewResult | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staleWarning, setStaleWarning] = useState<string | null>(null);

  async function handleOpenModal(): Promise<void> {
    setIsOpen(true);
    setError(null);
    setStaleWarning(null);
    setIsLoadingPreview(true);
    try {
      const res = await previewBookingCancellationAction(orgId, bookingId, actorReason);
      setPreview(res);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Erreur lors du chargement de la prévisualisation d'annulation.",
      );
    } finally {
      setIsLoadingPreview(false);
    }
  }

  async function handleReasonChange(newReason: CancellationActorReason): Promise<void> {
    setActorReason(newReason);
    setStaleWarning(null);
    setIsLoadingPreview(true);
    try {
      const res = await previewBookingCancellationAction(orgId, bookingId, newReason);
      setPreview(res);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Erreur lors de la mise à jour de la prévisualisation.',
      );
    } finally {
      setIsLoadingPreview(false);
    }
  }

  async function handleConfirmCancellation(): Promise<void> {
    setError(null);
    setStaleWarning(null);
    setIsSubmitting(true);
    try {
      await cancelConfirmedBookingAction(
        orgId,
        bookingId,
        actorReason,
        crypto.randomUUID(),
        preview?.previewFingerprint,
      );
      window.location.reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('PREVIEW_STALE') || message.includes('évolué')) {
        setStaleWarning(
          "⚠️ Les conditions d'annulation viennent d'être mises à jour par le système. Les montants ci-dessous ont été actualisés. Veuillez les vérifier attentivement avant de confirmer.",
        );
        try {
          const freshPreview = await previewBookingCancellationAction(
            orgId,
            bookingId,
            actorReason,
          );
          setPreview(freshPreview);
        } catch {
          // ignore
        }
      } else {
        setError(
          message.length > 0
            ? message
            : "Erreur lors de l'exécution de l'annulation de la réservation.",
        );
      }
      setIsSubmitting(false);
    }
  }

  function formatEur(minor: number): string {
    return `${(minor / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  }

  return (
    <>
      <button type="button" onClick={handleOpenModal} className={styles.btnCancelBooking}>
        ✕ Annuler la réservation
      </button>

      {isOpen && (
        <div
          className={styles.modalOverlay}
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancellation-modal-title"
        >
          <div className={styles.modalContent}>
            <div className={styles.modalHeader}>
              <h2 id="cancellation-modal-title" className={styles.modalTitle}>
                ⚠️ Annuler la réservation
              </h2>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className={styles.modalCloseBtn}
                disabled={isSubmitting}
                aria-label="Fermer"
              >
                ✕
              </button>
            </div>

            {error && <div className={styles.errorAlert}>{error}</div>}
            {staleWarning && <div className={styles.staleAlert}>{staleWarning}</div>}

            <div className={styles.modalBody}>
              <div className={styles.reasonSelectorGroup}>
                <label className={styles.reasonLabel} htmlFor="cancellation-reason">
                  Motif de l'annulation :
                </label>
                <select
                  id="cancellation-reason"
                  value={actorReason}
                  onChange={(e) => handleReasonChange(e.target.value as CancellationActorReason)}
                  className={styles.selectReason}
                  disabled={isLoadingPreview || isSubmitting}
                >
                  <option value="MERCHANT_CANCELLATION">
                    Annulation par le loueur (Indisponibilité, casse, atelier)
                  </option>
                  <option value="CUSTOMER_CANCELLATION">
                    Annulation à la demande du locataire (Application de la politique)
                  </option>
                </select>
              </div>

              {isLoadingPreview ? (
                <div style={{ padding: '24px 0', textAlign: 'center', color: '#64748b' }}>
                  Calcul des montants de remboursement…
                </div>
              ) : preview ? (
                <div className={styles.previewBox}>
                  <div className={styles.previewExplanation}>
                    ℹ️ <strong>{preview.explanationLabel}</strong>
                  </div>

                  <div className={styles.previewGrid}>
                    <div className={styles.previewMetric}>
                      <span className={styles.metricLabel}>Montant payé par le client</span>
                      <strong className={styles.metricValue}>
                        {formatEur(preview.paidAmountMinor)}
                      </strong>
                    </div>

                    <div className={styles.previewMetric}>
                      <span className={styles.metricLabel}>Remboursement au client</span>
                      <strong className={`${styles.metricValue} ${styles.metricGreen}`}>
                        {formatEur(preview.refundAmountMinor)}
                      </strong>
                    </div>

                    <div className={styles.previewMetric}>
                      <span className={styles.metricLabel}>Frais conservés loueur</span>
                      <strong className={styles.metricValue}>
                        {formatEur(preview.retainedAmountMinor)}
                      </strong>
                    </div>

                    <div className={styles.previewMetric}>
                      <span className={styles.metricLabel}>Revenu net loueur final</span>
                      <strong className={`${styles.metricValue} ${styles.metricBlue}`}>
                        {formatEur(preview.finalMerchantRevenueMinor)}
                      </strong>
                    </div>
                  </div>

                  <div className={styles.inventoryNotice}>
                    🧰 <strong>Libération de flotte :</strong> L’équipement physique attribué à
                    cette réservation redeviendra immédiatement disponible à la location.
                  </div>
                </div>
              ) : null}
            </div>

            <div className={styles.modalFooter}>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className={styles.btnSecondary}
                disabled={isSubmitting}
              >
                Retour
              </button>

              <button
                type="button"
                onClick={handleConfirmCancellation}
                disabled={isSubmitting || isLoadingPreview}
                className={styles.btnConfirmCancel}
              >
                {isSubmitting ? 'Annulation en cours…' : "Confirmer l'annulation définitive"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
