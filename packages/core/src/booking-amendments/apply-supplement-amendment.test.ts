import { describe, expect, it } from 'vitest';
import { projectSupplementPaymentStatus } from './apply-supplement-amendment';

describe('projectSupplementPaymentStatus', () => {
  it('projette requires_action depuis PENDING_PROVIDER', () => {
    expect(
      projectSupplementPaymentStatus('payment_intent.requires_action', 'PENDING_PROVIDER'),
    ).toEqual({ newStatus: 'REQUIRES_ACTION', ignored: false });
  });

  it('conserve requires_action sur un doublon', () => {
    expect(
      projectSupplementPaymentStatus('payment_intent.requires_action', 'REQUIRES_ACTION'),
    ).toEqual({ newStatus: null, ignored: true });
  });

  it('ignore requires_action livré après processing', () => {
    expect(projectSupplementPaymentStatus('payment_intent.requires_action', 'PROCESSING')).toEqual({
      newStatus: null,
      ignored: true,
    });
  });

  it('projette processing depuis requires_action', () => {
    expect(projectSupplementPaymentStatus('payment_intent.processing', 'REQUIRES_ACTION')).toEqual({
      newStatus: 'PROCESSING',
      ignored: false,
    });
  });

  it('ignore un processing déjà projeté', () => {
    expect(projectSupplementPaymentStatus('payment_intent.processing', 'PROCESSING')).toEqual({
      newStatus: null,
      ignored: true,
    });
  });

  it('projette payment_failed vers FAILED sans libérer le hold', () => {
    expect(projectSupplementPaymentStatus('payment_intent.payment_failed', 'PROCESSING')).toEqual({
      newStatus: 'FAILED',
      ignored: false,
    });
  });

  it('ignore payment_failed après un terminal local', () => {
    expect(projectSupplementPaymentStatus('payment_intent.payment_failed', 'SUCCEEDED')).toEqual({
      newStatus: null,
      ignored: true,
    });
  });

  it('projette canceled vers CANCELLED depuis processing', () => {
    expect(projectSupplementPaymentStatus('payment_intent.canceled', 'PROCESSING')).toEqual({
      newStatus: 'CANCELLED',
      ignored: false,
    });
  });

  it('ne régresse jamais un paiement terminal', () => {
    for (const status of ['SUCCEEDED', 'FAILED', 'CANCELLED']) {
      expect(projectSupplementPaymentStatus('payment_intent.processing', status)).toEqual({
        newStatus: null,
        ignored: true,
      });
    }
  });

  it('ignore un événement inconnu', () => {
    expect(projectSupplementPaymentStatus('charge.refunded', 'PROCESSING')).toEqual({
      newStatus: null,
      ignored: true,
    });
  });
});
