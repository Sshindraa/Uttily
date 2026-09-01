'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  previewMyBookingCancellationAction,
  cancelMyBookingAction,
} from '@/app/actions/customer-bookings';
import type { CancellationPreviewResult } from '@uttily/core';
import { Dialog, Button } from '@uttily/ui';
import { getAccountCopy } from '@/lib/account-copy';
import { getIntlLocale } from '@/lib/locale';

interface CustomerCancellationModalProps {
  bookingId: string;
  locale: string;
}

function formatAmount(minor: number, currency: string, locale: string): string {
  const value = minor / 100;
  try {
    return new Intl.NumberFormat(getIntlLocale(locale), {
      style: 'currency',
      currency,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function CustomerCancellationModal({
  bookingId,
  locale,
}: CustomerCancellationModalProps): React.ReactElement {
  const copy = getAccountCopy(locale);
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

    const idempotencyKey = `cancel_cust_${bookingId}_${crypto.randomUUID()}`;
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
        setErrorMessage(copy.cancellation.stalePreview);
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
        {copy.cancellation.button}
      </Button>

      <Dialog open={isOpen} title={copy.cancellation.dialogTitle} onClose={handleClose}>
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
                ? copy.cancellation.successWithRefund(
                    formatAmount(successResult.refundAmountMinor, successResult.currency, locale),
                  )
                : copy.cancellation.successWithoutRefund}
            </p>
            <Button type="button" onClick={handleClose} variant="primary" style={{ width: '100%' }}>
              {copy.cancellation.backToBooking}
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
                {copy.cancellation.loading}
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
                    <span>{copy.cancellation.paidAmount}</span>
                    <strong>
                      {formatAmount(preview.paidAmountMinor, preview.currency, locale)}
                    </strong>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '0.9rem',
                      color: 'var(--ut-color-success)',
                    }}
                  >
                    <span>{copy.cancellation.expectedRefund}</span>
                    <strong>
                      {formatAmount(preview.refundAmountMinor, preview.currency, locale)}
                    </strong>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '0.9rem',
                      color: 'var(--ut-color-ink-muted)',
                    }}
                  >
                    <span>{copy.cancellation.retainedFees}</span>
                    <span>
                      {formatAmount(preview.retainedAmountMinor, preview.currency, locale)}
                    </span>
                  </div>
                </div>

                <p style={{ fontSize: '0.8rem', color: 'var(--ut-color-ink-muted)', margin: 0 }}>
                  {copy.cancellation.policyNotice}
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
                    {copy.cancellation.keepBooking}
                  </Button>
                  <Button
                    type="button"
                    onClick={handleConfirmCancellation}
                    disabled={isSubmitting}
                    variant="danger"
                  >
                    {isSubmitting ? copy.cancellation.cancelling : copy.cancellation.confirm}
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
