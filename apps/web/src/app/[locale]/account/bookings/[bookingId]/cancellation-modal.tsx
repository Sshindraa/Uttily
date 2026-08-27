'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  previewMyBookingCancellationAction,
  cancelMyBookingAction,
} from '@/app/actions/customer-bookings';
import type { CancellationPreviewResult } from '@uttily/core';

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
        // Recalcule la nouvelle preview immédiatement
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
      <button type="button" onClick={handleOpen} style={cancelTriggerButtonStyle}>
        Annuler ma réservation
      </button>

      {isOpen && (
        <div
          style={overlayStyle}
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancellation-title"
        >
          <div style={modalStyle}>
            {successResult ? (
              <div style={successContainerStyle}>
                <div style={successIconStyle}>✓</div>
                <h2 id="cancellation-title" style={modalTitleStyle}>
                  Réservation annulée
                </h2>
                <p style={successDescStyle}>
                  {successResult.refundAmountMinor > 0
                    ? `${formatAmount(successResult.refundAmountMinor, successResult.currency)} de remboursement ont été demandés.`
                    : 'Votre réservation a bien été annulée.'}
                </p>
                <button type="button" onClick={handleClose} style={primaryBtnStyle}>
                  Retour à ma réservation
                </button>
              </div>
            ) : (
              <>
                <h2 id="cancellation-title" style={modalTitleStyle}>
                  Annuler votre réservation ?
                </h2>

                {isLoadingPreview && (
                  <div style={loadingStateStyle}>
                    <p style={loadingTextStyle}>Calcul de vos conditions de remboursement...</p>
                  </div>
                )}

                {errorMessage && (
                  <div style={errorBannerStyle}>
                    <p style={errorTextStyle}>{errorMessage}</p>
                  </div>
                )}

                {preview && (
                  <div style={previewContentStyle}>
                    <div style={breakdownContainerStyle}>
                      <div style={breakdownRowStyle}>
                        <span>Montant payé</span>
                        <span style={boldValueStyle}>
                          {formatAmount(preview.paidAmountMinor, preview.currency)}
                        </span>
                      </div>
                      <div style={breakdownRowStyle}>
                        <span>Remboursement prévu</span>
                        <span style={refundValueStyle}>
                          {formatAmount(preview.refundAmountMinor, preview.currency)}
                        </span>
                      </div>
                      <div style={breakdownRowStyle}>
                        <span>Montant non remboursé</span>
                        <span style={retainedValueStyle}>
                          {formatAmount(preview.retainedAmountMinor, preview.currency)}
                        </span>
                      </div>
                    </div>

                    <p style={policyExplanationStyle}>
                      Selon les conditions d’annulation acceptées lors de votre réservation.
                    </p>

                    <div style={actionsRowStyle}>
                      <button
                        type="button"
                        onClick={handleClose}
                        disabled={isSubmitting}
                        style={secondaryBtnStyle}
                      >
                        Conserver ma réservation
                      </button>
                      <button
                        type="button"
                        onClick={handleConfirmCancellation}
                        disabled={isSubmitting}
                        style={dangerBtnStyle}
                      >
                        {isSubmitting ? 'Annulation...' : 'Confirmer l’annulation'}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

const cancelTriggerButtonStyle: React.CSSProperties = {
  backgroundColor: '#ffffff',
  color: '#dc2626',
  border: '1px solid #fecaca',
  borderRadius: '8px',
  padding: '0.65rem 1.15rem',
  fontSize: '0.9rem',
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'background-color 0.15s ease',
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'rgba(15, 23, 42, 0.65)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
  padding: '1rem',
};

const modalStyle: React.CSSProperties = {
  backgroundColor: '#ffffff',
  borderRadius: '16px',
  width: '100%',
  maxWidth: '460px',
  padding: '1.75rem',
  boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
};

const modalTitleStyle: React.CSSProperties = {
  fontSize: '1.25rem',
  fontWeight: 700,
  color: '#0f172a',
  margin: '0 0 1rem 0',
};

const loadingStateStyle: React.CSSProperties = {
  padding: '2rem 0',
  textAlign: 'center',
};

const loadingTextStyle: React.CSSProperties = {
  color: '#64748b',
  fontSize: '0.95rem',
  margin: 0,
};

const errorBannerStyle: React.CSSProperties = {
  backgroundColor: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: '8px',
  padding: '0.75rem 1rem',
  marginBottom: '1rem',
};

const errorTextStyle: React.CSSProperties = {
  color: '#b91c1c',
  fontSize: '0.85rem',
  margin: 0,
};

const previewContentStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
};

const breakdownContainerStyle: React.CSSProperties = {
  backgroundColor: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: '10px',
  padding: '1rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.65rem',
};

const breakdownRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  fontSize: '0.925rem',
  color: '#334155',
};

const boldValueStyle: React.CSSProperties = {
  fontWeight: 700,
  color: '#0f172a',
};

const refundValueStyle: React.CSSProperties = {
  fontWeight: 700,
  color: '#16a34a',
};

const retainedValueStyle: React.CSSProperties = {
  fontWeight: 600,
  color: '#64748b',
};

const policyExplanationStyle: React.CSSProperties = {
  fontSize: '0.825rem',
  color: '#64748b',
  margin: 0,
};

const actionsRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.75rem',
  marginTop: '0.5rem',
};

const secondaryBtnStyle: React.CSSProperties = {
  backgroundColor: '#f1f5f9',
  color: '#334155',
  border: 'none',
  borderRadius: '8px',
  padding: '0.65rem 1rem',
  fontSize: '0.9rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const dangerBtnStyle: React.CSSProperties = {
  backgroundColor: '#dc2626',
  color: '#ffffff',
  border: 'none',
  borderRadius: '8px',
  padding: '0.65rem 1.15rem',
  fontSize: '0.9rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const primaryBtnStyle: React.CSSProperties = {
  backgroundColor: '#0284c7',
  color: '#ffffff',
  border: 'none',
  borderRadius: '8px',
  padding: '0.75rem 1.5rem',
  fontSize: '0.95rem',
  fontWeight: 600,
  cursor: 'pointer',
  width: '100%',
};

const successContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  textAlign: 'center',
  gap: '0.75rem',
  padding: '1rem 0',
};

const successIconStyle: React.CSSProperties = {
  width: '48px',
  height: '48px',
  borderRadius: '50%',
  backgroundColor: '#ecfdf5',
  color: '#059669',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '1.5rem',
  fontWeight: 700,
};

const successDescStyle: React.CSSProperties = {
  color: '#475569',
  fontSize: '0.95rem',
  margin: '0 0 1rem 0',
};
