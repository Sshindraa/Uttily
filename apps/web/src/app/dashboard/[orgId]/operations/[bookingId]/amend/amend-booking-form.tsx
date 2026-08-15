'use client';

import React, { useState, useRef, useTransition } from 'react';
import Link from 'next/link';
import {
  previewBookingAmendmentAction,
  confirmBookingAmendmentAction,
} from '@/app/actions/booking-amendments';
import type {
  PreviewBookingAmendmentSuccess,
  ConfirmBookingAmendmentSuccess,
  NeutralAmendmentIntent,
} from '@uttily/core';
import { buildPreviewBookingAmendmentInput } from './build-preview-input';
import { AmendmentPreviewResult, formatEuros } from './amendment-preview-result';

export interface AmendBookingFormLineProp {
  logicalLineId: string;
  variantId: string;
  productName: string;
  variantName: string;
  currentQuantity: number;
  unitPriceAmountMinor: number;
  lineTotalAmountMinor: number;
}

export interface AmendBookingFormProps {
  organizationId: string;
  bookingId: string;
  locationName: string;
  locationTimeZone: string;
  expectedLastAppliedAmendmentNumber: number;
  initialIntent: NeutralAmendmentIntent;
  currentTotalAmountMinor: number;
  lines: AmendBookingFormLineProp[];
}

export async function copyPaymentLinkToClipboard(
  amendmentId: string,
  origin: string,
  clipboardWrite?: (text: string) => Promise<void>,
): Promise<{ ok: boolean; feedback: string }> {
  const shareableUrl = `${origin}/checkout/amendment/${amendmentId}`;
  if (!clipboardWrite) {
    return { ok: false, feedback: 'Impossible de copier automatiquement.' };
  }
  try {
    await clipboardWrite(shareableUrl);
    return { ok: true, feedback: 'Lien de paiement copié !' };
  } catch {
    return { ok: false, feedback: 'Impossible de copier automatiquement.' };
  }
}

export interface SupplementPaymentHandoffProps {
  amendmentId: string;
  organizationId: string;
  bookingId: string;
  onCopy?: () => void;
  copyFeedback?: string | null;
}

export function SupplementPaymentHandoff({
  organizationId,
  bookingId,
  onCopy,
  copyFeedback,
}: SupplementPaymentHandoffProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onCopy}
          data-testid="copy-payment-link-button"
          style={{
            padding: '0.625rem 1.25rem',
            backgroundColor: '#2563eb',
            color: '#ffffff',
            border: 'none',
            borderRadius: '0.375rem',
            fontWeight: 600,
            fontSize: '0.875rem',
            cursor: 'pointer',
          }}
        >
          Copier le lien de paiement
        </button>

        <Link
          href={`/dashboard/${organizationId}/operations/${bookingId}`}
          style={{
            display: 'inline-block',
            padding: '0.625rem 1rem',
            backgroundColor: 'transparent',
            color: '#4b5563',
            border: '1px solid #d1d5db',
            borderRadius: '0.375rem',
            fontWeight: 500,
            fontSize: '0.875rem',
            textDecoration: 'none',
          }}
        >
          Voir la réservation
        </Link>
      </div>

      {copyFeedback && (
        <p
          role="status"
          aria-live="polite"
          data-testid="copy-payment-link-feedback"
          style={{
            margin: 0,
            fontSize: '0.875rem',
            color: copyFeedback === 'Impossible de copier automatiquement.' ? '#b91c1c' : '#059669',
            fontWeight: 500,
          }}
        >
          {copyFeedback}
        </p>
      )}
    </div>
  );
}

function formatHoldDeadlineTime(isoString: string, timeZone: string): string {
  try {
    const d = new Date(isoString);
    return new Intl.DateTimeFormat('fr-FR', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  } catch {
    return isoString;
  }
}

export function AmendBookingForm({
  organizationId,
  bookingId,
  locationName,
  locationTimeZone,
  expectedLastAppliedAmendmentNumber,
  initialIntent,
  currentTotalAmountMinor,
  lines,
}: AmendBookingFormProps): React.ReactElement {
  const [intentKind] = useState(initialIntent.kind);
  const [startDate, setStartDate] = useState(
    initialIntent.kind === 'DAY_RANGE' ? initialIntent.startDate : '',
  );
  const [endDateExclusive, setEndDateExclusive] = useState(
    initialIntent.kind === 'DAY_RANGE' ? initialIntent.endDateExclusive : '',
  );
  const [startAt, setStartAt] = useState(
    initialIntent.kind === 'TIME_RANGE' ? initialIntent.startAt : '',
  );
  const [endAt, setEndAt] = useState(
    initialIntent.kind === 'TIME_RANGE' ? initialIntent.endAt : '',
  );

  const [quantities, setQuantities] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    for (const l of lines) {
      initial[l.logicalLineId] = l.currentQuantity;
    }
    return initial;
  });

  const [isPreviewPending, startPreviewTransition] = useTransition();
  const [isConfirmPending, startConfirmTransition] = useTransition();

  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewBookingAmendmentSuccess | null>(null);
  const [confirmationResult, setConfirmationResult] =
    useState<ConfirmBookingAmendmentSuccess | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  // Clé d'idempotence stable pour chaque tentative de confirmation
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

  const previewErrorRef = useRef<HTMLDivElement>(null);
  const confirmErrorRef = useRef<HTMLDivElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const successHeadingRef = useRef<HTMLHeadingElement>(null);

  const invalidateWorkflow = () => {
    setPreview(null);
    setConfirmationResult(null);
    setCopyFeedback(null);
    setPreviewError(null);
    setConfirmError(null);
    idempotencyKeyRef.current = crypto.randomUUID();
  };

  const handleCopyPaymentLink = async (amendmentId: string) => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const writeFn = navigator?.clipboard?.writeText
      ? (text: string) => navigator.clipboard.writeText(text)
      : undefined;
    const res = await copyPaymentLinkToClipboard(amendmentId, origin, writeFn);
    setCopyFeedback(res.feedback);
  };

  const handleQuantityChange = (logicalLineId: string, value: string) => {
    const parsed = parseInt(value, 10);
    const qty = Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
    setQuantities((prev) => ({ ...prev, [logicalLineId]: qty }));
    invalidateWorkflow();
  };

  const handlePreviewSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPreviewError(null);
    setConfirmError(null);
    setConfirmationResult(null);

    const buildResult = buildPreviewBookingAmendmentInput({
      bookingId,
      expectedLastAppliedAmendmentNumber,
      intentKind,
      startDate,
      endDateExclusive,
      startAt,
      endAt,
      quantities,
      lines,
    });

    if (!buildResult.ok) {
      setPreviewError(buildResult.error);
      setTimeout(() => previewErrorRef.current?.focus(), 0);
      return;
    }

    startPreviewTransition(async () => {
      const result = await previewBookingAmendmentAction(organizationId, buildResult.input);
      if (!result.ok) {
        setPreviewError(result.message);
        setPreview(null);
        setTimeout(() => previewErrorRef.current?.focus(), 0);
      } else {
        setPreview(result.data);
        idempotencyKeyRef.current = crypto.randomUUID();
        setTimeout(() => resultHeadingRef.current?.focus(), 0);
      }
    });
  };

  const handleConfirmSubmit = () => {
    if (!preview) return;
    setConfirmError(null);

    const buildResult = buildPreviewBookingAmendmentInput({
      bookingId,
      expectedLastAppliedAmendmentNumber,
      intentKind,
      startDate,
      endDateExclusive,
      startAt,
      endAt,
      quantities,
      lines,
    });

    if (!buildResult.ok) {
      setConfirmError(buildResult.error);
      setTimeout(() => confirmErrorRef.current?.focus(), 0);
      return;
    }

    startConfirmTransition(async () => {
      const result = await confirmBookingAmendmentAction(organizationId, {
        ...buildResult.input,
        idempotencyKey: idempotencyKeyRef.current,
        expectedClassification: preview.classification,
        expectedDeltaAmountMinor: preview.deltaAmountMinor,
        expectedNextTotalAmountMinor: preview.nextContractualTotalAmountMinor,
      });

      if (!result.ok) {
        setConfirmError(result.message);
        if (result.code === 'CONFLICT_BLOCK') {
          // Conditions modifiées ou stock épuisé : réinitialiser la prévisualisation
          setPreview(null);
        }
        setTimeout(() => confirmErrorRef.current?.focus(), 0);
      } else {
        setConfirmationResult(result.data);
        setTimeout(() => successHeadingRef.current?.focus(), 0);
      }
    });
  };

  const isBusy = isPreviewPending || isConfirmPending;

  // Vue de succès post-confirmation (G7M-C5-B)
  if (confirmationResult !== null) {
    const isSupplement = confirmationResult.kind === 'PAYMENT_REQUIRED';
    return (
      <div
        aria-live="polite"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '1.5rem',
          backgroundColor: '#ffffff',
          border: '1px solid #e5e7eb',
          borderRadius: '0.5rem',
          padding: '2rem',
          maxWidth: '680px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div
            style={{
              width: '2.5rem',
              height: '2.5rem',
              borderRadius: '9999px',
              backgroundColor: isSupplement ? '#eff6ff' : '#ecfdf5',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: isSupplement ? '#2563eb' : '#059669',
              fontSize: '1.25rem',
            }}
          >
            ✓
          </div>
          <div>
            <h2
              ref={successHeadingRef}
              tabIndex={-1}
              data-testid="amendment-success-heading"
              style={{
                fontSize: '1.25rem',
                fontWeight: 600,
                margin: 0,
                color: '#111827',
                outline: 'none',
              }}
            >
              {isSupplement ? 'Modification en attente de paiement' : 'Modification enregistrée'}
            </h2>
            <p style={{ margin: '0.25rem 0 0 0', color: '#4b5563', fontSize: '0.875rem' }}>
              Réservation n° {bookingId.slice(0, 8)}
            </p>
          </div>
        </div>

        <div
          data-testid="amendment-success-message"
          style={{
            padding: '1rem',
            backgroundColor: isSupplement ? '#f0f9ff' : '#f0fdf4',
            border: isSupplement ? '1px solid #bae6fd' : '1px solid #bbf7d0',
            borderRadius: '0.375rem',
            fontSize: '0.925rem',
            color: isSupplement ? '#0369a1' : '#166534',
            lineHeight: 1.5,
          }}
        >
          {confirmationResult.kind === 'APPLIED_NEUTRAL' && (
            <p style={{ margin: 0 }}>La réservation a été mise à jour.</p>
          )}

          {confirmationResult.kind === 'APPLIED_REFUND' && (
            <p style={{ margin: 0 }}>
              La réservation a été mise à jour. Le remboursement de{' '}
              <strong>{formatEuros(confirmationResult.refundAmountMinor)}</strong> est en cours.
            </p>
          )}

          {confirmationResult.kind === 'PAYMENT_REQUIRED' && (
            <p style={{ margin: 0 }}>
              La modification est réservée pendant 10 minutes. Le client doit maintenant régler{' '}
              <strong>{formatEuros(confirmationResult.supplementAmountMinor)}</strong> avant{' '}
              <strong>
                {formatHoldDeadlineTime(confirmationResult.holdDeadline, locationTimeZone)}
              </strong>
              .
            </p>
          )}
        </div>

        {confirmationResult.kind === 'PAYMENT_REQUIRED' ? (
          <SupplementPaymentHandoff
            amendmentId={confirmationResult.amendmentId}
            organizationId={organizationId}
            bookingId={bookingId}
            onCopy={() => handleCopyPaymentLink(confirmationResult.amendmentId)}
            copyFeedback={copyFeedback}
          />
        ) : (
          <div>
            <Link
              href={`/dashboard/${organizationId}/operations/${bookingId}`}
              style={{
                display: 'inline-block',
                padding: '0.625rem 1.25rem',
                backgroundColor: '#2563eb',
                color: '#ffffff',
                borderRadius: '0.375rem',
                fontWeight: 500,
                fontSize: '0.875rem',
                textDecoration: 'none',
              }}
            >
              Voir la réservation
            </Link>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <form
        onSubmit={handlePreviewSubmit}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '1.5rem',
          backgroundColor: '#ffffff',
          border: '1px solid #e5e7eb',
          borderRadius: '0.5rem',
          padding: '1.5rem',
        }}
      >
        <section aria-labelledby="context-heading">
          <h2 id="context-heading" style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>
            Contexte de réservation
          </h2>
          <p style={{ margin: '0.25rem 0 0 0', color: '#4b5563', fontSize: '0.875rem' }}>
            Lieu : {locationName} ({locationTimeZone}) — Montant actuel :{' '}
            {formatEuros(currentTotalAmountMinor)}
          </p>
        </section>

        {/* Période / Horaires selon le type d'intention */}
        <fieldset
          style={{
            border: '1px solid #e5e7eb',
            borderRadius: '0.375rem',
            padding: '1rem',
            margin: 0,
          }}
        >
          <legend style={{ fontWeight: 600, padding: '0 0.5rem' }}>
            {intentKind === 'TIME_RANGE' ? 'Horaires de location' : 'Période de location'}
          </legend>

          {intentKind === 'TIME_RANGE' ? (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '1rem',
                marginTop: '0.5rem',
              }}
            >
              <div>
                <label
                  htmlFor="amend-start-at"
                  style={{
                    display: 'block',
                    fontSize: '0.875rem',
                    fontWeight: 500,
                    marginBottom: '0.25rem',
                  }}
                >
                  Début (date et heure)
                </label>
                <input
                  id="amend-start-at"
                  type="datetime-local"
                  value={startAt}
                  onChange={(e) => {
                    setStartAt(e.target.value);
                    invalidateWorkflow();
                  }}
                  disabled={isBusy}
                  required
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    border: '1px solid #d1d5db',
                    borderRadius: '0.375rem',
                    fontSize: '0.875rem',
                  }}
                />
              </div>

              <div>
                <label
                  htmlFor="amend-end-at"
                  style={{
                    display: 'block',
                    fontSize: '0.875rem',
                    fontWeight: 500,
                    marginBottom: '0.25rem',
                  }}
                >
                  Fin (date et heure)
                </label>
                <input
                  id="amend-end-at"
                  type="datetime-local"
                  value={endAt}
                  onChange={(e) => {
                    setEndAt(e.target.value);
                    invalidateWorkflow();
                  }}
                  disabled={isBusy}
                  required
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    border: '1px solid #d1d5db',
                    borderRadius: '0.375rem',
                    fontSize: '0.875rem',
                  }}
                />
              </div>
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '1rem',
                marginTop: '0.5rem',
              }}
            >
              <div>
                <label
                  htmlFor="amend-start-date"
                  style={{
                    display: 'block',
                    fontSize: '0.875rem',
                    fontWeight: 500,
                    marginBottom: '0.25rem',
                  }}
                >
                  Date de début
                </label>
                <input
                  id="amend-start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => {
                    setStartDate(e.target.value);
                    invalidateWorkflow();
                  }}
                  disabled={isBusy}
                  required
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    border: '1px solid #d1d5db',
                    borderRadius: '0.375rem',
                    fontSize: '0.875rem',
                  }}
                />
              </div>

              <div>
                <label
                  htmlFor="amend-end-date"
                  style={{
                    display: 'block',
                    fontSize: '0.875rem',
                    fontWeight: 500,
                    marginBottom: '0.25rem',
                  }}
                >
                  Date de restitution
                </label>
                <input
                  id="amend-end-date"
                  type="date"
                  value={endDateExclusive}
                  onChange={(e) => {
                    setEndDateExclusive(e.target.value);
                    invalidateWorkflow();
                  }}
                  disabled={isBusy}
                  required
                  aria-describedby="amend-end-date-helper"
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    border: '1px solid #d1d5db',
                    borderRadius: '0.375rem',
                    fontSize: '0.875rem',
                  }}
                />
                <p
                  id="amend-end-date-helper"
                  style={{ margin: '0.25rem 0 0 0', fontSize: '0.75rem', color: '#6b7280' }}
                >
                  Indiquez le jour de retour du matériel (borne exclusive pour le calcul
                  journalier).
                </p>
              </div>
            </div>
          )}
        </fieldset>

        {/* Quantités par article */}
        <fieldset
          style={{
            border: '1px solid #e5e7eb',
            borderRadius: '0.375rem',
            padding: '1rem',
            margin: 0,
          }}
        >
          <legend style={{ fontWeight: 600, padding: '0 0.5rem' }}>Articles réservés</legend>
          <div
            style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '0.5rem' }}
          >
            {lines.map((line) => (
              <div
                key={line.logicalLineId}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '0.75rem',
                  padding: '0.75rem',
                  backgroundColor: '#f9fafb',
                  borderRadius: '0.375rem',
                }}
              >
                <div>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: '0.925rem' }}>
                    {line.productName} — {line.variantName}
                  </p>
                  <p style={{ margin: '0.25rem 0 0 0', color: '#6b7280', fontSize: '0.8125rem' }}>
                    Quantité actuelle : {line.currentQuantity} (
                    {formatEuros(line.lineTotalAmountMinor)})
                  </p>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <label
                    htmlFor={`qty-${line.logicalLineId}`}
                    style={{ fontSize: '0.875rem', fontWeight: 500 }}
                  >
                    Nouvelle quantité :
                  </label>
                  <input
                    id={`qty-${line.logicalLineId}`}
                    type="number"
                    min="0"
                    step="1"
                    value={quantities[line.logicalLineId] ?? line.currentQuantity}
                    onChange={(e) => handleQuantityChange(line.logicalLineId, e.target.value)}
                    disabled={isBusy}
                    style={{
                      width: '70px',
                      padding: '0.4rem',
                      border: '1px solid #d1d5db',
                      borderRadius: '0.375rem',
                      textAlign: 'center',
                      fontSize: '0.875rem',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <p style={{ margin: '0.75rem 0 0 0', color: '#6b7280', fontSize: '0.8125rem' }}>
            Indication : positionner la quantité d'un article à 0 le retire de la réservation.
          </p>
        </fieldset>

        {previewError && (
          <div
            ref={previewErrorRef}
            tabIndex={-1}
            role="alert"
            style={{
              padding: '0.75rem 1rem',
              backgroundColor: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: '0.375rem',
              color: '#b91c1c',
              fontSize: '0.875rem',
              outline: 'none',
            }}
          >
            {previewError}
          </div>
        )}

        <div>
          <button
            type="submit"
            disabled={isBusy}
            style={{
              padding: '0.625rem 1.25rem',
              backgroundColor: isBusy ? '#93c5fd' : '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '0.375rem',
              fontWeight: 500,
              fontSize: '0.875rem',
              cursor: isBusy ? 'not-allowed' : 'pointer',
            }}
          >
            {isPreviewPending ? 'Vérification en cours...' : 'Vérifier les changements'}
          </button>
        </div>
      </form>

      {/* Résultat de prévisualisation & Action principale de confirmation */}
      {preview && (
        <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <AmendmentPreviewResult preview={preview} headingRef={resultHeadingRef} />

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
              padding: '1.5rem',
              backgroundColor: '#ffffff',
              border: '1px solid #e5e7eb',
              borderRadius: '0.5rem',
            }}
          >
            <h3 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>
              Confirmer la modification
            </h3>
            <p style={{ margin: 0, color: '#4b5563', fontSize: '0.875rem' }}>
              En confirmant, les changements vérifiés ci-dessus seront appliqués autoritairement à
              la réservation.
            </p>

            {confirmError && (
              <div
                ref={confirmErrorRef}
                tabIndex={-1}
                role="alert"
                style={{
                  padding: '0.75rem 1rem',
                  backgroundColor: '#fef2f2',
                  border: '1px solid #fecaca',
                  borderRadius: '0.375rem',
                  color: '#b91c1c',
                  fontSize: '0.875rem',
                  outline: 'none',
                }}
              >
                {confirmError}
              </div>
            )}

            <div>
              <button
                type="button"
                onClick={handleConfirmSubmit}
                disabled={isBusy}
                data-testid="confirm-amendment-button"
                style={{
                  padding: '0.75rem 1.5rem',
                  backgroundColor: isBusy ? '#93c5fd' : '#059669',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '0.375rem',
                  fontWeight: 600,
                  fontSize: '0.925rem',
                  cursor: isBusy ? 'not-allowed' : 'pointer',
                }}
              >
                {isConfirmPending ? 'Confirmation en cours...' : 'Confirmer la modification'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
