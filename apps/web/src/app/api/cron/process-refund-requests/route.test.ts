import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { createDatabase, runMigrations, assertLocalhost } from '@uttily/database';
import type { DatabaseClient } from '@uttily/database';
import {
  FakeStripeAdapter,
  PaymentProviderError,
  type CreateRefundParams,
  type RefundResult,
  type StripeEnvironment,
} from '@uttily/core';
import { sql } from 'drizzle-orm';

let testDb: DatabaseClient | null = null;
let rawSql: postgres.Sql | null = null;
let provider: RouteRefundProvider | null = null;

vi.mock('@/lib/db', () => ({
  getDb: () => {
    if (!testDb) throw new Error('test database is not initialized');
    return testDb;
  },
}));

vi.mock('@/lib/stripe', () => ({
  getStripeAdapter: () => {
    if (!provider) throw new Error('test provider is not initialized');
    return provider;
  },
}));

const { GET } = await import('./route');

class RouteRefundProvider extends FakeStripeAdapter {
  calls: CreateRefundParams[] = [];
  forcedError: PaymentProviderError | null = null;
  leaseLossOutboxEventId: string | null = null;

  constructor(environment: StripeEnvironment = 'TEST') {
    super({ environment });
  }

  override async createRefund(params: CreateRefundParams): Promise<RefundResult> {
    this.calls.push(params);
    if (this.forcedError) throw this.forcedError;
    const leaseLossOutboxEventId = this.leaseLossOutboxEventId;
    this.leaseLossOutboxEventId = null;
    if (leaseLossOutboxEventId) {
      if (!rawSql) throw new Error('PostgreSQL non initialisé');
      await rawSql`
        UPDATE outbox_events
        SET lease_until = now() - interval '1 second'
        WHERE id = ${leaseLossOutboxEventId}
      `;
    }
    return {
      id: `re_route_${this.environment.toLowerCase()}_${this.calls.length}`,
      status: 'succeeded',
      amountMinor: params.amountMinor,
      currency: 'EUR',
    };
  }
}

interface Fixture {
  organizationId: string;
  otherOrganizationId: string;
  userId: string;
  locationId: string;
  paymentId: string;
  paymentAttemptId: string;
  paymentIntentId: string;
  bookingId: string;
  amendmentId: string;
  refundId: string;
  outboxEventId: string;
}

const DATABASE_URL = process.env.DATABASE_URL;
const TEST_DB_NAME = 'uttily_test_cron_refund_requests';
const CRON_SECRET = 'route-test-cron-secret';
const shouldRun = Boolean(DATABASE_URL) && process.env.SKIP_INTEGRATION_TESTS !== '1';

function makeRequest(secret: string | null = CRON_SECRET): Request {
  const headers = new Headers();
  if (secret !== null) headers.set('Authorization', `Bearer ${secret}`);
  return new Request('http://localhost/api/cron/process-refund-requests', { headers });
}

async function seedFixture(environment: StripeEnvironment = 'TEST'): Promise<Fixture> {
  if (!rawSql) throw new Error('PostgreSQL non initialisé');
  const suffix = Math.random().toString(36).slice(2, 10);
  const org = await rawSql`
    INSERT INTO organizations (legal_name, slug)
    VALUES (${'Cron refund ' + suffix}, ${'cron-refund-' + suffix})
    RETURNING id
  `.then((rows) => rows[0]!);
  const otherOrg = await rawSql`
    INSERT INTO organizations (legal_name, slug)
    VALUES (${'Cron refund other ' + suffix}, ${'cron-refund-other-' + suffix})
    RETURNING id
  `.then((rows) => rows[0]!);
  const user = await rawSql`
    INSERT INTO users (email)
    VALUES (${'cron-refund-' + suffix + '@example.com'})
    RETURNING id
  `.then((rows) => rows[0]!);
  const location = await rawSql`
    INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
    VALUES (${org.id}, 'Cron', ${'cron-' + suffix}, 'Europe/Paris', 'EUR')
    RETURNING id
  `.then((rows) => rows[0]!);
  const draft = await rawSql`
    INSERT INTO booking_drafts (
      organization_id, location_id, customer_user_id, status,
      customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
      timezone, prep_buffer_minutes, cleanup_buffer_minutes,
      subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
      tax_status, tax_amount_minor, tax_rate_bps, commission_amount_minor,
      billable_unit, billable_unit_count, currency, cancellation_policy_snapshot
    ) VALUES (
      ${org.id}, ${location.id}, ${user.id}, 'CONVERTED',
      '2026-04-10 09:00:00+00', '2026-04-12 17:00:00+00',
      '2026-04-10 08:30:00+00', '2026-04-12 17:30:00+00',
      'Europe/Paris', 30, 30, 10000, 0, 10000,
      'NOT_APPLICABLE', 0, NULL, 500, 'DAY', 2, 'EUR',
      ${rawSql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })}
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const payment = await rawSql`
    INSERT INTO payments (
      organization_id, draft_id, customer_user_id, status,
      amount_minor, currency, tax_status, tax_amount_minor,
      commission_amount_minor, financial_terms_version, legal_terms_version,
      terms_acceptance_snapshot, connected_account_id, charge_model,
      settlement_merchant_mode, environment, succeeded_at
    ) VALUES (
      ${org.id}, ${draft.id}, ${user.id}, 'SUCCEEDED', 10000, 'EUR',
      'NOT_APPLICABLE', 0, 500, 'v1', 'v1',
      ${rawSql.json({ version: 'v1', user_id: user.id, accepted_at: '2026-01-01T00:00:00Z' })},
      'acct_cron', 'DESTINATION', 'CONNECTED_ACCOUNT', ${environment}::payment_environment, now()
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const booking = await rawSql`
    INSERT INTO bookings (
      organization_id, location_id, customer_user_id, draft_id, payment_id,
      status, customer_start_at, customer_end_at, blocked_start_at, blocked_end_at,
      timezone, prep_buffer_minutes, cleanup_buffer_minutes, currency,
      subtotal_amount_minor, mandatory_fees_amount_minor, total_amount_minor,
      tax_status, tax_amount_minor, tax_rate_bps, commission_amount_minor,
      billable_unit, billable_unit_count, cancellation_policy_snapshot,
      terms_acceptance_snapshot, confirmed_at
    ) VALUES (
      ${org.id}, ${location.id}, ${user.id}, ${draft.id}, ${payment.id}, 'CONFIRMED',
      '2026-04-10 09:00:00+00', '2026-04-12 17:00:00+00',
      '2026-04-10 08:30:00+00', '2026-04-12 17:30:00+00', 'Europe/Paris', 30, 30, 'EUR',
      10000, 0, 10000, 'NOT_APPLICABLE', 0, NULL, 500, 'DAY', 2,
      ${rawSql.json({ policy_code: 'FLEXIBLE', policy_version: '1', timezone: 'Europe/Paris' })},
      ${rawSql.json({ version: 'v1', user_id: user.id, accepted_at: '2026-01-01T00:00:00Z' })}, now()
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const amendment = await rawSql`
    INSERT INTO booking_amendments (
      organization_id, booking_id, amendment_number, type, status,
      financial_snapshot_before, financial_snapshot_after,
      new_customer_start_at, new_customer_end_at,
      new_blocked_start_at, new_blocked_end_at, created_by, applied_at
    ) VALUES (
      ${org.id}, ${booking.id}, 1, 'REFUND', 'READY_TO_APPLY',
      ${rawSql.json({ total_amount_minor: 10000 })}, ${rawSql.json({ total_amount_minor: 0 })},
      '2026-04-10 09:00:00+00', '2026-04-12 17:00:00+00',
      '2026-04-10 08:30:00+00', '2026-04-12 17:30:00+00', ${user.id}, NULL
    ) RETURNING id
  `.then((rows) => rows[0]!);
  await rawSql`
    UPDATE booking_amendments SET status = 'APPLIED', applied_at = now() WHERE id = ${amendment.id}
  `;
  const refundId = crypto.randomUUID();
  const refund = await rawSql`
    INSERT INTO refunds (
      id, organization_id, payment_id, reason, status, amount_minor, currency,
      provider_idempotency_key, reverse_transfer, refund_application_fee, requested_at
    ) VALUES (
      ${refundId}, ${org.id}, ${payment.id}, 'BOOKING_MODIFICATION', 'PENDING', 10000, 'EUR',
      ${'refund_amendment_' + refundId}, true, true, now()
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const paymentIntentId = 'pi_cron_' + suffix;
  const attempt = await rawSql`
    INSERT INTO payment_attempts (
      organization_id, payment_id, attempt_number, status,
      provider_payment_intent_id, provider_idempotency_key, provider_status
    ) VALUES (
      ${org.id}, ${payment.id}, 1, 'SUCCEEDED', ${paymentIntentId},
      ${'attempt_cron_' + suffix}, 'succeeded'
    ) RETURNING id
  `.then((rows) => rows[0]!);
  const outbox = await rawSql`
    INSERT INTO outbox_events (
      organization_id, aggregate_type, aggregate_id, event_type, event_version,
      payload, status, attempt_count, available_at, idempotency_key
    ) VALUES (
      ${org.id}, 'REFUND', ${refund.id}, 'REFUND_REQUESTED', 'v1',
      ${rawSql.json({
        organizationId: org.id,
        bookingId: booking.id,
        amendmentId: amendment.id,
        refundId: refund.id,
      })}, 'PENDING', 0, now(), ${'cron_refund_outbox_' + suffix}
    ) RETURNING id
  `.then((rows) => rows[0]!);

  // Ensure the second tenant is part of the fixture's isolation proof without
  // creating unrelated business data for the worker to claim.
  await rawSql`SELECT id FROM organizations WHERE id = ${otherOrg.id}`;
  return {
    organizationId: org.id,
    otherOrganizationId: otherOrg.id,
    userId: user.id,
    locationId: location.id,
    paymentId: payment.id,
    paymentAttemptId: attempt.id,
    paymentIntentId,
    bookingId: booking.id,
    amendmentId: amendment.id,
    refundId: refund.id,
    outboxEventId: outbox.id,
  };
}

async function refundState(fixture: Fixture) {
  if (!rawSql) throw new Error('PostgreSQL non initialisé');
  const refund =
    await rawSql`SELECT status, provider_refund_id FROM refunds WHERE id = ${fixture.refundId}`;
  const outbox = await rawSql`
    SELECT status, attempt_count, lease_token, lease_until
    FROM outbox_events
    WHERE id = ${fixture.outboxEventId}
  `;
  return { refund: refund[0]!, outbox: outbox[0]! };
}

function expectNoFixtureIdentifiers(value: unknown, fixture: Fixture): void {
  const serialized = JSON.stringify(value) ?? '';
  for (const identifier of Object.values(fixture)) {
    expect(serialized).not.toContain(identifier);
  }
}

const integrationDescribe = shouldRun ? describe : describe.skip;

integrationDescribe('GET /api/cron/process-refund-requests — PostgreSQL/Web', () => {
  beforeAll(async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL est requise');
    assertLocalhost(DATABASE_URL);
    const admin = postgres(DATABASE_URL, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
      await admin.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
    } finally {
      await admin.end();
    }
    const testUrl = new URL(DATABASE_URL);
    testUrl.pathname = `/${TEST_DB_NAME}`;
    await runMigrations(testUrl.toString());
    testDb = createDatabase(testUrl.toString());
    rawSql = postgres(testUrl.toString(), { max: 8 });
    process.env.CRON_SECRET = CRON_SECRET;
    process.env.STRIPE_ENVIRONMENT = 'TEST';
  });

  afterAll(async () => {
    delete process.env.CRON_SECRET;
    delete process.env.STRIPE_ENVIRONMENT;
    delete process.env.PAYMENTS_LIVE_ENABLED;
    if (rawSql) await rawSql.end();
    if (testDb) await testDb.$client.end();
    if (DATABASE_URL) {
      const admin = postgres(DATABASE_URL, { max: 1 });
      try {
        await admin.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();`,
        );
        await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
      } finally {
        await admin.end();
      }
    }
  });

  beforeEach(async () => {
    if (!testDb) throw new Error('testDb non initialisée');
    await testDb.execute(sql`
      TRUNCATE TABLE refunds, outbox_events, booking_amendments, bookings,
        payment_attempts, payments, booking_drafts, locations, organizations, users
      RESTART IDENTITY CASCADE
    `);
    provider = new RouteRefundProvider('TEST');
    process.env.CRON_SECRET = CRON_SECRET;
    process.env.STRIPE_ENVIRONMENT = 'TEST';
    delete process.env.PAYMENTS_LIVE_ENABLED;
  });

  it('1. refuse une requête sans Authorization', async () => {
    const response = await GET(makeRequest(null));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('2. refuse un secret incorrect', async () => {
    const response = await GET(makeRequest('wrong-secret'));
    expect(response.status).toBe(401);
  });

  it('3. refuse un schéma Authorization non Bearer', async () => {
    const request = new Request('http://localhost/api/cron/process-refund-requests', {
      headers: { Authorization: `Basic ${CRON_SECRET}` },
    });
    expect((await GET(request)).status).toBe(401);
  });

  it('4. fail-closed si CRON_SECRET est absent', async () => {
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      expect((await GET(makeRequest())).status).toBe(401);
    } finally {
      process.env.CRON_SECRET = saved;
    }
  });

  it('5. rejette STRIPE_ENVIRONMENT invalide sans ouvrir le provider', async () => {
    process.env.STRIPE_ENVIRONMENT = 'INVALID';
    provider = null;
    const response = await GET(makeRequest());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Configuration Error' });
  });

  it('6. accepte explicitement TEST', async () => {
    process.env.STRIPE_ENVIRONMENT = 'TEST';
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    expect((await response.json()).environment).toBe('TEST');
  });

  it('7. isole réellement TEST et LIVE avec deux fixtures', async () => {
    const testFixture = await seedFixture('TEST');
    const liveFixture = await seedFixture('LIVE');

    process.env.STRIPE_ENVIRONMENT = 'TEST';
    provider = new RouteRefundProvider('TEST');
    const testResponse = await GET(makeRequest());
    const testBody = await testResponse.json();
    expect(testResponse.status).toBe(200);
    expect(testBody).toMatchObject({
      environment: 'TEST',
      claimedCount: 1,
      submittedCount: 1,
    });
    expectNoFixtureIdentifiers(testBody, testFixture);
    expect((await refundState(testFixture)).refund.status).toBe('SUBMITTED');
    expect((await refundState(liveFixture)).refund.status).toBe('PENDING');
    expect(provider.calls).toHaveLength(1);

    process.env.STRIPE_ENVIRONMENT = 'LIVE';
    process.env.PAYMENTS_LIVE_ENABLED = 'true';
    provider = new RouteRefundProvider('LIVE');
    const liveResponse = await GET(makeRequest());
    const liveBody = await liveResponse.json();
    expect(liveResponse.status).toBe(200);
    expect(liveBody).toMatchObject({
      environment: 'LIVE',
      claimedCount: 1,
      submittedCount: 1,
    });
    expectNoFixtureIdentifiers(liveBody, liveFixture);
    expect((await refundState(liveFixture)).refund.status).toBe('SUBMITTED');
    expect(provider.calls).toHaveLength(1);
  });

  it('8. retourne le contrat public complet pour un batch vide', async () => {
    const body = await (await GET(makeRequest())).json();
    expect(body).toEqual({
      ok: true,
      environment: 'TEST',
      claimedCount: 0,
      submittedCount: 0,
      alreadyResolvedCount: 0,
      failedCount: 0,
      rescheduledCount: 0,
      leaseLostCount: 0,
      anomalyCount: 0,
    });
  });

  it('9. exécute un refund réel et ne renvoie aucune donnée sensible', async () => {
    const fixture = await seedFixture();
    const response = await GET(makeRequest());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ claimedCount: 1, submittedCount: 1, failedCount: 0 });
    expectNoFixtureIdentifiers(body, fixture);
    const state = await refundState(fixture);
    expect(state.refund.status).toBe('SUBMITTED');
    expect(state.outbox.status).toBe('PROCESSED');
    expect(provider?.calls).toHaveLength(1);
  });

  it('10. traite un replay déjà SUCCEEDED sans nouvel appel provider', async () => {
    const fixture = await seedFixture();
    await rawSql!`UPDATE refunds SET status = 'SUCCEEDED', succeeded_at = now() WHERE id = ${fixture.refundId}`;
    const response = await GET(makeRequest());
    expect((await response.json()).alreadyResolvedCount).toBe(1);
    expect(provider?.calls).toHaveLength(0);
    expect((await refundState(fixture)).outbox.status).toBe('PROCESSED');
  });

  it('11. produit un log de succès structuré sans identifiants', async () => {
    const fixture = await seedFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await GET(makeRequest());
      const entry = JSON.parse(log.mock.calls[0]![0] as string);
      expect(entry).toMatchObject({
        event: 'cron.process-refund-requests',
        environment: 'TEST',
        claimedCount: 1,
        submittedCount: 1,
      });
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      expectNoFixtureIdentifiers(entry, fixture);
    } finally {
      log.mockRestore();
    }
  });

  it('12. alerte sur une erreur durable avec un code fermé', async () => {
    const fixture = await seedFixture();
    provider!.forcedError = new PaymentProviderError(
      'UNKNOWN',
      'provider message must not be logged',
      'invalid_request_error',
    );
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await GET(makeRequest());
      expect(response.status).toBe(200);
      const entries = warning.mock.calls.map((call) => JSON.parse(call[0] as string));
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'cron.process-refund-requests.alert',
            failedCount: 1,
            codes: ['invalid_request_error'],
          }),
        ]),
      );
      expect(JSON.stringify(entries)).not.toContain('provider message must not be logged');
      expectNoFixtureIdentifiers(entries, fixture);
    } finally {
      warning.mockRestore();
    }
  });

  it('13. remplace un code d’alerte inconnu par UNKNOWN_ANOMALY', async () => {
    const fixture = await seedFixture();
    provider!.forcedError = new PaymentProviderError(
      'UNKNOWN',
      'provider message must not be logged',
      'fixture-provider-code',
    );
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await GET(makeRequest());
      expect(response.status).toBe(200);
      const body = await response.json();
      const entries = warning.mock.calls.map((call) => JSON.parse(call[0] as string));
      const alert = entries.find((entry) => entry.event === 'cron.process-refund-requests.alert');
      expect(body).toMatchObject({ claimedCount: 1, failedCount: 1 });
      expect(alert).toMatchObject({ anomalyCount: 1, codes: ['UNKNOWN_ANOMALY'] });
      expect(JSON.stringify(entries)).not.toContain('provider message must not be logged');
      expect(JSON.stringify(entries)).not.toContain('fixture-provider-code');
      expectNoFixtureIdentifiers(body, fixture);
      expectNoFixtureIdentifiers(entries, fixture);
    } finally {
      warning.mockRestore();
    }
  });

  it('14. distingue une erreur technique et ne divulgue pas son message', async () => {
    const fixture = await seedFixture();
    provider = null;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await GET(makeRequest());
      expect(response.status).toBe(500);
      const body = await response.json();
      const entry = JSON.parse(error.mock.calls[0]![0] as string);
      expect(entry).toMatchObject({
        event: 'cron.process-refund-requests.error',
        errorCode: 'INTERNAL_ERROR',
      });
      expect(entry.error).toBeUndefined();
      expectNoFixtureIdentifiers(body, fixture);
      expectNoFixtureIdentifiers(entry, fixture);
    } finally {
      error.mockRestore();
    }
  });

  it('15. ne logue pas de details provider dans une erreur de configuration', async () => {
    process.env.STRIPE_ENVIRONMENT = 'BAD_PROVIDER_ACCOUNT';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await GET(makeRequest());
      expect(JSON.stringify(error.mock.calls)).not.toContain('BAD_PROVIDER_ACCOUNT');
    } finally {
      error.mockRestore();
    }
  });

  it('16. reschedule les erreurs transitoires et expose uniquement le compteur', async () => {
    const fixture = await seedFixture();
    provider!.forcedError = new PaymentProviderError('UNKNOWN', 'temporary', 'timeout');
    const body = await (await GET(makeRequest())).json();
    expect(body).toMatchObject({ claimedCount: 1, rescheduledCount: 1, failedCount: 0 });
    expect((await refundState(fixture)).refund.status).toBe('PENDING');
  });

  it('17. ignore un vrai tuple outbox hors de la sélection refund', async () => {
    const fixture = await seedFixture();
    await rawSql!`
      UPDATE outbox_events
      SET aggregate_type = 'PAYMENT'
      WHERE id = ${fixture.outboxEventId}
    `;
    const body = await (await GET(makeRequest())).json();
    expect(body).toMatchObject({ claimedCount: 0, submittedCount: 0 });
    expect(provider?.calls).toHaveLength(0);
    const state = await refundState(fixture);
    expect(state.refund.status).toBe('PENDING');
    expect(state.refund.provider_refund_id).toBeNull();
    expect(state.outbox.status).toBe('PENDING');
    expect(state.outbox.attempt_count).toBe(0);
    expect(state.outbox.lease_token).toBeNull();
    expect(state.outbox.lease_until).toBeNull();
    expectNoFixtureIdentifiers(body, fixture);
  });

  it('18. publie les codes d’anomalie sans les identifiants des événements', async () => {
    const fixture = await seedFixture();
    await rawSql!`UPDATE outbox_events SET payload = '{}'::jsonb WHERE id = ${fixture.outboxEventId}`;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await GET(makeRequest());
      const entries = warning.mock.calls.map((call) => JSON.parse(call[0] as string));
      const alert = entries.find((entry) => entry.event === 'cron.process-refund-requests.alert');
      expect(alert).toMatchObject({ anomalyCount: 1, codes: ['PAYLOAD_MALFORMED'] });
      expectNoFixtureIdentifiers(entries, fixture);
    } finally {
      warning.mockRestore();
    }
  });

  it('19. ne mute rien localement si la lease est perdue après le provider', async () => {
    const fixture = await seedFixture();
    provider!.leaseLossOutboxEventId = fixture.outboxEventId;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await GET(makeRequest());
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        claimedCount: 1,
        submittedCount: 0,
        failedCount: 0,
        leaseLostCount: 1,
      });
      expect(provider!.calls).toHaveLength(1);
      const state = await refundState(fixture);
      expect(state.refund.status).toBe('PENDING');
      expect(state.refund.provider_refund_id).toBeNull();
      expect(state.outbox.status).toBe('PROCESSING');
      const entries = warning.mock.calls.map((call) => JSON.parse(call[0] as string));
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'cron.process-refund-requests.alert',
            leaseLostCount: 1,
            anomalyCount: 0,
          }),
        ]),
      );
      expectNoFixtureIdentifiers(body, fixture);
      expectNoFixtureIdentifiers(
        [...log.mock.calls, ...warning.mock.calls].map((call) => call[0]),
        fixture,
      );
    } finally {
      log.mockRestore();
      warning.mockRestore();
    }
  });

  it('20. reste dynamique et conserve exactement les quatre crons Vercel', async () => {
    const route = await import('./route');
    expect(route.dynamic).toBe('force-dynamic');
    const config = await import('../../../../../vercel.json', { with: { type: 'json' } });
    expect(config.default.crons).toEqual([
      { path: '/api/cron/expire-holds', schedule: '* * * * *' },
      { path: '/api/cron/reconcile-payments', schedule: '* * * * *' },
      { path: '/api/cron/process-compensations', schedule: '* * * * *' },
      { path: '/api/cron/process-refund-requests', schedule: '* * * * *' },
    ]);
  });
});
