import { describe, it, expect } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { bookingAmendments, amendmentPayments, amendmentPaymentAttempts } from '@uttily/database';
import { getSupplementCheckoutSummary } from './get-supplement-checkout-summary';

describe('getSupplementCheckoutSummary — Unit Tests (G7M-C5-C)', () => {
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const bookingId = '22222222-2222-4222-8222-222222222222';
  const amendmentId = '33333333-3333-4333-8333-333333333333';
  const customerUserId = '44444444-4444-4444-8444-444444444444';
  const paymentId = '55555555-5555-4555-8555-555555555555';
  const holdDeadline = new Date(Date.now() + 600_000);

  function createMockDb(options: {
    amendmentRow?: Record<string, unknown> | null;
    paymentRow?: Record<string, unknown> | null;
    attempts?: Array<Record<string, unknown>>;
  }) {
    const amendmentRows = options.amendmentRow ? [options.amendmentRow] : [];
    const paymentRows = options.paymentRow ? [options.paymentRow] : [];
    const attemptRows = options.attempts ?? [];

    return {
      select: () => ({
        from: (table: unknown) => {
          if (table === bookingAmendments) {
            return {
              innerJoin: () => ({
                innerJoin: () => ({
                  where: () => ({
                    limit: async () => amendmentRows,
                  }),
                }),
              }),
            };
          }

          if (table === amendmentPayments) {
            return {
              where: () => ({
                limit: async () => paymentRows,
              }),
            };
          }

          if (table === amendmentPaymentAttempts) {
            return {
              where: async () => attemptRows,
            };
          }

          return {
            where: () => ({
              limit: async () => [],
            }),
          };
        },
      }),
    } as unknown as DatabaseClient;
  }

  it('rejette les UUIDs invalides avec NOT_FOUND', async () => {
    const db = createMockDb({});
    expect(
      await getSupplementCheckoutSummary(db, { amendmentId: 'invalid-id', customerUserId }),
    ).toEqual({ kind: 'NOT_FOUND' });

    expect(
      await getSupplementCheckoutSummary(db, { amendmentId, customerUserId: 'invalid-id' }),
    ).toEqual({ kind: 'NOT_FOUND' });
  });

  it('retourne NOT_FOUND si aucun enregistrement ne correspond', async () => {
    const db = createMockDb({ amendmentRow: null });
    expect(await getSupplementCheckoutSummary(db, { amendmentId, customerUserId })).toEqual({
      kind: 'NOT_FOUND',
    });
  });

  it('retourne NOT_FOUND si le type n est pas SUPPLEMENT', async () => {
    const db = createMockDb({
      amendmentRow: {
        amendmentId,
        organizationId,
        bookingId,
        amendmentType: 'NEUTRAL',
        amendmentStatus: 'HOLD_PENDING',
        holdDeadline,
        customerUserId,
        locationTimeZone: 'Europe/Paris',
      },
    });
    expect(await getSupplementCheckoutSummary(db, { amendmentId, customerUserId })).toEqual({
      kind: 'NOT_FOUND',
    });
  });

  it('retourne INVALID_STATE si la timezone IANA est invalide ou absente', async () => {
    const dbInvalid = createMockDb({
      amendmentRow: {
        amendmentId,
        organizationId,
        bookingId,
        amendmentType: 'SUPPLEMENT',
        amendmentStatus: 'HOLD_PENDING',
        holdDeadline,
        customerUserId,
        locationTimeZone: 'Invalid/TimeZone',
      },
    });
    expect(await getSupplementCheckoutSummary(dbInvalid, { amendmentId, customerUserId })).toEqual({
      kind: 'INVALID_STATE',
    });

    const dbEmpty = createMockDb({
      amendmentRow: {
        amendmentId,
        organizationId,
        bookingId,
        amendmentType: 'SUPPLEMENT',
        amendmentStatus: 'HOLD_PENDING',
        holdDeadline,
        customerUserId,
        locationTimeZone: '',
      },
    });
    expect(await getSupplementCheckoutSummary(dbEmpty, { amendmentId, customerUserId })).toEqual({
      kind: 'INVALID_STATE',
    });
  });

  it('retourne EXPIRED si amendment.status est EXPIRED, même si un paiement tardif est SUCCEEDED', async () => {
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
        bookingId,
        amendmentId,
        customerUserId,
        amountMinor: 2500,
        currency: 'EUR',
        status: 'SUCCEEDED',
      },
    });
    const res = await getSupplementCheckoutSummary(db, { amendmentId, customerUserId });
    expect(res).toEqual({ kind: 'EXPIRED' });
  });

  it('retourne EXPIRED si asOf est supérieur ou égal au holdDeadline', async () => {
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
        bookingId,
        amendmentId,
        customerUserId,
        amountMinor: 2500,
        currency: 'EUR',
        status: 'PENDING_PROVIDER',
      },
    });

    const resExact = await getSupplementCheckoutSummary(
      db,
      { amendmentId, customerUserId },
      { asOf: holdDeadline },
    );
    expect(resExact).toEqual({ kind: 'EXPIRED' });

    const resAfter = await getSupplementCheckoutSummary(
      db,
      { amendmentId, customerUserId },
      { asOf: new Date(holdDeadline.getTime() + 1000) },
    );
    expect(resAfter).toEqual({ kind: 'EXPIRED' });
  });

  it('retourne INVALID_STATE si HOLD_PENDING avec payment.status SUCCEEDED', async () => {
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
        bookingId,
        amendmentId,
        customerUserId,
        amountMinor: 2500,
        currency: 'EUR',
        status: 'SUCCEEDED',
      },
    });
    const res = await getSupplementCheckoutSummary(
      db,
      { amendmentId, customerUserId },
      { asOf: new Date(holdDeadline.getTime() - 60_000) },
    );
    expect(res).toEqual({ kind: 'INVALID_STATE' });
  });

  it('retourne PAID pour APPLIED ou READY_TO_APPLY uniquement avec paiement et tentative SUCCEEDED cohérents', async () => {
    const dbValid = createMockDb({
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
        bookingId,
        amendmentId,
        customerUserId,
        amountMinor: 2500,
        currency: 'EUR',
        status: 'SUCCEEDED',
      },
      attempts: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          organizationId,
          amendmentPaymentId: paymentId,
          status: 'SUCCEEDED',
          providerPaymentIntentId: 'pi_test_123',
          providerStatus: 'succeeded',
        },
      ],
    });
    expect(await getSupplementCheckoutSummary(dbValid, { amendmentId, customerUserId })).toEqual({
      kind: 'PAID',
    });

    // Incohérence : tentative SUCCEEDED sans providerPaymentIntentId
    const dbNoPi = createMockDb({
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
        bookingId,
        amendmentId,
        customerUserId,
        amountMinor: 2500,
        currency: 'EUR',
        status: 'SUCCEEDED',
      },
      attempts: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          organizationId,
          amendmentPaymentId: paymentId,
          status: 'SUCCEEDED',
          providerPaymentIntentId: null,
          providerStatus: 'succeeded',
        },
      ],
    });
    expect(await getSupplementCheckoutSummary(dbNoPi, { amendmentId, customerUserId })).toEqual({
      kind: 'INVALID_STATE',
    });

    // Incohérence : payment non SUCCEEDED
    const dbPayPending = createMockDb({
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
        bookingId,
        amendmentId,
        customerUserId,
        amountMinor: 2500,
        currency: 'EUR',
        status: 'PENDING_PROVIDER',
      },
      attempts: [],
    });
    expect(
      await getSupplementCheckoutSummary(dbPayPending, { amendmentId, customerUserId }),
    ).toEqual({
      kind: 'INVALID_STATE',
    });
  });

  it('retourne PAYABLE pour PENDING_PROVIDER sans données provider', async () => {
    const db = createMockDb({
      amendmentRow: {
        amendmentId,
        organizationId,
        bookingId,
        amendmentType: 'SUPPLEMENT',
        amendmentStatus: 'HOLD_PENDING',
        holdDeadline,
        customerUserId,
        locationTimeZone: 'America/New_York',
      },
      paymentRow: {
        id: paymentId,
        organizationId,
        bookingId,
        amendmentId,
        customerUserId,
        amountMinor: 2500,
        currency: 'EUR',
        status: 'PENDING_PROVIDER',
      },
      attempts: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          organizationId,
          amendmentPaymentId: paymentId,
          status: 'PENDING_PROVIDER',
          providerPaymentIntentId: null,
          providerStatus: null,
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
      timeZone: 'America/New_York',
    });
  });

  it('retourne INVALID_STATE si PENDING_PROVIDER a des données provider', async () => {
    const dbWithPi = createMockDb({
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
        bookingId,
        amendmentId,
        customerUserId,
        amountMinor: 2500,
        currency: 'EUR',
        status: 'PENDING_PROVIDER',
      },
      attempts: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          organizationId,
          amendmentPaymentId: paymentId,
          status: 'PENDING_PROVIDER',
          providerPaymentIntentId: 'pi_leak_123',
          providerStatus: null,
        },
      ],
    });
    expect(
      await getSupplementCheckoutSummary(
        dbWithPi,
        { amendmentId, customerUserId },
        { asOf: new Date(holdDeadline.getTime() - 60_000) },
      ),
    ).toEqual({ kind: 'INVALID_STATE' });
  });

  it('retourne PAYABLE pour REQUIRES_PAYMENT_METHOD et REQUIRES_ACTION avec données cohérentes', async () => {
    const dbMethod = createMockDb({
      amendmentRow: {
        amendmentId,
        organizationId,
        bookingId,
        amendmentType: 'SUPPLEMENT',
        amendmentStatus: 'HOLD_PENDING',
        holdDeadline,
        customerUserId,
        locationTimeZone: 'Europe/London',
      },
      paymentRow: {
        id: paymentId,
        organizationId,
        bookingId,
        amendmentId,
        customerUserId,
        amountMinor: 3000,
        currency: 'EUR',
        status: 'REQUIRES_PAYMENT_METHOD',
      },
      attempts: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          organizationId,
          amendmentPaymentId: paymentId,
          status: 'REQUIRES_PAYMENT_METHOD',
          providerPaymentIntentId: 'pi_method_123',
          providerStatus: 'requires_payment_method',
        },
      ],
    });
    expect(
      await getSupplementCheckoutSummary(
        dbMethod,
        { amendmentId, customerUserId },
        { asOf: new Date(holdDeadline.getTime() - 60_000) },
      ),
    ).toEqual({
      kind: 'PAYABLE',
      amountMinor: 3000,
      currency: 'EUR',
      holdDeadline: holdDeadline.toISOString(),
      timeZone: 'Europe/London',
    });

    const dbAction = createMockDb({
      amendmentRow: {
        amendmentId,
        organizationId,
        bookingId,
        amendmentType: 'SUPPLEMENT',
        amendmentStatus: 'HOLD_PENDING',
        holdDeadline,
        customerUserId,
        locationTimeZone: 'Europe/London',
      },
      paymentRow: {
        id: paymentId,
        organizationId,
        bookingId,
        amendmentId,
        customerUserId,
        amountMinor: 3000,
        currency: 'EUR',
        status: 'REQUIRES_ACTION',
      },
      attempts: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          organizationId,
          amendmentPaymentId: paymentId,
          status: 'REQUIRES_ACTION',
          providerPaymentIntentId: 'pi_action_123',
          providerStatus: 'requires_action',
        },
      ],
    });
    expect(
      await getSupplementCheckoutSummary(
        dbAction,
        { amendmentId, customerUserId },
        { asOf: new Date(holdDeadline.getTime() - 60_000) },
      ),
    ).toEqual({
      kind: 'PAYABLE',
      amountMinor: 3000,
      currency: 'EUR',
      holdDeadline: holdDeadline.toISOString(),
      timeZone: 'Europe/London',
    });
  });

  it('retourne INVALID_STATE pour REQUIRES_METHOD/ACTION sans PaymentIntent ou avec providerStatus différent', async () => {
    const dbNoPi = createMockDb({
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
        bookingId,
        amendmentId,
        customerUserId,
        amountMinor: 3000,
        currency: 'EUR',
        status: 'REQUIRES_ACTION',
      },
      attempts: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          organizationId,
          amendmentPaymentId: paymentId,
          status: 'REQUIRES_ACTION',
          providerPaymentIntentId: null,
          providerStatus: 'requires_action',
        },
      ],
    });
    expect(
      await getSupplementCheckoutSummary(
        dbNoPi,
        { amendmentId, customerUserId },
        { asOf: new Date(holdDeadline.getTime() - 60_000) },
      ),
    ).toEqual({ kind: 'INVALID_STATE' });

    const dbMismatchStatus = createMockDb({
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
        bookingId,
        amendmentId,
        customerUserId,
        amountMinor: 3000,
        currency: 'EUR',
        status: 'REQUIRES_PAYMENT_METHOD',
      },
      attempts: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          organizationId,
          amendmentPaymentId: paymentId,
          status: 'REQUIRES_PAYMENT_METHOD',
          providerPaymentIntentId: 'pi_method_123',
          providerStatus: 'processing',
        },
      ],
    });
    expect(
      await getSupplementCheckoutSummary(
        dbMismatchStatus,
        { amendmentId, customerUserId },
        { asOf: new Date(holdDeadline.getTime() - 60_000) },
      ),
    ).toEqual({ kind: 'INVALID_STATE' });
  });

  it('gère PROCESSING avec ou sans providerPaymentIntentId', async () => {
    // Sans provider => PROCESSING
    const dbNoProv = createMockDb({
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
        bookingId,
        amendmentId,
        customerUserId,
        amountMinor: 5000,
        currency: 'EUR',
        status: 'PROCESSING',
      },
      attempts: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          organizationId,
          amendmentPaymentId: paymentId,
          status: 'PROCESSING',
          providerPaymentIntentId: null,
          providerStatus: null,
        },
      ],
    });
    expect(
      await getSupplementCheckoutSummary(
        dbNoProv,
        { amendmentId, customerUserId },
        { asOf: new Date(holdDeadline.getTime() - 60_000) },
      ),
    ).toEqual({ kind: 'PROCESSING' });

    // Avec provider requires_payment_method => PAYABLE (reprise)
    const dbReqMethod = createMockDb({
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
        bookingId,
        amendmentId,
        customerUserId,
        amountMinor: 5000,
        currency: 'EUR',
        status: 'PROCESSING',
      },
      attempts: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          organizationId,
          amendmentPaymentId: paymentId,
          status: 'PROCESSING',
          providerPaymentIntentId: 'pi_test_123',
          providerStatus: 'requires_payment_method',
        },
      ],
    });
    expect(
      await getSupplementCheckoutSummary(
        dbReqMethod,
        { amendmentId, customerUserId },
        { asOf: new Date(holdDeadline.getTime() - 60_000) },
      ),
    ).toEqual({
      kind: 'PAYABLE',
      amountMinor: 5000,
      currency: 'EUR',
      holdDeadline: holdDeadline.toISOString(),
      timeZone: 'Europe/Paris',
    });

    // Avec provider processing / succeeded => PROCESSING
    const dbProvProc = createMockDb({
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
        bookingId,
        amendmentId,
        customerUserId,
        amountMinor: 5000,
        currency: 'EUR',
        status: 'PROCESSING',
      },
      attempts: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          organizationId,
          amendmentPaymentId: paymentId,
          status: 'PROCESSING',
          providerPaymentIntentId: 'pi_test_123',
          providerStatus: 'processing',
        },
      ],
    });
    expect(
      await getSupplementCheckoutSummary(
        dbProvProc,
        { amendmentId, customerUserId },
        { asOf: new Date(holdDeadline.getTime() - 60_000) },
      ),
    ).toEqual({ kind: 'PROCESSING' });
  });

  it('retourne INVALID_STATE si zéro ou plusieurs tentatives actives existent', async () => {
    // 0 tentative
    const dbZero = createMockDb({
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
        bookingId,
        amendmentId,
        customerUserId,
        amountMinor: 2500,
        currency: 'EUR',
        status: 'PENDING_PROVIDER',
      },
      attempts: [],
    });
    expect(
      await getSupplementCheckoutSummary(
        dbZero,
        { amendmentId, customerUserId },
        { asOf: new Date(holdDeadline.getTime() - 60_000) },
      ),
    ).toEqual({ kind: 'INVALID_STATE' });

    // 2 tentatives
    const dbMultiple = createMockDb({
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
        bookingId,
        amendmentId,
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
    expect(
      await getSupplementCheckoutSummary(
        dbMultiple,
        { amendmentId, customerUserId },
        { asOf: new Date(holdDeadline.getTime() - 60_000) },
      ),
    ).toEqual({ kind: 'INVALID_STATE' });
  });
});
