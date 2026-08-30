import { describe, expect, it } from 'vitest';
import { getAccountCopy } from './account-copy';

describe('account copy', () => {
  it('keeps the French copy as the default', () => {
    const copy = getAccountCopy('fr');

    expect(copy.bookings.title).toBe('Mes locations');
    expect(copy.statusLabels.CONFIRMED).toBe('Confirmée');
    expect(copy.detail.statusBanner.unavailableTitle).toBe('Statut indisponible');
  });

  it('provides a complete English surface for the localized account routes', () => {
    const copy = getAccountCopy('en');

    expect(copy.bookings.title).toBe('My bookings');
    expect(copy.statusLabels.READY_FOR_PICKUP).toBe('Ready for pickup');
    expect(copy.detail.statusBanner.unavailableDescription).toContain('current status');
    expect(copy.cancellation.confirm).toBe('Confirm cancellation');
  });
});
