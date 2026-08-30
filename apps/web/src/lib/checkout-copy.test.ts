import { describe, expect, it } from 'vitest';
import { getCheckoutCopy } from './checkout-copy';

describe('checkout copy', () => {
  it('keeps French as the default checkout language', () => {
    const copy = getCheckoutCopy('fr');

    expect(copy.success.title).toBe('Paiement confirmé !');
    expect(copy.summary.total).toBe('Total à régler');
  });

  it('provides English labels for the locale carried by the checkout URL', () => {
    const copy = getCheckoutCopy('en');

    expect(copy.success.title).toBe('Payment confirmed!');
    expect(copy.summary.total).toBe('Total to pay');
    expect(copy.paymentForm.pay).toBe('Pay');
  });
});
