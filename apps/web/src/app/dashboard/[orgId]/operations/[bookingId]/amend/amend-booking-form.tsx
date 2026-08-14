'use client';

import React, { useState, useRef, useTransition } from 'react';
import { previewBookingAmendmentAction } from '@/app/actions/booking-amendments';
import type { PreviewBookingAmendmentSuccess, NeutralAmendmentIntent } from '@uttily/core';
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

  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewBookingAmendmentSuccess | null>(null);

  const errorRef = useRef<HTMLDivElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);

  const handleQuantityChange = (logicalLineId: string, value: string) => {
    const parsed = parseInt(value, 10);
    const qty = Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
    setQuantities((prev) => ({ ...prev, [logicalLineId]: qty }));
    setError(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

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
      setError(buildResult.error);
      setTimeout(() => errorRef.current?.focus(), 0);
      return;
    }

    startTransition(async () => {
      const result = await previewBookingAmendmentAction(organizationId, buildResult.input);
      if (!result.ok) {
        setError(result.message);
        setPreview(null);
        setTimeout(() => errorRef.current?.focus(), 0);
      } else {
        setPreview(result.data);
        setTimeout(() => resultHeadingRef.current?.focus(), 0);
      }
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <form
        onSubmit={handleSubmit}
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
                    setError(null);
                  }}
                  disabled={isPending}
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
                    setError(null);
                  }}
                  disabled={isPending}
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
                    setError(null);
                  }}
                  disabled={isPending}
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
                    setError(null);
                  }}
                  disabled={isPending}
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
                    disabled={isPending}
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

        {error && (
          <div
            ref={errorRef}
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
            {error}
          </div>
        )}

        <div>
          <button
            type="submit"
            disabled={isPending}
            style={{
              padding: '0.625rem 1.25rem',
              backgroundColor: isPending ? '#93c5fd' : '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '0.375rem',
              fontWeight: 500,
              fontSize: '0.875rem',
              cursor: isPending ? 'not-allowed' : 'pointer',
            }}
          >
            {isPending ? 'Vérification en cours...' : 'Vérifier les changements'}
          </button>
        </div>
      </form>

      {/* Résultat de prévisualisation */}
      {preview && <AmendmentPreviewResult preview={preview} headingRef={resultHeadingRef} />}
    </div>
  );
}
