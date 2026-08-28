import { describe, expect, it, vi } from 'vitest';
import {
  getBookingSupportDetails,
  SupportBookingNotFoundError,
} from './booking-support';

describe('getBookingSupportDetails (Unit)', () => {
  it('lève SupportBookingNotFoundError si la réservation n\u2019existe pas', async () => {
    const queryChain: any = {};
    queryChain.select = vi.fn().mockReturnValue(queryChain);
    queryChain.from = vi.fn().mockReturnValue(queryChain);
    queryChain.innerJoin = vi.fn().mockReturnValue(queryChain);
    queryChain.leftJoin = vi.fn().mockReturnValue(queryChain);
    queryChain.where = vi.fn().mockReturnValue(queryChain);
    queryChain.orderBy = vi.fn().mockReturnValue(queryChain);
    queryChain.limit = vi.fn().mockResolvedValue([]);
    const fakeDb = queryChain;

    await expect(
      getBookingSupportDetails(fakeDb, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(SupportBookingNotFoundError);
  });
});
