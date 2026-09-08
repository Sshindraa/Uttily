'use client';

import { useState, useTransition, useEffect } from 'react';
import type { RankedPackCandidate, SolvedPackCandidate } from '@uttily/core';
import { createPackBookingDraftAction } from '@/app/actions/pack-booking';
import styles from './pack-confirmation-drawer.module.css';

export interface PackConfirmationDrawerProps {
  readonly pack: RankedPackCandidate<SolvedPackCandidate> | null;
  readonly locale: 'fr' | 'en';
  readonly datesSummary?: string | undefined;
  readonly startAtIso: string;
  readonly endAtIso: string;
  readonly onClose: () => void;
}

function formatEuros(cents: number): string {
  const euros = (cents / 100).toFixed(2).replace('.', ',');
  return `${euros} €`;
}

export function PackConfirmationDrawer({
  pack,
  locale,
  datesSummary,
  startAtIso,
  endAtIso,
  onClose,
}: PackConfirmationDrawerProps): React.ReactElement | null {
  const fr = locale === 'fr';
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!pack) return null;

  const candidate = pack.candidate;

  // Grouper les équipements
  const groupedItems = new Map<string, { count: number; productName: string }>();

  for (const item of candidate.items) {
    const key = item.productId || item.productName;
    const existing = groupedItems.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      groupedItems.set(key, {
        count: 1,
        productName: item.productName,
      });
    }
  }

  const itemsList = Array.from(groupedItems.values());

  function handleConfirm(): void {
    if (!pack) return;
    setError(null);

    startTransition(async () => {
      try {
        const res = await createPackBookingDraftAction({
          organizationId: candidate.organizationId,
          locationId: candidate.locationId,
          inventoryItemIds: candidate.items.map((i) => i.inventoryItemId),
          startAtIso,
          endAtIso,
          totalPriceCents: candidate.totalPriceCents,
          isRepaired: candidate.repairs.length > 0,
          locale,
        });

        if (!res.ok) {
          if (res.code === 'UNAUTHENTICATED') {
            window.location.href = `/sign-in?redirect_url=${encodeURIComponent(window.location.href)}`;
            return;
          }
          setError(res.message);
          return;
        }

        // Redirection fluide vers le checkout officiel Uttily
        window.location.href = res.data.redirectUrl;
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : fr
              ? 'Une erreur inattendue est survenue.'
              : 'An unexpected error occurred.',
        );
      }
    });
  }

  return (
    <div className={styles.overlay} onClick={onClose} role="dialog" aria-modal="true">
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div>
            <span className={styles.eyebrow}>
              {fr ? 'Solution sélectionnée' : 'Selected solution'}
            </span>
            <h2 className={styles.title}>{candidate.organizationName}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={styles.closeBtn}
            aria-label={fr ? 'Fermer' : 'Close'}
          >
            ✕
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.section}>
            <h4 className={styles.sectionTitle}>{fr ? 'Équipements du pack' : 'Pack equipment'}</h4>
            <ul className={styles.itemsList}>
              {itemsList.map((item, idx) => (
                <li key={idx} className={styles.itemRow}>
                  <span className={styles.itemBullet}>•</span>
                  <span className={styles.itemCount}>{item.count} ×</span>
                  <span className={styles.itemName}>{item.productName}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className={styles.section}>
            <h4 className={styles.sectionTitle}>
              {fr ? 'Créneau et retrait' : 'Schedule & Pickup'}
            </h4>
            <div className={styles.metaRow}>
              <span>📅</span>
              <span>{datesSummary || (fr ? 'Date sélectionnée' : 'Selected date')}</span>
            </div>
            <div className={styles.metaRow}>
              <span>📍</span>
              <span>
                {candidate.locationAddress ||
                  (fr ? 'Au comptoir du loueur' : 'At the shop counter')}
              </span>
            </div>
          </div>

          <div className={styles.guaranteeBox}>
            <div className={styles.guaranteeLine}>
              <span className={styles.greenCheck}>✓</span>
              <span>
                {fr
                  ? 'Tous les équipements seront bloqués ensemble lors de votre réservation'
                  : 'All equipment will be held together upon booking'}
              </span>
            </div>
            <div className={styles.guaranteeLine}>
              <span className={styles.greenCheck}>✓</span>
              <span>
                {fr
                  ? 'Caution selon les conditions du loueur (empreinte bancaire ou chèque au comptoir)'
                  : 'Deposit per shop policy (card pre-authorization or cheque at counter)'}
              </span>
            </div>
          </div>

          {error && <div className={styles.errorAlert}>{error}</div>}
        </div>

        <div className={styles.footer}>
          <div className={styles.priceRow}>
            <span className={styles.priceLabel}>
              {fr ? 'Total de votre solution :' : 'Total price:'}
            </span>
            <span className={styles.priceVal}>{formatEuros(candidate.totalPriceCents)}</span>
          </div>

          <button
            type="button"
            onClick={handleConfirm}
            disabled={isPending}
            className={styles.confirmBtn}
          >
            {isPending ? (
              <span>{fr ? 'Verrouillage du pack…' : 'Reserving pack…'}</span>
            ) : (
              <span>{fr ? 'Continuer vers la réservation →' : 'Continue to booking →'}</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
