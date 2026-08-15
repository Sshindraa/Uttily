'use client';

import React, { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { PublicOfferDetails } from '@uttily/core';
import { createBookingDraftAction } from '@/app/actions/bookings';
import styles from './offer.module.css';

export interface OfferBookingFormProps {
  offer: PublicOfferDetails;
  locale: 'fr' | 'en';
  initialIntent?: 'DAY_RANGE' | 'TIME_RANGE';
  initialStartDate?: string;
  initialEndDateExclusive?: string;
  initialStartAt?: string;
  initialEndAt?: string;
  initialVariantId?: string;
  isAuthenticated: boolean;
}

export function OfferBookingForm({
  offer,
  locale,
  initialIntent = 'DAY_RANGE',
  initialStartDate = '',
  initialEndDateExclusive = '',
  initialStartAt = '',
  initialEndAt = '',
  initialVariantId,
  isAuthenticated,
}: OfferBookingFormProps): React.ReactElement {
  const router = useRouter();
  const fr = locale === 'fr';

  const defaultVariantId =
    initialVariantId && offer.variants.some((v) => v.id === initialVariantId)
      ? initialVariantId
      : (offer.variants[0]?.id ?? '');

  const [selectedVariantId, setSelectedVariantId] = useState(defaultVariantId);
  const [intentKind, setIntentKind] = useState<'DAY_RANGE' | 'TIME_RANGE'>(initialIntent);
  const [startDate, setStartDate] = useState(initialStartDate);
  const [endDateExclusive, setEndDateExclusive] = useState(initialEndDateExclusive);
  const [startAt, setStartAt] = useState(initialStartAt);
  const [endAt, setEndAt] = useState(initialEndAt);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleBooking = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    setErrorMessage(null);

    // Si non connecté, rediriger vers sign-in avec URL de retour préservant les choix
    if (!isAuthenticated) {
      const searchParams = new URLSearchParams();
      searchParams.set('intent', intentKind);
      if (intentKind === 'DAY_RANGE') {
        if (startDate) searchParams.set('startDate', startDate);
        if (endDateExclusive) searchParams.set('endDateExclusive', endDateExclusive);
      } else {
        if (startAt) searchParams.set('startAt', startAt);
        if (endAt) searchParams.set('endAt', endAt);
      }
      if (selectedVariantId) searchParams.set('variantId', selectedVariantId);

      const currentPath = `/${locale}/offers/${offer.publicProductId}/${offer.publicLocationId}?${searchParams.toString()}`;
      const signInUrl = `/sign-in?redirect_url=${encodeURIComponent(currentPath)}`;
      router.push(signInUrl);
      return;
    }

    // Validation locale préliminaire des dates
    if (intentKind === 'DAY_RANGE') {
      if (!startDate || !endDateExclusive) {
        setErrorMessage(
          fr
            ? 'Veuillez sélectionner les dates de début et de fin.'
            : 'Please select start and end dates.',
        );
        return;
      }
      if (endDateExclusive <= startDate) {
        setErrorMessage(
          fr
            ? 'La date de fin doit être postérieure à la date de début.'
            : 'End date must be after start date.',
        );
        return;
      }
    } else {
      if (!startAt || !endAt) {
        setErrorMessage(
          fr
            ? 'Veuillez sélectionner les heures de début et de fin.'
            : 'Please select start and end times.',
        );
        return;
      }
      if (endAt <= startAt) {
        setErrorMessage(
          fr
            ? 'L’heure de fin doit être postérieure à l’heure de début.'
            : 'End time must be after start time.',
        );
        return;
      }
    }

    if (!selectedVariantId) {
      setErrorMessage(
        fr ? 'Veuillez sélectionner une option.' : 'Please select an equipment variant.',
      );
      return;
    }

    startTransition(async () => {
      const idempotencyKey = crypto.randomUUID();
      const res = await createBookingDraftAction({
        publicProductId: offer.publicProductId,
        publicLocationId: offer.publicLocationId,
        variantId: selectedVariantId,
        quantity: 1,
        intent:
          intentKind === 'DAY_RANGE'
            ? { kind: 'DAY_RANGE', startDate, endDateExclusive }
            : { kind: 'TIME_RANGE', startAt, endAt },
        locale,
        idempotencyKey,
      });

      if (res.ok) {
        router.push(res.data.redirectUrl);
      } else {
        setErrorMessage(res.message);
      }
    });
  };

  return (
    <form className={styles.bookingCard} onSubmit={handleBooking} noValidate>
      <h2 className={styles.bookingCardTitle}>{fr ? 'Configurer la réservation' : 'Book this item'}</h2>

      {errorMessage ? (
        <div role="alert" className={styles.alert}>
          {errorMessage}
        </div>
      ) : null}

      {offer.variants.length > 1 ? (
        <fieldset className={styles.formGroup}>
          <legend className={styles.label}>{fr ? 'Variante d’équipement' : 'Equipment option'}</legend>
          <div className={styles.variantGroup}>
            {offer.variants.map((variant) => {
              const isSelected = variant.id === selectedVariantId;
              return (
                <label
                  key={variant.id}
                  className={`${styles.variantOption} ${isSelected ? styles.variantOptionSelected : ''}`}
                >
                  <div>
                    <input
                      type="radio"
                      name="variantId"
                      value={variant.id}
                      checked={isSelected}
                      onChange={() => setSelectedVariantId(variant.id)}
                      className={styles.radioInput}
                    />
                    <span>{variant.name}</span>
                  </div>
                  {variant.dailyPriceAmountMinor !== null ? (
                    <span>
                      {(variant.dailyPriceAmountMinor / 100).toFixed(2)} {variant.currency}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : (
        <div className={styles.formGroup}>
          <span className={styles.label}>{fr ? 'Équipement' : 'Equipment'}</span>
          <p style={{ margin: 0, color: 'var(--ink)', fontWeight: 600 }}>
            {offer.variants[0]?.name || offer.productName}
          </p>
        </div>
      )}

      <div className={styles.formGroup}>
        <span className={styles.label}>{fr ? 'Type de durée' : 'Duration type'}</span>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            type="button"
            className={styles.input}
            style={{
              cursor: 'pointer',
              background: intentKind === 'DAY_RANGE' ? 'var(--accent)' : 'var(--paper)',
              color: intentKind === 'DAY_RANGE' ? '#fff' : 'var(--ink)',
              fontWeight: 600,
            }}
            onClick={() => setIntentKind('DAY_RANGE')}
          >
            {fr ? 'Par jour' : 'Daily'}
          </button>
          <button
            type="button"
            className={styles.input}
            style={{
              cursor: 'pointer',
              background: intentKind === 'TIME_RANGE' ? 'var(--accent)' : 'var(--paper)',
              color: intentKind === 'TIME_RANGE' ? '#fff' : 'var(--ink)',
              fontWeight: 600,
            }}
            onClick={() => setIntentKind('TIME_RANGE')}
          >
            {fr ? 'Par heure' : 'Hourly'}
          </button>
        </div>
      </div>

      {intentKind === 'DAY_RANGE' ? (
        <div className={styles.formGroup}>
          <div className={styles.inputRow}>
            <div>
              <label htmlFor="booking-start-date" className={styles.label}>
                {fr ? 'Du (inclus)' : 'Start date'}
              </label>
              <input
                id="booking-start-date"
                type="date"
                className={styles.input}
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="booking-end-date" className={styles.label}>
                {fr ? 'Au (exclus)' : 'End date'}
              </label>
              <input
                id="booking-end-date"
                type="date"
                className={styles.input}
                value={endDateExclusive}
                onChange={(e) => setEndDateExclusive(e.target.value)}
                required
              />
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.formGroup}>
          <div className={styles.inputRow}>
            <div>
              <label htmlFor="booking-start-time" className={styles.label}>
                {fr ? 'Début' : 'Start time'}
              </label>
              <input
                id="booking-start-time"
                type="datetime-local"
                className={styles.input}
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="booking-end-time" className={styles.label}>
                {fr ? 'Fin' : 'End time'}
              </label>
              <input
                id="booking-end-time"
                type="datetime-local"
                className={styles.input}
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
                required
              />
            </div>
          </div>
        </div>
      )}

      <button
        type="submit"
        className={styles.submitButton}
        disabled={isPending}
      >
        {isPending
          ? fr
            ? 'Réservation en cours...'
            : 'Booking...'
          : fr
            ? 'Réserver'
            : 'Book now'}
      </button>

      <p className={styles.guaranteeNote}>
        {fr
          ? 'Le créneau et l’équipement physique sont bloqués instantanément par un hold temporaire de 10 minutes lors de la confirmation.'
          : 'The time slot and equipment are reserved immediately with a 10-minute temporary hold upon confirmation.'}
      </p>
    </form>
  );
}
