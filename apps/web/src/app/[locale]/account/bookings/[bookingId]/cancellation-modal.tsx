'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  previewMyBookingCancellationAction,
  cancelMyBookingAction,
} from '@/app/actions/customer-bookings';
import type { CancellationPreviewResult } from '@uttily/core';
import { Dialog, Button } from '@uttily/ui';

interface CustomerCancellationModalProps {
  bookingId: string;
}

function formatAmount(minor: number, currency: string): string {
  const value = minor / 100;
  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function CustomerCancellationModal({
  bookingId,
}: CustomerCancellationModalProps): React.ReactElement {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [preview, setPreview] = useState<CancellationPreviewResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successResult, setSuccessResult] = useState<{
    refundAmountMinor: number;
    currency: string;
  } | null>(null);

  async function handleOpen() {
    setIsOpen(true);
    setIsLoadingPreview(true);
    setErrorMessage(null);
    setSuccessResult(null);

    const res = await previewMyBookingCancellationAction(bookingId);
    setIsLoadingPreview(false);

    if (res.ok) {
      setPreview(res.data);
    } else {
      setErrorMessage(res.message);
    }
  }

  function handleClose() {
    setIsOpen(false);
    setPreview(null);
    setErrorMessage(null);
    setSuccessResult(null);
    if (successResult) {
      router.refresh();
    }
  }

  async function handleConfirmCancellation() {
    if (!preview) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    const idempotencyKey = `cancel_cust_${bookingId}_${Date.now()}`;
    const res = await cancelMyBookingAction({
      bookingId,
      idempotencyKey,
      previewFingerprint: preview.previewFingerprint,
    });

    setIsSubmitting(false);

    if (res.ok) {
      setSuccessResult({
        refundAmountMinor: res.data.refundAmountMinor,
        currency: 'EUR',
      });
    } else {
      if (res.error === 'PREVIEW_STALE') {
        setErrorMessage('Les conditions ont évolué. Vos montants ont été actualisés.');
        const refreshRes = await previewMyBookingCancellationAction(bookingId);
        if (refreshRes.ok) {
          setPreview(refreshRes.data);
        }
      } else {
        setErrorMessage(res.message);
      }
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="quiet"
        onClick={handleOpen}
        style={{
          color: 'var(--ut-color-danger)',
          borderColor: 'var(--ut-color-danger-soft)',
          border: '1px solid currentColor',
        }}
      >
        Annuler ma réservation
      </Button>

      <Dialog open={isOpen} title="Annulation de réservation" onClose={handleClose}>
        {successResult ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
              gap: '1rem',
              padding: '1rem 0',
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: 'var(--ut-color-success-soft)',
                color: 'var(--ut-color-success)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1.5rem',
              }}
            >
              ✓
            </div>
            <p style={{ color: 'var(--ut-color-ink-strong)', fontSize: '1rem', margin: 0 }}>
              {successResult.refundAmountMinor > 0
                ? `Votre réservation a bien été annulée. Une demande de remboursement de ${formatAmount(successResult.refundAmountMinor, successResult.currency)} a été transmise pour traitement selon les conditions applicables.`
                : 'Votre réservation a bien été annulée.'}
            </p>
            <Button type="button" onClick={handleClose} variant="primary" style={{ width: '100%' }}>
              Retour à ma réservation
            </Button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {isLoadingPreview && (
              <div
                style={{
                  padding: '1.5rem 0',
                  textAlign: 'center',
                  color: 'var(--ut-color-ink-muted)',
                }}
              >
                Calcul des conditions de remboursement...
              </div>
            )}

            {errorMessage && (
              <div
                role="alert"
                style={{
                  background: 'var(--ut-color-danger-soft)',
                  color: 'var(--ut-color-danger)',
                  padding: '0.75rem',
                  borderRadius: 'var(--ut-radius-md)',
                  fontSize: '0.875rem',
                }}
              >
                {errorMessage}
              </div>
            )}

            {preview && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div
                  style={{
                    background: 'var(--ut-color-surface-soft)',
                    borderRadius: 'var(--ut-radius-md)',
                    padding: '1rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem',
                    border: 'var(--ut-border-thin)',
                  }}
                >
                  <div
                    style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}
                  >
                    <span>Montant réglé</span>
                    <strong>{formatAmount(preview.paidAmountMinor, preview.currency)}</strong>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '0.9rem',
                      color: 'var(--ut-color-success)',
                    }}
                  >
                    <span>Remboursement prévu</span>
                    <strong>{formatAmount(preview.refundAmountMinor, preview.currency)}</strong>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '0.9rem',
                      color: 'var(--ut-color-ink-muted)',
                    }}
                  >
                    <span>Frais retenus</span>
                    <span>{formatAmount(preview.retainedAmountMinor, preview.currency)}</span>
                  </div>
                </div>

                <p style={{ fontSize: '0.8rem', color: 'var(--ut-color-ink-muted)', margin: 0 }}>
                  Calculé conformément à la politique d’annulation applicable à cette réservation.
                </p>

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: '0.75rem',
                    marginTop: '0.5rem',
                  }}
                >
                  <Button
                    type="button"
                    onClick={handleClose}
                    disabled={isSubmitting}
                    variant="secondary"
                  >
                    Conserver ma réservation
                  </Button>
                  <Button
                    type="button"
                    onClick={handleConfirmCancellation}
                    disabled={isSubmitting}
                    variant="danger"
                  >
                    {isSubmitting ? 'Annulation…' : 'Confirmer l’annulation'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
