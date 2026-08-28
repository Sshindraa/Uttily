import { describe, expect, it, vi } from 'vitest';

const redirectMock = vi.hoisted(() =>
  vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import LegacyAmendBookingPage from './page';

describe('Route legacy operations/[bookingId]/amend', () => {
  it('redirige vers la route canonique bookings/[bookingId]/amend', async () => {
    await expect(
      LegacyAmendBookingPage({
        params: Promise.resolve({ orgId: 'org-1', bookingId: 'booking-1' }),
      }),
    ).rejects.toThrow('NEXT_REDIRECT:/dashboard/org-1/bookings/booking-1/amend');
  });
});
