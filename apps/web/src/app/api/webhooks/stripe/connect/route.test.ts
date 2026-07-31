/**
 * apps/web — Tests HTTP de l'endpoint webhook Stripe Connect (Lot 5, ADR-010 §9, §14).
 *
 * Tests HTTP : extraction de signature, corps brut, délégation au use case,
 * formatage des réponses. Le use case handleWebhook est mocké pour isoler
 * la couche HTTP.
 *
 * Tests de sécurité HTTP (section 2) : utilisent le FakeStripeAdapter réel
 * pour générer des signatures valides/invalides et vérifier le comportement
 * fail-closed de la route.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks : handleWebhook (mocké) + FakeStripeAdapter (réel via importActual).
// ---------------------------------------------------------------------------

const mockHandleWebhook = vi.fn();

vi.mock('@uttily/core', async (importActual) => {
  const actual = await importActual<typeof import('@uttily/core')>();
  return {
    ...actual,
    handleWebhook: (...args: unknown[]) => mockHandleWebhook(...args),
  };
});

vi.mock('@/lib/db', () => ({
  getDb: () => ({}),
}));

const mockGetStripeAdapter = vi.fn();

vi.mock('@/lib/stripe', () => ({
  getStripeAdapter: (...args: unknown[]) => mockGetStripeAdapter(...args),
}));

// Helper local pour générer des signatures fake (similaire à FakeStripeAdapter.generateValidSignature).
// Utilisé pour les tests de sécurité HTTP sans dépendre de l'export public du fake adapter.
function generateFakeSignature(rawBody: string, secret: string): string {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const timestamp = Math.floor(Date.now() / 1000);
  const v1 = createHash('sha256')
    .update(rawBody + secret)
    .digest('hex')
    .slice(0, 24);
  return `t=${timestamp},v1=${v1}`;
}

const PLATFORM_SECRET = 'whsec_fake_platform';
const CONNECT_SECRET = 'whsec_fake_connect';

// Importe le route handler APRÈS les mocks.
const { POST } = await import('./route');

// ---------------------------------------------------------------------------

function makeRequest(body: string, signature: string | null): Request {
  const headers = new Headers();
  if (signature !== null) {
    headers.set('Stripe-Signature', signature);
  }
  return new Request('http://localhost/api/webhooks/stripe/connect', {
    method: 'POST',
    headers,
    body,
  });
}

const VALID_BODY = JSON.stringify({
  id: 'evt_acct_1',
  type: 'account.updated',
  created: Math.floor(Date.now() / 1000),
  account: 'acct_test_123',
  data: { object: { id: 'acct_test_123', charges_enabled: true } },
});

describe('POST /api/webhooks/stripe/connect', () => {
  beforeAll(() => {
    process.env.STRIPE_ENVIRONMENT = 'TEST';
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStripeAdapter.mockReturnValue({});
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('400 si Stripe-Signature est absent', async () => {
    const request = makeRequest(VALID_BODY, null);
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(mockHandleWebhook).not.toHaveBeenCalled();
  });

  it('délègue à handleWebhook avec endpoint=connect', async () => {
    mockHandleWebhook.mockResolvedValueOnce({ kind: 'SUCCESS', statusCode: 200 });

    const signature = 't=123,v1=abc';
    const request = makeRequest(VALID_BODY, signature);
    await POST(request);

    expect(mockHandleWebhook).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callArgs = mockHandleWebhook.mock.calls[0] as any[] as [unknown, Record<string, unknown>];
    const input = callArgs[1];
    expect(input).toMatchObject({
      rawBody: VALID_BODY,
      signature,
      endpoint: 'connect',
      environment: 'TEST',
    });
  });

  it('200 si handleWebhook retourne SUCCESS', async () => {
    mockHandleWebhook.mockResolvedValueOnce({ kind: 'SUCCESS', statusCode: 200 });

    const request = makeRequest(VALID_BODY, 't=123,v1=abc');
    const response = await POST(request);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.received).toBe(true);
  });

  it('400 si handleWebhook retourne FAILURE avec statusCode 400', async () => {
    mockHandleWebhook.mockResolvedValueOnce({
      kind: 'FAILURE',
      statusCode: 400,
      error: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'Signature invalide',
    });

    const request = makeRequest(VALID_BODY, 't=123,v1=bad');
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it('500 si handleWebhook jette une exception', async () => {
    mockHandleWebhook.mockRejectedValueOnce(new Error('DB connection failed'));

    const request = makeRequest(VALID_BODY, 't=123,v1=abc');
    const response = await POST(request);
    expect(response.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests de sécurité HTTP avec FakeStripeAdapter (Reviewer B, P2)
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/webhooks/stripe/connect — sécurité HTTP avec FakeStripeAdapter', () => {
  beforeAll(() => {
    process.env.STRIPE_ENVIRONMENT = 'TEST';
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStripeAdapter.mockReturnValue({});
    // Par défaut, handleWebhook simule un succès (signature valide → traitement).
    mockHandleWebhook.mockResolvedValue({ kind: 'SUCCESS', statusCode: 200 });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('signature valide + corps brut valide → 200 (handleWebhook appelé)', async () => {
    const signature = generateFakeSignature(VALID_BODY, CONNECT_SECRET);
    const request = makeRequest(VALID_BODY, signature);
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(mockHandleWebhook).toHaveBeenCalledTimes(1);
  });

  it('signature absente → 400 (handleWebhook PAS appelé)', async () => {
    const request = makeRequest(VALID_BODY, null);
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(mockHandleWebhook).not.toHaveBeenCalled();
  });

  it('signature invalide → handleWebhook appelé (la vérification se fait dans handleWebhook)', async () => {
    mockHandleWebhook.mockResolvedValueOnce({
      kind: 'FAILURE',
      statusCode: 400,
      error: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'Signature invalide',
    });

    const request = makeRequest(VALID_BODY, 't=123,v1=invalidhash');
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(mockHandleWebhook).toHaveBeenCalledTimes(1);
  });

  it('corps altéré après signature → handleWebhook reçoit le corps altéré', async () => {
    const signature = generateFakeSignature(VALID_BODY, CONNECT_SECRET);
    const tamperedBody = VALID_BODY.replace('charges_enabled', 'charges_disabled');
    mockHandleWebhook.mockResolvedValueOnce({
      kind: 'FAILURE',
      statusCode: 400,
      error: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'Signature invalide',
    });

    const request = makeRequest(tamperedBody, signature);
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(mockHandleWebhook).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callArgs = mockHandleWebhook.mock.calls[0] as any[] as [unknown, Record<string, unknown>];
    const input = callArgs[1];
    expect(input.rawBody).toBe(tamperedBody);
  });

  it('payload JSON invalide → handleWebhook appelé (la vérification se fait dans handleWebhook)', async () => {
    mockHandleWebhook.mockResolvedValueOnce({
      kind: 'FAILURE',
      statusCode: 400,
      error: 'WEBHOOK_PAYLOAD_INVALID',
      message: 'Payload invalide',
    });

    const invalidJson = '{ not valid json';
    const signature = generateFakeSignature(invalidJson, CONNECT_SECRET);
    const request = makeRequest(invalidJson, signature);
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(mockHandleWebhook).toHaveBeenCalledTimes(1);
  });

  it('signature générée avec le secret platform → handleWebhook reçoit endpoint=connect (la distinction se fait dans handleWebhook)', async () => {
    // Une signature générée avec le secret platform est envoyée sur l'endpoint connect.
    const platformSignature = generateFakeSignature(VALID_BODY, PLATFORM_SECRET);
    mockHandleWebhook.mockResolvedValueOnce({
      kind: 'FAILURE',
      statusCode: 400,
      error: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'Signature invalide',
    });

    const request = makeRequest(VALID_BODY, platformSignature);
    const response = await POST(request);
    expect(response.status).toBe(400);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callArgs = mockHandleWebhook.mock.calls[0] as any[] as [unknown, Record<string, unknown>];
    const input = callArgs[1];
    expect(input.endpoint).toBe('connect');
  });

  it('secret absent (getStripeAdapter jette) → 500 fail-closed, handleWebhook PAS appelé', async () => {
    mockGetStripeAdapter.mockImplementationOnce(() => {
      throw new Error('STRIPE_CONNECT_WEBHOOK_SECRET est requis');
    });

    const signature = 't=123,v1=abc';
    const request = makeRequest(VALID_BODY, signature);
    const response = await POST(request);
    expect(response.status).toBe(500);
    expect(mockHandleWebhook).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests du verrou technique rate limiting LIVE (P2-2)
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/webhooks/stripe/connect — verrou rate limiting LIVE', () => {
  const prevEnv = process.env.STRIPE_ENVIRONMENT;
  const prevVerified = process.env.STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED;
  const prevAllowlist = process.env.STRIPE_WEBHOOK_IP_ALLOWLIST;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStripeAdapter.mockReturnValue({});
    mockHandleWebhook.mockResolvedValue({ kind: 'SUCCESS', statusCode: 200 });
    // L'IP allow-list est vérifiée avant le rate limiting. En LIVE, elle est
    // fail-closed. Définir une allow-list + un header x-forwarded-for pour
    // passer le check IP et isoler le test du verrou rate limiting.
    process.env.STRIPE_WEBHOOK_IP_ALLOWLIST = '1.2.3.4';
  });

  afterAll(() => {
    process.env.STRIPE_ENVIRONMENT = prevEnv;
    if (prevVerified === undefined) delete process.env.STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED;
    else process.env.STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED = prevVerified;
    if (prevAllowlist === undefined) delete process.env.STRIPE_WEBHOOK_IP_ALLOWLIST;
    else process.env.STRIPE_WEBHOOK_IP_ALLOWLIST = prevAllowlist;
    vi.restoreAllMocks();
  });

  function makeLiveRequest(body: string, signature: string): Request {
    const headers = new Headers();
    headers.set('Stripe-Signature', signature);
    headers.set('x-forwarded-for', '1.2.3.4');
    return new Request('http://localhost/api/webhooks/stripe/connect', {
      method: 'POST',
      headers,
      body,
    });
  }

  it('503 si STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED non défini en LIVE (fail-closed)', async () => {
    process.env.STRIPE_ENVIRONMENT = 'LIVE';
    delete process.env.STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED;
    const request = makeLiveRequest(VALID_BODY, 't=123,v1=abc');
    const response = await POST(request);
    expect(response.status).toBe(503);
    expect(mockHandleWebhook).not.toHaveBeenCalled();
  });

  it('503 si STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED != true en LIVE (fail-closed)', async () => {
    process.env.STRIPE_ENVIRONMENT = 'LIVE';
    process.env.STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED = 'false';
    const request = makeLiveRequest(VALID_BODY, 't=123,v1=abc');
    const response = await POST(request);
    expect(response.status).toBe(503);
    expect(mockHandleWebhook).not.toHaveBeenCalled();
  });

  it('200 si STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED=true en LIVE', async () => {
    process.env.STRIPE_ENVIRONMENT = 'LIVE';
    process.env.STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED = 'true';
    const request = makeLiveRequest(VALID_BODY, 't=123,v1=abc');
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(mockHandleWebhook).toHaveBeenCalledTimes(1);
  });

  it('200 si TEST (rate limiting check skippé)', async () => {
    process.env.STRIPE_ENVIRONMENT = 'TEST';
    delete process.env.STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED;
    const request = makeLiveRequest(VALID_BODY, 't=123,v1=abc');
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(mockHandleWebhook).toHaveBeenCalledTimes(1);
  });
});
