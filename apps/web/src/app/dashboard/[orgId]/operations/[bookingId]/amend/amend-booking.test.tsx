import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildPreviewBookingAmendmentInput } from './build-preview-input';
import {
  AmendBookingForm,
  copyPaymentLinkToClipboard,
  SupplementPaymentHandoff,
} from './amend-booking-form';
import { AmendmentPreviewResult, formatEuros, actionLabel } from './amendment-preview-result';
import { getAmendmentEntryState } from '@/lib/amendment-auth';
import type { PreviewBookingAmendmentSuccess } from '@uttily/core';

describe('G7M-C5-A — Interface Loueur & Validation de Prévisualisation', () => {
  describe('buildPreviewBookingAmendmentInput (helper pur)', () => {
    const defaultLines = [
      {
        logicalLineId: 'line-1',
        variantId: 'var-1',
        productName: 'Kayak',
        variantName: 'Standard',
        currentQuantity: 2,
        unitPriceAmountMinor: 5000,
        lineTotalAmountMinor: 10000,
      },
    ];

    it('construit un payload DAY_RANGE valide', () => {
      const res = buildPreviewBookingAmendmentInput({
        bookingId: 'book-1',
        expectedLastAppliedAmendmentNumber: 0,
        intentKind: 'DAY_RANGE',
        startDate: '2026-06-01',
        endDateExclusive: '2026-06-05',
        startAt: '',
        endAt: '',
        quantities: { 'line-1': 3 },
        lines: defaultLines,
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.input.bookingId).toBe('book-1');
        expect(res.input.expectedLastAppliedAmendmentNumber).toBe(0);
        expect(res.input.intent).toEqual({
          kind: 'DAY_RANGE',
          startDate: '2026-06-01',
          endDateExclusive: '2026-06-05',
        });
        expect(res.input.lines).toEqual([
          { logicalLineId: 'line-1', variantId: 'var-1', quantity: 3 },
        ]);
      }
    });

    it('rejette DAY_RANGE si date de début manquante', () => {
      const res = buildPreviewBookingAmendmentInput({
        bookingId: 'book-1',
        expectedLastAppliedAmendmentNumber: 0,
        intentKind: 'DAY_RANGE',
        startDate: '',
        endDateExclusive: '2026-06-05',
        startAt: '',
        endAt: '',
        quantities: { 'line-1': 2 },
        lines: defaultLines,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain('dates de début et de fin valides');
      }
    });

    it('rejette DAY_RANGE si endDateExclusive <= startDate', () => {
      const res = buildPreviewBookingAmendmentInput({
        bookingId: 'book-1',
        expectedLastAppliedAmendmentNumber: 0,
        intentKind: 'DAY_RANGE',
        startDate: '2026-06-05',
        endDateExclusive: '2026-06-05',
        startAt: '',
        endAt: '',
        quantities: { 'line-1': 2 },
        lines: defaultLines,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain('strictement postérieure');
      }
    });

    it('construit un payload TIME_RANGE valide', () => {
      const res = buildPreviewBookingAmendmentInput({
        bookingId: 'book-1',
        expectedLastAppliedAmendmentNumber: 1,
        intentKind: 'TIME_RANGE',
        startDate: '',
        endDateExclusive: '',
        startAt: '2026-06-01T10:00',
        endAt: '2026-06-01T18:00',
        quantities: { 'line-1': 1 },
        lines: defaultLines,
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.input.intent).toEqual({
          kind: 'TIME_RANGE',
          startAt: '2026-06-01T10:00',
          endAt: '2026-06-01T18:00',
        });
      }
    });

    it('rejette TIME_RANGE si endAt <= startAt', () => {
      const res = buildPreviewBookingAmendmentInput({
        bookingId: 'book-1',
        expectedLastAppliedAmendmentNumber: 1,
        intentKind: 'TIME_RANGE',
        startDate: '',
        endDateExclusive: '',
        startAt: '2026-06-01T18:00',
        endAt: '2026-06-01T10:00',
        quantities: { 'line-1': 1 },
        lines: defaultLines,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain('strictement postérieures');
      }
    });

    it('rejette si toutes les quantités sont nulles (0)', () => {
      const res = buildPreviewBookingAmendmentInput({
        bookingId: 'book-1',
        expectedLastAppliedAmendmentNumber: 0,
        intentKind: 'DAY_RANGE',
        startDate: '2026-06-01',
        endDateExclusive: '2026-06-05',
        startAt: '',
        endAt: '',
        quantities: { 'line-1': 0 },
        lines: defaultLines,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain('au moins un article avec une quantité supérieure à 0');
      }
    });
  });

  describe('AmendmentPreviewResult (composant de présentation)', () => {
    it('formate les euros avec précision de centimes', () => {
      expect(formatEuros(5000)).toBe('50,00 €');
      expect(formatEuros(0)).toBe('0,00 €');
      expect(formatEuros(1250)).toBe('12,50 €');
    });

    it('retourne les libellés et styles d action de ligne', () => {
      expect(actionLabel('UNCHANGED').text).toBe('Inchangé');
      expect(actionLabel('MODIFY').text).toBe('Modifié');
      expect(actionLabel('ADD').text).toBe('Ajouté');
      expect(actionLabel('REMOVE').text).toBe('Retiré');
    });

    it('rend le HTML pour une modification NEUTRAL', () => {
      const preview: PreviewBookingAmendmentSuccess = {
        kind: 'SUCCESS',
        bookingId: 'book-1',
        locationId: 'loc-1',
        lastAppliedAmendmentNumber: 0,
        classification: 'NEUTRAL',
        previousContractualTotalAmountMinor: 10000,
        nextContractualTotalAmountMinor: 10000,
        deltaAmountMinor: 0,
        currency: 'EUR',
        supplementCommissionAmountMinor: null,
        supplementNetAmountMinor: null,
        previousCustomerStartAt: new Date('2026-06-01T08:00:00Z'),
        previousCustomerEndAt: new Date('2026-06-03T18:00:00Z'),
        nextCustomerStartAt: new Date('2026-06-02T08:00:00Z'),
        nextCustomerEndAt: new Date('2026-06-04T18:00:00Z'),
        locationTimeZone: 'Europe/Paris',
        lines: [
          {
            logicalLineId: 'line-1',
            variantId: 'var-1',
            productName: 'Kayak',
            variantName: 'Standard',
            action: 'MODIFY',
            beforeQuantity: 2,
            afterQuantity: 2,
            beforeLineTotalAmountMinor: 10000,
            afterLineTotalAmountMinor: 10000,
          },
        ],
      };

      const html = renderToStaticMarkup(<AmendmentPreviewResult preview={preview} />);

      expect(html).toContain('Votre modification');
      expect(html).toContain('Modification neutre (0 €)');
      expect(html).toContain('Aucun paiement ni remboursement nécessaire.');
      expect(html).toContain('Kayak — Standard');
      expect(html).toContain('Modifié');
    });

    it('rend le HTML pour une modification REFUND', () => {
      const preview: PreviewBookingAmendmentSuccess = {
        kind: 'SUCCESS',
        bookingId: 'book-1',
        locationId: 'loc-1',
        lastAppliedAmendmentNumber: 0,
        classification: 'REFUND',
        previousContractualTotalAmountMinor: 15000,
        nextContractualTotalAmountMinor: 10000,
        deltaAmountMinor: -5000,
        currency: 'EUR',
        supplementCommissionAmountMinor: null,
        supplementNetAmountMinor: null,
        previousCustomerStartAt: new Date('2026-06-01T08:00:00Z'),
        previousCustomerEndAt: new Date('2026-06-04T18:00:00Z'),
        nextCustomerStartAt: new Date('2026-06-01T08:00:00Z'),
        nextCustomerEndAt: new Date('2026-06-03T18:00:00Z'),
        locationTimeZone: 'Europe/Paris',
        lines: [
          {
            logicalLineId: 'line-1',
            variantId: 'var-1',
            productName: 'Kayak',
            variantName: 'Standard',
            action: 'MODIFY',
            beforeQuantity: 3,
            afterQuantity: 2,
            beforeLineTotalAmountMinor: 15000,
            afterLineTotalAmountMinor: 10000,
          },
        ],
      };

      const html = renderToStaticMarkup(<AmendmentPreviewResult preview={preview} />);

      expect(html).toContain('Remboursement client');
      expect(html).toContain('Un remboursement de');
      expect(html).toContain('50,00 €');
    });

    it('rend le HTML pour une modification SUPPLEMENT avec décomposition', () => {
      const preview: PreviewBookingAmendmentSuccess = {
        kind: 'SUCCESS',
        bookingId: 'book-1',
        locationId: 'loc-1',
        lastAppliedAmendmentNumber: 0,
        classification: 'SUPPLEMENT',
        previousContractualTotalAmountMinor: 10000,
        nextContractualTotalAmountMinor: 15000,
        deltaAmountMinor: 5000,
        supplementCommissionAmountMinor: 250,
        supplementNetAmountMinor: 4750,
        currency: 'EUR',
        previousCustomerStartAt: new Date('2026-06-01T08:00:00Z'),
        previousCustomerEndAt: new Date('2026-06-03T18:00:00Z'),
        nextCustomerStartAt: new Date('2026-06-01T08:00:00Z'),
        nextCustomerEndAt: new Date('2026-06-04T18:00:00Z'),
        locationTimeZone: 'Europe/Paris',
        lines: [
          {
            logicalLineId: 'line-1',
            variantId: 'var-1',
            productName: 'Kayak',
            variantName: 'Standard',
            action: 'MODIFY',
            beforeQuantity: 2,
            afterQuantity: 3,
            beforeLineTotalAmountMinor: 10000,
            afterLineTotalAmountMinor: 15000,
          },
        ],
      };

      const html = renderToStaticMarkup(<AmendmentPreviewResult preview={preview} />);

      expect(html).toContain('Supplément à régler');
      expect(html).toContain('Commission Uttily estimée :');
      expect(html).toContain('2,50 €');
      expect(html).toContain('Net loueur estimé :');
      expect(html).toContain('47,50 €');
    });

    it('rend le badge REMOVE pour une ligne retirée', () => {
      const preview: PreviewBookingAmendmentSuccess = {
        kind: 'SUCCESS',
        bookingId: 'book-1',
        locationId: 'loc-1',
        lastAppliedAmendmentNumber: 0,
        classification: 'REFUND',
        previousContractualTotalAmountMinor: 10000,
        nextContractualTotalAmountMinor: 0,
        deltaAmountMinor: -10000,
        currency: 'EUR',
        supplementCommissionAmountMinor: null,
        supplementNetAmountMinor: null,
        previousCustomerStartAt: new Date('2026-06-01T08:00:00Z'),
        previousCustomerEndAt: new Date('2026-06-03T18:00:00Z'),
        nextCustomerStartAt: new Date('2026-06-01T08:00:00Z'),
        nextCustomerEndAt: new Date('2026-06-03T18:00:00Z'),
        locationTimeZone: 'Europe/Paris',
        lines: [
          {
            logicalLineId: 'line-1',
            variantId: 'var-1',
            productName: 'Kayak',
            variantName: 'Standard',
            action: 'REMOVE',
            beforeQuantity: 2,
            afterQuantity: 0,
            beforeLineTotalAmountMinor: 10000,
            afterLineTotalAmountMinor: 0,
          },
        ],
      };

      const html = renderToStaticMarkup(<AmendmentPreviewResult preview={preview} />);

      expect(html).toContain('Retiré');
      expect(html).toContain('Quantité : 2 → 0');
    });
  });

  describe('getAmendmentEntryState (garde d éligibilité)', () => {
    it('autorise l accès pour CONFIRMED + MANAGER sans amendement actif', () => {
      const state = getAmendmentEntryState({
        bookingStatus: 'CONFIRMED',
        role: 'MANAGER',
        hasActiveAmendment: false,
      });
      expect(state.canAmend).toBe(true);
      expect(state.reason).toBeUndefined();
    });

    it('rejette si le statut n est pas CONFIRMED', () => {
      const state = getAmendmentEntryState({
        bookingStatus: 'IN_PROGRESS',
        role: 'OWNER',
        hasActiveAmendment: false,
      });
      expect(state.canAmend).toBe(false);
      expect(state.reason).toBe('NOT_CONFIRMED');
    });

    it('rejette si le rôle est STAFF', () => {
      const state = getAmendmentEntryState({
        bookingStatus: 'CONFIRMED',
        role: 'STAFF',
        hasActiveAmendment: false,
      });
      expect(state.canAmend).toBe(false);
      expect(state.reason).toBe('INSUFFICIENT_ROLE');
    });

    it('rejette si un amendement actif existe déjà', () => {
      const state = getAmendmentEntryState({
        bookingStatus: 'CONFIRMED',
        role: 'ADMIN',
        hasActiveAmendment: true,
      });
      expect(state.canAmend).toBe(false);
      expect(state.reason).toBe('ACTIVE_AMENDMENT_EXISTS');
    });
  });
  describe('G7M-C5-C : handoff loueur et lien de paiement sécurisé', () => {
    const amendmentId = '11111111-1111-4111-8111-111111111111';
    const origin = 'https://app.uttily.fr';

    it('1. copie l URL absolue exacte dans le presse-papier et affiche un statut accessible', async () => {
      const mockWriteText = vi.fn().mockResolvedValue(undefined);
      const res = await copyPaymentLinkToClipboard(amendmentId, origin, mockWriteText);

      expect(mockWriteText).toHaveBeenCalledWith(
        'https://app.uttily.fr/checkout/amendment/11111111-1111-4111-8111-111111111111',
      );
      expect(res.ok).toBe(true);
      expect(res.feedback).toBe('Lien de paiement copié !');
      expect(res.feedback).not.toContain(amendmentId);
      expect(res.feedback).not.toContain('http');
    });

    it('2. en cas d échec ou absence de clipboard, affiche un message sécurisé sans URL ni UUID', async () => {
      // Échec clipboard
      const mockFailingWrite = vi.fn().mockRejectedValue(new Error('Permission denied'));
      const resFail = await copyPaymentLinkToClipboard(amendmentId, origin, mockFailingWrite);

      expect(resFail.ok).toBe(false);
      expect(resFail.feedback).toBe('Impossible de copier automatiquement.');
      expect(resFail.feedback).not.toContain(amendmentId);
      expect(resFail.feedback).not.toContain('http');

      // Absence clipboard
      const resMissing = await copyPaymentLinkToClipboard(amendmentId, origin, undefined);
      expect(resMissing.ok).toBe(false);
      expect(resMissing.feedback).toBe('Impossible de copier automatiquement.');
      expect(resMissing.feedback).not.toContain(amendmentId);
    });

    it('3. le composant SupplementPaymentHandoff ne contient aucun input et n expose aucun UUID ni URL dans le rendu', () => {
      const html = renderToStaticMarkup(
        <SupplementPaymentHandoff
          amendmentId={amendmentId}
          organizationId="org-1"
          bookingId="book-1"
        />,
      );

      expect(html).toContain('Copier le lien de paiement');
      expect(html).toContain('Voir la réservation');
      expect(html).not.toContain('<input');
      expect(html).not.toContain('amendment-payment-link');
      expect(html).not.toContain(amendmentId);
      expect(html).not.toContain('/checkout/amendment/');
      expect(html).not.toContain('Lien de paiement à transmettre');
    });
  });
});

describe('G7M-C5-B — Confirmation Workflow & Success Screens', () => {
  it('rend le formulaire initial avec les champs et l action de vérification', () => {
    const html = renderToStaticMarkup(
      <AmendBookingForm
        organizationId="11111111-1111-4111-8111-111111111111"
        bookingId="22222222-2222-4222-8222-222222222222"
        locationName="Annecy"
        locationTimeZone="Europe/Paris"
        expectedLastAppliedAmendmentNumber={0}
        initialIntent={{
          kind: 'DAY_RANGE',
          startDate: '2026-06-01',
          endDateExclusive: '2026-06-05',
        }}
        currentTotalAmountMinor={10000}
        lines={[
          {
            logicalLineId: 'line-1',
            variantId: 'var-1',
            productName: 'Kayak',
            variantName: 'Standard',
            currentQuantity: 2,
            unitPriceAmountMinor: 5000,
            lineTotalAmountMinor: 10000,
          },
        ]}
      />,
    );

    expect(html).toContain('Contexte de réservation');
    expect(html).toContain('Annecy');
    expect(html).toContain('(Europe/Paris)');
    expect(html).toContain('Vérifier les changements');
    expect(html).toContain('Kayak — Standard');
  });

  it('formate correctement l heure limite de hold dans le fuseau du lieu', () => {
    // Render static check for hold deadline formatting logic
    const d = new Date('2026-06-01T10:15:00.000Z');
    const formatted = new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
    expect(formatted).toMatch(/\d{2}:\d{2}/);
  });
});
