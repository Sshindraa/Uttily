import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { getSupplementCheckoutSummary } from './get-supplement-checkout-summary';

describe('getSupplementCheckoutSummary — Unit tests', () => {
  const amendmentId = '11111111-1111-4111-8111-111111111111';
  const customerUserId = '22222222-2222-4222-8222-222222222222';
  const organizationId = '33333333-3333-4333-8333-333333333333';
  const bookingId = '44444444-4444-4444-8444-444444444444';
  const paymentId = '55555555-5555-4555-8555-555555555555';
  const holdDeadline = new Date('2026-06-01T12:10:00.000Z');

  function createMockDb(options: {
    amendmentRow?: Record<string, unknown> | null;
    paymentRow?: Record<string, unknown> | null;
    attempts?: Array<Record<string, unknown>>;
  }): DatabaseClient {
    const selectFn = vi.fn().mockImplementation(() => {
      return {
        from: vi.fn().mockImplementation(() => {
          return {
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi
                    .fn()
                    .mockResolvedValue(options.amendmentRow ? [options.amendmentRow] : []),
                }),
              }),
            }),
            where: vi.fn().mockImplementation(() => {
              return {
                limit: vi.fn().mockResolvedValue(options.paymentRow ? [options.paymentRow] : []),
                then: (resolve: (val: unknown) => unknown) => resolve(options.attempts ?? []),
                [Symbol.toStringTag]: 'Promise',
              };
            }),
          };
        }),
      };
    });

    return { select: selectFn } as unknown as DatabaseClient;
  }

  it('rejette un amendmentId invalide avec NOT_FOUND', async () => {
    const db = createMockDb({});
    const res = await getSupplementCheckoutSummary(db, {
      amendmentId: 'invalid-uuid',
      customerUserId,
    });
    expect(res).toEqual({ kind: 'NOT_FOUND' });
  });

  it('rejette un customerUserId invalide avec NOT_FOUND', async () => {
    const db = createMockDb({});
    const res = await getSupplementCheckoutSummary(db, {
      amendmentId,
      customerUserId: 'not-a-uuid',
    });
    expect(res).toEqual({ kind: 'NOT_FOUND' });
  });

  it('rejette une date asOf invalide avec INVALID_STATE', async () => {
    const db = createMockDb({});
    const res = await getSupplementCheckoutSummary(
      db,
      { amendmentId, customerUserId },
      { asOf: new Date('invalid') },
    );
    expect(res).toEqual({ kind: 'INVALID_STATE' });
  });

  it('retourne NOT_FOUND si aucun amendement ne correspond au client', async () => {
    const db = createMockDb({ amendmentRow: null });
    const res = await getSupplementCheckoutSummary(db, { amendmentId, customerUserId });
    expect(res).toEqual({ kind: 'NOT_FOUND' });
  });

  it('retourne NOT_FOUND si le type d amendement n est pas SUPPLEMENT', async () => {
    const db = createMockDb({
      amendmentRow: {
        amendmentId,
        organizationId,
        bookingId,
        amendmentType: 'NEUTRAL',
        amendmentStatus: 'APPLIED',
        holdDeadline: null,
        customerUserId,
        locationTimeZone: 'Europe/Paris',
      },
    });
    const res = await getSupplementCheckoutSummary(db, { amendmentId, customerUserId });
    expect(res).toEqual({ kind: 'NOT_FOUND' });
  });

  it('retourne INVALID_STATE si la ligne amendment_payments est absente', async () => {
    const db = createMockDb({
      amendmentRow: {
        amendmentId,
        organizationId,
        bookingId,
        amendmentType: 'SUPPLEMENT',
        amendmentStatus: 'HOLD_PENDING',
        holdDeadline,
        customerUserId,
        locationTimeZone: 'Europe/Paris',
      },
      paymentRow: null,
    });
    const res = await getSupplementCheckoutSummary(db, { amendmentId, customerUserId });
    expect(res).toEqual({ kind: 'INVALID_STATE' });
  });

  it('retourne INVALID_STATE si la devise n est pas EUR ou le montant <= 0', async () => {
    const db = createMockDb({
      amendmentRow: {
        amendmentId,
        organizationId,
        bookingId,
        amendmentType: 'SUPPLEMENT',
        amendmentStatus: 'HOLD_PENDING',
        holdDeadline,
        customerUserId,
        locationTimeZone: 'Europe/Paris',
      },
      paymentRow: {
        id: paymentId,
        organizationId,
        customerUserId,
        amountMinor: 0,
        currency: 'EUR',
        status: 'PENDING_PROVIDER',
      },
    });
    const res = await getSupplementCheckoutSummary(db, { amendmentId, customerUserId });
    expect(res).toEqual({ kind: 'INVALID_STATE' });
  });

  it('retourne PAID si l amendement est APPLIED', async () => {
    const db = createMockDb({
      amendmentRow: {
        amendmentId,
        organizationId,
        bookingId,
        amendmentType: 'SUPPLEMENT',
        amendmentStatus: 'APPLIED',
        holdDeadline,
        customerUserId,
        locationTimeZone: 'Europe/Paris',
      },
      paymentRow: {
        id: paymentId,
        organizationId,
        customerUserId,
        amountMinor: 5000,
        currency: 'EUR',
        status: 'SUCCEEDED',
      },
    });
    const res = await getSupplementCheckoutSummary(db, { amendmentId, customerUserId });
    expect(res).toEqual({ kind: 'PAID' });
  });

  it('retourne PAID si l amendement est READY_TO_APPLY', async () => {
    const db = createMockDb({
      amendmentRow: {
        amendmentId,
        organizationId,
        bookingId,
        amendmentType: 'SUPPLEMENT',
        amendmentStatus: 'READY_TO_APPLY',
        holdDeadline,
        customerUserId,
        locationTimeZone: 'Europe/Paris',
      },
      paymentRow: {
        id: paymentId,
        organizationId,
        customerUserId,
        amountMinor: 5000,
        currency: 'EUR',
        status: 'SUCCEEDED',
      },
    });
    const res = await getSupplementCheckoutSummary(db, { amendmentId, customerUserId });
    expect(res).toEqual({ kind: 'PAID' });
  });

  it('retourne EXPIRED si l amendement est EXPIRED', async () => {
    const db = createMockDb({
      amendmentRow: {
        amendmentId,
        organizationId,
        bookingId,
        amendmentType: 'SUPPLEMENT',
        amendmentStatus: 'EXPIRED',
        holdDeadline,
        customerUserId,
        locationTimeZone: 'Europe/Paris',
      },
      paymentRow: {
        id: paymentId,
        organizationId,
        customerUserId,
        amountMinor: 5000,
        currency: 'EUR',
        status: 'FAILED',
      },
    });
    const res = await getSupplementCheckoutSummary(db, { amendmentId, customerUserId });
    expect(res).toEqual({ kind: 'EXPIRED' });
  });

  it('retourne EXPIRED si asOf >= holdDeadline', async () => {
    const db = createMockDb({
      amendmentRow: {
        amendmentId,
        organizationId,
        bookingId,
        amendmentType: 'SUPPLEMENT',
        amendmentStatus: 'HOLD_PENDING',
        holdDeadline,
        customerUserId,
        locationTimeZone: 'Europe/Paris',
      },
      paymentRow: {
        id: paymentId,
        organizationId,
        customerUserId,
        amountMinor: 5000,
        currency: 'EUR',
        status: 'PENDING_PROVIDER',
      },
    });
    // asOf exactement égal à holdDeadline
    const resExact = await getSupplementCheckoutSummary(
      db,
      { amendmentId, customerUserId },
      { asOf: holdDeadline },
    );
    expect(resExact).toEqual({ kind: 'EXPIRED' });

    // asOf après holdDeadline
    const resAfter = await getSupplementCheckoutSummary(
      db,
      { amendmentId, customerUserId },
      { asOf: new Date(holdDeadline.getTime() + 1000) },
    );
    expect(resAfter).toEqual({ kind: 'EXPIRED' });
  });

  it('retourne PROCESSING si payment.status est PROCESSING', async () => {
    const db = createMockDb({
      amendmentRow: {
        amendmentId,
        organizationId,
        bookingId,
        amendmentType: 'SUPPLEMENT',
        amendmentStatus: 'HOLD_PENDING',
        holdDeadline,
        customerUserId,
        locationTimeZone: 'Europe/Paris',
      },
      paymentRow: {
        id: paymentId,
        organizationId,
        customerUserId,
        amountMinor: 5000,
        currency: 'EUR',
        status: 'PROCESSING',
      },
    });
    const res = await getSupplementCheckoutSummary(
      db,
      { amendmentId, customerUserId },
      { asOf: new Date(holdDeadline.getTime() - 60_000) },
    );
    expect(res).toEqual({ kind: 'PROCESSING' });
  });

  it('retourne PAYABLE avec montant, devise, échéance et fuseau', async () => {
    const db = createMockDb({
      amendmentRow: {
        amendmentId,
        organizationId,
        bookingId,
        amendmentType: 'SUPPLEMENT',
        amendmentStatus: 'HOLD_PENDING',
        holdDeadline,
        customerUserId,
        locationTimeZone: 'Europe/Paris',
      },
      paymentRow: {
        id: paymentId,
        organizationId,
        customerUserId,
        amountMinor: 2500,
        currency: 'EUR',
        status: 'PENDING_PROVIDER',
      },
      attempts: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          status: 'PENDING_PROVIDER',
        },
      ],
    });
    const res = await getSupplementCheckoutSummary(
      db,
      { amendmentId, customerUserId },
      { asOf: new Date(holdDeadline.getTime() - 60_000) },
    );
    expect(res).toEqual({
      kind: 'PAYABLE',
      amountMinor: 2500,
      currency: 'EUR',
      holdDeadline: holdDeadline.toISOString(),
      timeZone: 'Europe/Paris',
    });
  });

  it('retourne INVALID_STATE si plusieurs tentatives actives existent', async () => {
    const db = createMockDb({
      amendmentRow: {
        amendmentId,
        organizationId,
        bookingId,
        amendmentType: 'SUPPLEMENT',
        amendmentStatus: 'HOLD_PENDING',
        holdDeadline,
        customerUserId,
        locationTimeZone: 'Europe/Paris',
      },
      paymentRow: {
        id: paymentId,
        organizationId,
        customerUserId,
        amountMinor: 2500,
        currency: 'EUR',
        status: 'PENDING_PROVIDER',
      },
      attempts: [
        { id: '66666666-6666-4666-8666-666666666666', status: 'PENDING_PROVIDER' },
        { id: '77777777-7777-4777-8777-777777777777', status: 'REQUIRES_ACTION' },
      ],
    });
    const res = await getSupplementCheckoutSummary(
      db,
      { amendmentId, customerUserId },
      { asOf: new Date(holdDeadline.getTime() - 60_000) },
    );
    expect(res).toEqual({ kind: 'INVALID_STATE' });
  });
});
