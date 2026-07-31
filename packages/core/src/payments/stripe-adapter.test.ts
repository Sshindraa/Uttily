import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Tests unitaires de l'adapter Stripe réel (Lot 5, ADR-010).
 *
 * Le SDK Stripe est mocké via vi.mock : aucun appel réseau réel n'est effectué.
 * Les tests vérifient le mapping des paramètres, des statuts, des erreurs,
 * et l'absence de fuite de client_secret dans les logs ou champs persistés.
 */

// Types minimaux pour les mocks — évite l'import du SDK Stripe dans les tests.
interface MockPaymentIntent {
  id: string;
  object: 'payment_intent';
  status: string;
  client_secret: string | null;
  latest_charge: string | null;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
  application_fee_amount?: number | null;
  on_behalf_of?: string | null;
  transfer_data?: { destination: string } | null;
}

interface MockRefund {
  id: string;
  object: 'refund';
  status: string | null;
  amount: number;
  currency: string;
}

interface MockAccount {
  id: string;
  object: 'account';
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  capabilities?: { transfers?: string };
  controller?: Record<string, unknown>;
  requirements?: Record<string, unknown>;
}

interface MockAccountLink {
  object: 'account_link';
  url: string;
  expires_at: number;
}

interface MockEvent {
  id: string;
  object: 'event';
  type: string;
  created: number;
  api_version: string | null;
  account?: string;
  data: { object: { id?: string; [key: string]: unknown } };
}

// Mock du SDK Stripe — défini via vi.hoisted() car vi.mock est hoisté en haut
// du fichier par Vitest, avant l'initialisation des variables de module.
const {
  mockPaymentIntentsCreate,
  mockPaymentIntentsRetrieve,
  mockPaymentIntentsCancel,
  mockRefundsCreate,
  mockRefundsRetrieve,
  mockAccountsCreate,
  mockAccountsRetrieve,
  mockAccountLinksCreate,
  mockConstructEvent,
  MockStripeError,
  MockStripeCardError,
  MockStripeRateLimitError,
  MockStripeAuthenticationError,
  MockStripeInvalidRequestError,
  MockStripeConnectionError,
  MockStripeSignatureVerificationError,
  MockStripePermissionError,
  MockStripeIdempotencyError,
  MockStripeAPIError,
} = vi.hoisted(() => {
  const mockPaymentIntentsCreate = vi.fn();
  const mockPaymentIntentsRetrieve = vi.fn();
  const mockPaymentIntentsCancel = vi.fn();
  const mockRefundsCreate = vi.fn();
  const mockRefundsRetrieve = vi.fn();
  const mockAccountsCreate = vi.fn();
  const mockAccountsRetrieve = vi.fn();
  const mockAccountLinksCreate = vi.fn();
  const mockConstructEvent = vi.fn();

  // Classes d'erreur simulées pour le mapping.
  class MockStripeError extends Error {
    readonly type: string;
    readonly code: string | undefined;
    constructor(type: string, message: string, code?: string) {
      super(message);
      this.name = 'StripeError';
      this.type = type;
      this.code = code;
    }
  }

  class MockStripeCardError extends MockStripeError {
    readonly decline_code: string;
    constructor(message: string, code?: string) {
      super('card_error', message, code);
      this.name = 'StripeCardError';
      this.decline_code = 'card_declined';
    }
  }

  class MockStripeRateLimitError extends MockStripeError {
    constructor(message: string, code?: string) {
      super('rate_limit_error', message, code);
      this.name = 'StripeRateLimitError';
    }
  }

  class MockStripeAuthenticationError extends MockStripeError {
    constructor(message: string, code?: string) {
      super('authentication_error', message, code);
      this.name = 'StripeAuthenticationError';
    }
  }

  class MockStripeInvalidRequestError extends MockStripeError {
    constructor(message: string, code?: string) {
      super('invalid_request_error', message, code);
      this.name = 'StripeInvalidRequestError';
    }
  }

  class MockStripeConnectionError extends MockStripeError {
    constructor(message: string, code?: string) {
      super('api_connection_error', message, code);
      this.name = 'StripeConnectionError';
    }
  }

  class MockStripeSignatureVerificationError extends MockStripeError {
    readonly header: string;
    readonly payload: string;
    constructor(message: string) {
      super('signature_verification_error', message);
      this.name = 'StripeSignatureVerificationError';
      this.header = '';
      this.payload = '';
    }
  }

  class MockStripePermissionError extends MockStripeError {
    constructor(message: string, code?: string) {
      super('permission_error', message, code);
      this.name = 'StripePermissionError';
    }
  }

  class MockStripeIdempotencyError extends MockStripeError {
    constructor(message: string, code?: string) {
      super('idempotency_error', message, code);
      this.name = 'StripeIdempotencyError';
    }
  }

  class MockStripeAPIError extends MockStripeError {
    constructor(message: string, code?: string) {
      super('api_error', message, code);
      this.name = 'StripeAPIError';
    }
  }

  return {
    mockPaymentIntentsCreate,
    mockPaymentIntentsRetrieve,
    mockPaymentIntentsCancel,
    mockRefundsCreate,
    mockRefundsRetrieve,
    mockAccountsCreate,
    mockAccountsRetrieve,
    mockAccountLinksCreate,
    mockConstructEvent,
    MockStripeError,
    MockStripeCardError,
    MockStripeRateLimitError,
    MockStripeAuthenticationError,
    MockStripeInvalidRequestError,
    MockStripeConnectionError,
    MockStripeSignatureVerificationError,
    MockStripePermissionError,
    MockStripeIdempotencyError,
    MockStripeAPIError,
  };
});

vi.mock('stripe', () => {
  const Stripe = vi.fn().mockImplementation(() => ({
    paymentIntents: {
      create: mockPaymentIntentsCreate,
      retrieve: mockPaymentIntentsRetrieve,
      cancel: mockPaymentIntentsCancel,
    },
    refunds: {
      create: mockRefundsCreate,
      retrieve: mockRefundsRetrieve,
    },
    accounts: {
      create: mockAccountsCreate,
      retrieve: mockAccountsRetrieve,
    },
    accountLinks: {
      create: mockAccountLinksCreate,
    },
    webhooks: {
      constructEvent: mockConstructEvent,
    },
  }));

  // Attacher les classes d'erreur sur le constructeur, comme le fait le SDK réel.
  (Stripe as unknown as { errors: Record<string, unknown> }).errors = {
    StripeError: MockStripeError,
    StripeCardError: MockStripeCardError,
    StripeRateLimitError: MockStripeRateLimitError,
    StripeAuthenticationError: MockStripeAuthenticationError,
    StripeInvalidRequestError: MockStripeInvalidRequestError,
    StripeConnectionError: MockStripeConnectionError,
    StripeSignatureVerificationError: MockStripeSignatureVerificationError,
    StripePermissionError: MockStripePermissionError,
    StripeIdempotencyError: MockStripeIdempotencyError,
    StripeAPIError: MockStripeAPIError,
  };

  // ApiVersion et LatestApiVersion pour le typage.
  (Stripe as unknown as { ApiVersion: string }).ApiVersion = '2026-06-24.dahlia';
  (Stripe as unknown as { LatestApiVersion: string }).LatestApiVersion = '2026-06-24.dahlia';

  return { default: Stripe };
});

// Importer après le mock.
import { StripeAdapter, PINNED_STRIPE_API_VERSION } from './stripe-adapter';
import { PaymentProviderError } from './errors';
import type {
  CreatePaymentIntentParams,
  CreateRefundParams,
  CreateConnectedAccountParams,
  CreateOnboardingLinkParams,
} from './types';

/**
 * Fixtures de test uniquement.
 */
const BASE_CONFIG = {
  secretKey: 'sk_test_fake_key',
  platformWebhookSecret: 'whsec_platform_fake',
  connectWebhookSecret: 'whsec_connect_fake',
  environment: 'TEST' as const,
  apiVersion: PINNED_STRIPE_API_VERSION,
};

function baseCreatePaymentIntentParams(
  overrides: Partial<CreatePaymentIntentParams> = {},
): CreatePaymentIntentParams {
  return {
    amountMinor: 10000,
    currency: 'EUR',
    connectedAccountId: 'acct_connected_123',
    applicationFeeAmountMinor: 500,
    onBehalfOfAccountId: null,
    idempotencyKey: 'idem_key_abc123',
    metadata: {
      payment_id: 'pay_123',
      payment_attempt_id: 'att_123',
      draft_id: 'draft_123',
      organization_id: 'org_123',
      protocol_version: 'v1',
    },
    ...overrides,
  };
}

function baseCreateRefundParams(overrides: Partial<CreateRefundParams> = {}): CreateRefundParams {
  return {
    paymentIntentId: 'pi_123',
    amountMinor: 10000,
    idempotencyKey: 'idem_refund_abc',
    reverseTransfer: true,
    refundApplicationFee: true,
    ...overrides,
  };
}

function baseCreateConnectedAccountParams(
  overrides: Partial<CreateConnectedAccountParams> = {},
): CreateConnectedAccountParams {
  return {
    organizationId: 'org_123',
    environment: 'TEST' as const,
    country: 'FR',
    controller: {
      feesPayer: 'PLATFORM' as const,
      lossesCollector: 'PLATFORM' as const,
      stripeDashboard: 'NONE' as const,
      requirementCollection: 'PLATFORM' as const,
    },
    idempotencyKey: 'idem_acct_abc',
    ...overrides,
  };
}

function makeMockPaymentIntent(overrides: Partial<MockPaymentIntent> = {}): MockPaymentIntent {
  return {
    id: 'pi_fake_123',
    object: 'payment_intent',
    status: 'requires_payment_method',
    client_secret: 'pi_fake_123_secret_abc',
    latest_charge: null,
    amount: 10000,
    currency: 'eur',
    metadata: {},
    application_fee_amount: null,
    on_behalf_of: null,
    transfer_data: { destination: 'acct_connected_123' },
    ...overrides,
  };
}

function makeMockRefund(overrides: Partial<MockRefund> = {}): MockRefund {
  return {
    id: 're_fake_123',
    object: 'refund',
    status: 'succeeded',
    amount: 10000,
    currency: 'eur',
    ...overrides,
  };
}

function makeMockAccount(overrides: Partial<MockAccount> = {}): MockAccount {
  return {
    id: 'acct_fake_123',
    object: 'account',
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: false,
    capabilities: { transfers: 'pending' },
    controller: {},
    requirements: {},
    ...overrides,
  };
}

function makeMockAccountLink(overrides: Partial<MockAccountLink> = {}): MockAccountLink {
  return {
    object: 'account_link',
    url: 'https://connect.stripe.com/onboarding/link_123',
    expires_at: Math.floor(Date.now() / 1000) + 86400,
    ...overrides,
  };
}

function makeMockEvent(overrides: Partial<MockEvent> = {}): MockEvent {
  return {
    id: 'evt_fake_123',
    object: 'event',
    type: 'payment_intent.succeeded',
    created: Math.floor(Date.now() / 1000),
    api_version: '2026-06-24.dahlia',
    data: { object: { id: 'pi_fake_123', status: 'succeeded', amount: 10000 } },
    ...overrides,
  };
}

describe('StripeAdapter', () => {
  let adapter: StripeAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new StripeAdapter(BASE_CONFIG);
  });

  describe('constructor environment validation', () => {
    it('rejette une clé sk_live_ en environnement TEST', () => {
      expect(() => new StripeAdapter({ ...BASE_CONFIG, secretKey: 'sk_live_fake' })).toThrow();
    });
    it('rejette une clé sk_test_ en environnement LIVE', () => {
      expect(
        () => new StripeAdapter({ ...BASE_CONFIG, secretKey: 'sk_test_fake', environment: 'LIVE' }),
      ).toThrow();
    });
    it('accepte une clé sk_test_ en environnement TEST', () => {
      expect(() => new StripeAdapter(BASE_CONFIG)).not.toThrow();
    });
  });

  describe('createPaymentIntent', () => {
    it('crée un PaymentIntent avec les paramètres corrects', async () => {
      const mockIntent = makeMockPaymentIntent({
        status: 'requires_payment_method',
        client_secret: 'pi_test_secret_123',
      });
      mockPaymentIntentsCreate.mockResolvedValue(mockIntent);

      const params = baseCreatePaymentIntentParams();
      const result = await adapter.createPaymentIntent(params);

      expect(result.id).toBe('pi_fake_123');
      expect(result.status).toBe('requires_payment_method');
      expect(result.clientSecret).toBe('pi_test_secret_123');
      expect(result.amountMinor).toBe(10000);
      expect(result.currency).toBe('EUR');
      expect(result.latestChargeId).toBeNull();
      // Nouveaux champs PaymentIntentResult (ADR-010 §5).
      expect(result.environment).toBe('TEST');
      expect(result.connectedAccountId).toBe('acct_connected_123');
      expect(result.applicationFeeAmountMinor).toBeNull();
      expect(result.onBehalfOfAccountId).toBeNull();

      // Vérifier les paramètres passés à Stripe.
      expect(mockPaymentIntentsCreate).toHaveBeenCalledTimes(1);
      const [createParams, options] = mockPaymentIntentsCreate.mock.calls[0]!;
      expect(createParams.amount).toBe(10000);
      expect(createParams.currency).toBe('eur');
      expect(createParams.capture_method).toBe('automatic');
      expect(createParams.payment_method_types).toEqual(['card']);
      expect(createParams.transfer_data).toEqual({ destination: 'acct_connected_123' });
      expect(createParams.application_fee_amount).toBe(500);
      expect(createParams.on_behalf_of).toBeUndefined();
      expect(createParams.metadata).toEqual(params.metadata);
      expect(options.idempotencyKey).toBe('idem_key_abc123');
    });

    it("omet application_fee_amount lorsqu'il vaut 0", async () => {
      const mockIntent = makeMockPaymentIntent();
      mockPaymentIntentsCreate.mockResolvedValue(mockIntent);

      await adapter.createPaymentIntent(
        baseCreatePaymentIntentParams({ applicationFeeAmountMinor: 0 }),
      );

      const [createParams] = mockPaymentIntentsCreate.mock.calls[0]!;
      expect(createParams.application_fee_amount).toBeUndefined();
    });

    it("omet application_fee_amount lorsqu'il est null", async () => {
      const mockIntent = makeMockPaymentIntent();
      mockPaymentIntentsCreate.mockResolvedValue(mockIntent);

      await adapter.createPaymentIntent(
        baseCreatePaymentIntentParams({ applicationFeeAmountMinor: null }),
      );

      const [createParams] = mockPaymentIntentsCreate.mock.calls[0]!;
      expect(createParams.application_fee_amount).toBeUndefined();
    });

    it("inclut on_behalf_of lorsqu'il est non null", async () => {
      const mockIntent = makeMockPaymentIntent();
      mockPaymentIntentsCreate.mockResolvedValue(mockIntent);

      await adapter.createPaymentIntent(
        baseCreatePaymentIntentParams({ onBehalfOfAccountId: 'acct_on_behalf_456' }),
      );

      const [createParams] = mockPaymentIntentsCreate.mock.calls[0]!;
      expect(createParams.on_behalf_of).toBe('acct_on_behalf_456');
    });

    it('rejette un montant de 0', async () => {
      await expect(
        adapter.createPaymentIntent(baseCreatePaymentIntentParams({ amountMinor: 0 })),
      ).rejects.toThrow(PaymentProviderError);

      try {
        await adapter.createPaymentIntent(baseCreatePaymentIntentParams({ amountMinor: 0 }));
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('VALIDATION');
        expect(err.providerErrorCode).toBe('invalid_amount');
      }
    });

    it('rejette une commission supérieure au montant total', async () => {
      await expect(
        adapter.createPaymentIntent(
          baseCreatePaymentIntentParams({ amountMinor: 100, applicationFeeAmountMinor: 500 }),
        ),
      ).rejects.toThrow(PaymentProviderError);

      try {
        await adapter.createPaymentIntent(
          baseCreatePaymentIntentParams({ amountMinor: 100, applicationFeeAmountMinor: 500 }),
        );
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('VALIDATION');
        expect(err.providerErrorCode).toBe('invalid_application_fee');
      }
    });

    it('rejette une metadata avec une clé manquante', async () => {
      const params = baseCreatePaymentIntentParams({
        metadata: {
          payment_id: 'pay_123',
          payment_attempt_id: 'att_123',
          draft_id: 'draft_123',
          organization_id: 'org_123',
          protocol_version: '',
        },
      });

      await expect(adapter.createPaymentIntent(params)).rejects.toThrow(PaymentProviderError);

      try {
        await adapter.createPaymentIntent(params);
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('VALIDATION');
        expect(err.providerErrorCode).toBe('invalid_metadata');
      }
    });

    it('mappe correctement le statut succeeded', async () => {
      const mockIntent = makeMockPaymentIntent({
        status: 'succeeded',
        latest_charge: 'ch_fake_123',
      });
      mockPaymentIntentsCreate.mockResolvedValue(mockIntent);

      const result = await adapter.createPaymentIntent(baseCreatePaymentIntentParams());

      expect(result.status).toBe('succeeded');
      expect(result.latestChargeId).toBe('ch_fake_123');
    });

    it('mappe correctement le statut processing', async () => {
      const mockIntent = makeMockPaymentIntent({ status: 'processing' });
      mockPaymentIntentsCreate.mockResolvedValue(mockIntent);

      const result = await adapter.createPaymentIntent(baseCreatePaymentIntentParams());

      expect(result.status).toBe('processing');
    });

    it('mappe correctement le statut canceled', async () => {
      const mockIntent = makeMockPaymentIntent({ status: 'canceled' });
      mockPaymentIntentsCreate.mockResolvedValue(mockIntent);

      const result = await adapter.createPaymentIntent(baseCreatePaymentIntentParams());

      expect(result.status).toBe('canceled');
    });

    it('mappe correctement le statut requires_action', async () => {
      const mockIntent = makeMockPaymentIntent({ status: 'requires_action' });
      mockPaymentIntentsCreate.mockResolvedValue(mockIntent);

      const result = await adapter.createPaymentIntent(baseCreatePaymentIntentParams());

      expect(result.status).toBe('requires_action');
    });

    it('lève UNSUPPORTED_PROVIDER_STATE pour requires_confirmation', async () => {
      const mockIntent = makeMockPaymentIntent({ status: 'requires_confirmation' });
      mockPaymentIntentsCreate.mockResolvedValue(mockIntent);

      await expect(adapter.createPaymentIntent(baseCreatePaymentIntentParams())).rejects.toThrow(
        PaymentProviderError,
      );

      try {
        await adapter.createPaymentIntent(baseCreatePaymentIntentParams());
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('UNSUPPORTED_PROVIDER_STATE');
      }
    });

    it('lève UNSUPPORTED_PROVIDER_STATE pour requires_capture', async () => {
      const mockIntent = makeMockPaymentIntent({ status: 'requires_capture' });
      mockPaymentIntentsCreate.mockResolvedValue(mockIntent);

      await expect(adapter.createPaymentIntent(baseCreatePaymentIntentParams())).rejects.toThrow(
        PaymentProviderError,
      );

      try {
        await adapter.createPaymentIntent(baseCreatePaymentIntentParams());
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('UNSUPPORTED_PROVIDER_STATE');
      }
    });

    it('gère les erreurs Stripe card_declined → PaymentProviderError(VALIDATION)', async () => {
      const error = new MockStripeCardError('Your card was declined', 'card_declined');
      mockPaymentIntentsCreate.mockRejectedValue(error);

      await expect(adapter.createPaymentIntent(baseCreatePaymentIntentParams())).rejects.toThrow(
        PaymentProviderError,
      );

      try {
        await adapter.createPaymentIntent(baseCreatePaymentIntentParams());
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('VALIDATION');
        expect(err.providerErrorCode).toBe('card_declined');
      }
    });

    it('gère les erreurs rate_limit → PaymentProviderError(UNKNOWN)', async () => {
      const error = new MockStripeRateLimitError('Rate limited', 'rate_limit');
      mockPaymentIntentsCreate.mockRejectedValue(error);

      try {
        await adapter.createPaymentIntent(baseCreatePaymentIntentParams());
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('UNKNOWN');
        expect(err.providerErrorCode).toBe('rate_limit');
      }
    });

    it('gère les erreurs authentication → PaymentProviderError(UNAUTHENTICATED)', async () => {
      const error = new MockStripeAuthenticationError('Invalid API key', 'authentication_error');
      mockPaymentIntentsCreate.mockRejectedValue(error);

      try {
        await adapter.createPaymentIntent(baseCreatePaymentIntentParams());
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('UNAUTHENTICATED');
        expect(err.providerErrorCode).toBe('authentication_error');
      }
    });

    it('gère les erreurs invalid_request → PaymentProviderError(VALIDATION)', async () => {
      const error = new MockStripeInvalidRequestError('Invalid param', 'invalid_request_error');
      mockPaymentIntentsCreate.mockRejectedValue(error);

      try {
        await adapter.createPaymentIntent(baseCreatePaymentIntentParams());
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('VALIDATION');
        expect(err.providerErrorCode).toBe('invalid_request_error');
      }
    });

    it('gère les erreurs api_connection → PaymentProviderError(UNKNOWN)', async () => {
      const error = new MockStripeConnectionError('Network error', 'api_connection_error');
      mockPaymentIntentsCreate.mockRejectedValue(error);

      try {
        await adapter.createPaymentIntent(baseCreatePaymentIntentParams());
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('UNKNOWN');
        expect(err.providerErrorCode).toBe('api_connection_error');
      }
    });

    it('gère les erreurs permission → PaymentProviderError(FORBIDDEN)', async () => {
      const error = new MockStripePermissionError('Forbidden', 'permission_error');
      mockPaymentIntentsCreate.mockRejectedValue(error);

      try {
        await adapter.createPaymentIntent(baseCreatePaymentIntentParams());
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('FORBIDDEN');
        expect(err.providerErrorCode).toBe('permission_error');
      }
    });

    it('gère les erreurs idempotency → PaymentProviderError(CONFLICT_IDEMPOTENCY)', async () => {
      const error = new MockStripeIdempotencyError('Idempotency conflict', 'idempotency_error');
      mockPaymentIntentsCreate.mockRejectedValue(error);

      try {
        await adapter.createPaymentIntent(baseCreatePaymentIntentParams());
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('CONFLICT_IDEMPOTENCY');
        expect(err.providerErrorCode).toBe('idempotency_error');
      }
    });

    it('ne contient pas de client_secret dans les paramètres envoyés à Stripe', async () => {
      const mockIntent = makeMockPaymentIntent();
      mockPaymentIntentsCreate.mockResolvedValue(mockIntent);

      await adapter.createPaymentIntent(baseCreatePaymentIntentParams());

      const [createParams] = mockPaymentIntentsCreate.mock.calls[0]!;
      expect(createParams.client_secret).toBeUndefined();
    });
  });

  describe('retrievePaymentIntent', () => {
    it('récupère un PaymentIntent sans header stripeAccount', async () => {
      const mockIntent = makeMockPaymentIntent({ status: 'succeeded', latest_charge: 'ch_123' });
      mockPaymentIntentsRetrieve.mockResolvedValue(mockIntent);

      const result = await adapter.retrievePaymentIntent('pi_123');

      expect(result.id).toBe('pi_fake_123');
      expect(result.status).toBe('succeeded');
      expect(result.latestChargeId).toBe('ch_123');
      // Nouveaux champs PaymentIntentResult (ADR-010 §5).
      expect(result.environment).toBe('TEST');
      expect(result.connectedAccountId).toBe('acct_connected_123');
      expect(result.applicationFeeAmountMinor).toBeNull();
      expect(result.onBehalfOfAccountId).toBeNull();

      expect(mockPaymentIntentsRetrieve).toHaveBeenCalledTimes(1);
      const [id] = mockPaymentIntentsRetrieve.mock.calls[0]!;
      expect(id).toBe('pi_123');
      // Aucun header stripeAccount ne doit être passé.
      const callArgs = mockPaymentIntentsRetrieve.mock.calls[0]!;
      expect(callArgs[2]).toBeUndefined();
    });

    it('gère les erreurs de récupération', async () => {
      const error = new MockStripeInvalidRequestError('Not found', 'resource_missing');
      mockPaymentIntentsRetrieve.mockRejectedValue(error);

      await expect(adapter.retrievePaymentIntent('pi_missing')).rejects.toThrow(
        PaymentProviderError,
      );
    });

    it('renvoie connectedAccountId null lorsque transfer_data est absent', async () => {
      const mockIntent = makeMockPaymentIntent({
        status: 'succeeded',
        transfer_data: null,
      });
      mockPaymentIntentsRetrieve.mockResolvedValue(mockIntent);

      const result = await adapter.retrievePaymentIntent('pi_123');

      expect(result.connectedAccountId).toBeNull();
      expect(result.environment).toBe('TEST');
      expect(result.applicationFeeAmountMinor).toBeNull();
      expect(result.onBehalfOfAccountId).toBeNull();
    });
  });

  describe('cancelPaymentIntent', () => {
    it("annule un PaymentIntent avec clé d'idempotence", async () => {
      const mockIntent = makeMockPaymentIntent({ status: 'canceled' });
      mockPaymentIntentsCancel.mockResolvedValue(mockIntent);

      const result = await adapter.cancelPaymentIntent({
        id: 'pi_123',
        idempotencyKey: 'idem_cancel_abc',
      });

      expect(result.status).toBe('canceled');
      expect(mockPaymentIntentsCancel).toHaveBeenCalledTimes(1);
      const [id] = mockPaymentIntentsCancel.mock.calls[0]!;
      expect(id).toBe('pi_123');
      // L'idempotencyKey doit être passée dans les options.
      const callArgs = mockPaymentIntentsCancel.mock.calls[0]!;
      expect(callArgs[2]).toEqual({ idempotencyKey: 'idem_cancel_abc' });
    });

    it('rejette un id vide avec VALIDATION', async () => {
      await expect(
        adapter.cancelPaymentIntent({ id: '', idempotencyKey: 'idem_cancel_abc' }),
      ).rejects.toThrow(PaymentProviderError);

      try {
        await adapter.cancelPaymentIntent({ id: '', idempotencyKey: 'idem_cancel_abc' });
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('VALIDATION');
        expect(err.providerErrorCode).toBe('invalid_id');
      }
    });

    it("rejette une clé d'idempotence vide avec VALIDATION", async () => {
      await expect(
        adapter.cancelPaymentIntent({ id: 'pi_123', idempotencyKey: '' }),
      ).rejects.toThrow(PaymentProviderError);

      try {
        await adapter.cancelPaymentIntent({ id: 'pi_123', idempotencyKey: '' });
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('VALIDATION');
        expect(err.providerErrorCode).toBe('invalid_idempotency_key');
      }
    });
  });

  describe('createRefund', () => {
    it('crée un refund avec reverse_transfer et refund_application_fee', async () => {
      const mockRefund = makeMockRefund();
      mockRefundsCreate.mockResolvedValue(mockRefund);

      const params = baseCreateRefundParams();
      const result = await adapter.createRefund(params);

      expect(result.id).toBe('re_fake_123');
      expect(result.status).toBe('succeeded');
      expect(result.amountMinor).toBe(10000);
      expect(result.currency).toBe('EUR');

      expect(mockRefundsCreate).toHaveBeenCalledTimes(1);
      const [createParams, options] = mockRefundsCreate.mock.calls[0]!;
      expect(createParams.payment_intent).toBe('pi_123');
      expect(createParams.amount).toBe(10000);
      expect(createParams.reverse_transfer).toBe(true);
      expect(createParams.refund_application_fee).toBe(true);
      expect(options.idempotencyKey).toBe('idem_refund_abc');
    });

    it('mappe correctement le statut pending', async () => {
      const mockRefund = makeMockRefund({ status: 'pending' });
      mockRefundsCreate.mockResolvedValue(mockRefund);

      const result = await adapter.createRefund(baseCreateRefundParams());

      expect(result.status).toBe('pending');
    });

    it('mappe correctement le statut failed', async () => {
      const mockRefund = makeMockRefund({ status: 'failed' });
      mockRefundsCreate.mockResolvedValue(mockRefund);

      const result = await adapter.createRefund(baseCreateRefundParams());

      expect(result.status).toBe('failed');
    });

    it('gère les erreurs de refund', async () => {
      const error = new MockStripeCardError('Refund failed', 'refund_failed');
      mockRefundsCreate.mockRejectedValue(error);

      await expect(adapter.createRefund(baseCreateRefundParams())).rejects.toThrow(
        PaymentProviderError,
      );
    });

    it('mapRefundStatus lève UNSUPPORTED_PROVIDER_STATE pour un statut inconnu', async () => {
      const mockRefund = makeMockRefund({ status: 'unknown_refund_status' });
      mockRefundsCreate.mockResolvedValue(mockRefund);

      await expect(adapter.createRefund(baseCreateRefundParams())).rejects.toThrow(
        PaymentProviderError,
      );

      try {
        await adapter.createRefund(baseCreateRefundParams());
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('UNSUPPORTED_PROVIDER_STATE');
      }
    });

    it('lève UNSUPPORTED_PROVIDER_STATE pour un refund avec status null', async () => {
      const mockRefund = makeMockRefund({ status: null });
      mockRefundsCreate.mockResolvedValue(mockRefund);

      await expect(adapter.createRefund(baseCreateRefundParams())).rejects.toThrow(
        PaymentProviderError,
      );

      try {
        await adapter.createRefund(baseCreateRefundParams());
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('UNSUPPORTED_PROVIDER_STATE');
      }
    });
  });

  describe('retrieveRefund', () => {
    it('récupère un refund existant', async () => {
      const mockRefund = makeMockRefund({ status: 'succeeded' });
      mockRefundsRetrieve.mockResolvedValue(mockRefund);

      const result = await adapter.retrieveRefund('re_123');

      expect(result.id).toBe('re_fake_123');
      expect(result.status).toBe('succeeded');
      expect(mockRefundsRetrieve).toHaveBeenCalledTimes(1);
    });

    it('lève UNSUPPORTED_PROVIDER_STATE pour un statut null', async () => {
      const mockRefund = makeMockRefund({ status: null as unknown as string });
      mockRefundsRetrieve.mockResolvedValue(mockRefund);

      await expect(adapter.retrieveRefund('re_123')).rejects.toThrow(PaymentProviderError);

      try {
        await adapter.retrieveRefund('re_123');
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('UNSUPPORTED_PROVIDER_STATE');
      }
    });
  });

  describe('verifyWebhook', () => {
    it('vérifie un webhook avec une signature valide → VerifiedWebhookEvent', async () => {
      const mockEvent = makeMockEvent();
      mockConstructEvent.mockReturnValue(mockEvent);

      const result = await adapter.verifyWebhook({
        rawBody: '{"id":"evt_123","type":"payment_intent.succeeded"}',
        signature: 't=1234567890,v1=fake_signature',
        endpoint: 'platform',
        environment: 'TEST',
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.event.id).toBe('evt_fake_123');
        expect(result.event.type).toBe('payment_intent.succeeded');
        expect(result.event.objectId).toBe('pi_fake_123');
        expect(result.event.apiVersion).toBe('2026-06-24.dahlia');
      }

      // Vérifier que le bon secret est utilisé.
      expect(mockConstructEvent).toHaveBeenCalledTimes(1);
      const [, , secret] = mockConstructEvent.mock.calls[0]!;
      expect(secret).toBe('whsec_platform_fake');
    });

    it("utilise le secret connect pour l'endpoint connect", async () => {
      const mockEvent = makeMockEvent();
      mockConstructEvent.mockReturnValue(mockEvent);

      await adapter.verifyWebhook({
        rawBody: '{"id":"evt_123"}',
        signature: 't=123,v1=fake',
        endpoint: 'connect',
        environment: 'TEST',
      });

      const [, , secret] = mockConstructEvent.mock.calls[0]!;
      expect(secret).toBe('whsec_connect_fake');
    });

    it('exclut les données de carte de la normalisation webhook', async () => {
      const mockEvent = {
        id: 'evt_123',
        object: 'event' as const,
        type: 'payment_intent.succeeded',
        created: Math.floor(Date.now() / 1000),
        api_version: '2026-06-24.dahlia',
        data: {
          object: {
            id: 'pi_123',
            object: 'payment_intent',
            status: 'succeeded',
            amount: 10000,
            currency: 'eur',
            metadata: {
              payment_id: 'pay_123',
              payment_attempt_id: 'att_123',
              draft_id: 'draft_123',
              organization_id: 'org_123',
              protocol_version: 'v1',
              // Champs non autorisés qui ne doivent PAS être dans la normalisation
              extra_key: 'should_not_be_copied',
              last4: '4242',
            },
            // Champs sensibles qui ne doivent PAS être dans la normalisation
            last4: '4242',
            brand: 'visa',
            fingerprint: 'abc123',
            payment_method: 'pm_123',
          },
        },
      };
      mockConstructEvent.mockReturnValue(mockEvent);

      const result = await adapter.verifyWebhook({
        rawBody: '{"id":"evt_123"}',
        signature: 't=123,v1=fake',
        endpoint: 'platform',
        environment: 'TEST',
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.event.data).not.toHaveProperty('last4');
        expect(result.event.data).not.toHaveProperty('brand');
        expect(result.event.data).not.toHaveProperty('fingerprint');
        expect(result.event.data).not.toHaveProperty('payment_method');
        expect(result.event.data).toHaveProperty('id', 'pi_123');
        expect(result.event.data).toHaveProperty('status', 'succeeded');
        expect(result.event.data).toHaveProperty('amount', 10000);
        // La metadata ne doit contenir que les 5 clés autorisées.
        const metadata = result.event.data.metadata as Record<string, string>;
        expect(metadata).toHaveProperty('payment_id', 'pay_123');
        expect(metadata).toHaveProperty('payment_attempt_id', 'att_123');
        expect(metadata).toHaveProperty('draft_id', 'draft_123');
        expect(metadata).toHaveProperty('organization_id', 'org_123');
        expect(metadata).toHaveProperty('protocol_version', 'v1');
        expect(metadata).not.toHaveProperty('extra_key');
      }
    });

    it('retourne INVALID_SIGNATURE pour une signature invalide', async () => {
      const error = new MockStripeSignatureVerificationError(
        'No signatures found matching the expected signature for payload',
      );
      mockConstructEvent.mockImplementation(() => {
        throw error;
      });

      const result = await adapter.verifyWebhook({
        rawBody: '{"id":"evt_123"}',
        signature: 't=123,v1=invalid',
        endpoint: 'platform',
        environment: 'TEST',
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('INVALID_SIGNATURE');
      }
    });

    it('retourne INVALID_TIMESTAMP pour un timestamp expiré', async () => {
      const error = new MockStripeSignatureVerificationError(
        'Timestamp outside the tolerance zone',
      );
      mockConstructEvent.mockImplementation(() => {
        throw error;
      });

      const result = await adapter.verifyWebhook({
        rawBody: '{"id":"evt_123"}',
        signature: 't=123,v1=invalid',
        endpoint: 'platform',
        environment: 'TEST',
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('INVALID_TIMESTAMP');
      }
    });

    it('retourne INVALID_PAYLOAD pour une erreur non-signature', async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error('Unexpected JSON parse error');
      });

      const result = await adapter.verifyWebhook({
        rawBody: 'invalid json',
        signature: 't=123,v1=fake',
        endpoint: 'platform',
        environment: 'TEST',
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('INVALID_PAYLOAD');
      }
    });

    // P1-3 : Le vrai adapter ne doit pas filtrer les éléments
    // non-objets de refunds.data. Un payload contenant [refundValide, null]
    // doit conserver l'élément null pour que projectRefundStatus lève
    // REFUND_OBJECT_INVALID dans le savepoint. Ce test contractuel empêche
    // une régression divergence avec le fake adapter.
    it('préserve les éléments null dans refunds.data (ne filtre pas — P1-3)', async () => {
      const mockEvent = {
        id: 'evt_refund_null_element',
        object: 'event' as const,
        type: 'charge.refunded',
        created: Math.floor(Date.now() / 1000),
        api_version: '2026-06-24.dahlia',
        data: {
          object: {
            id: 'ch_test_null_element',
            object: 'charge',
            payment_intent: 'pi_123',
            amount_refunded: 5000,
            refunds: {
              object: 'list',
              data: [
                {
                  id: 're_valid',
                  object: 'refund',
                  status: 'succeeded',
                  amount: 5000,
                  payment_intent: 'pi_123',
                  currency: 'eur',
                },
                null, // Élément mal formé — ne doit pas être filtré
              ],
              has_more: false,
            },
          },
        },
      };
      mockConstructEvent.mockReturnValue(mockEvent);

      const result = await adapter.verifyWebhook({
        rawBody: '{"id":"evt_refund_null_element"}',
        signature: 't=123,v1=fake',
        endpoint: 'platform',
        environment: 'TEST',
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        const data = result.event.data as Record<string, unknown>;
        const refunds = data.refunds as Record<string, unknown>;
        const refundList = refunds.data as unknown[];
        // L'élément null doit être conservé (pas filtré).
        expect(refundList).toHaveLength(2);
        expect(refundList[0]).not.toBeNull();
        expect(refundList[1]).toBeNull();
      }
    });
  });

  describe('createConnectedAccount', () => {
    it('crée un compte avec controller properties (pas type express/custom)', async () => {
      const mockAccount = makeMockAccount();
      mockAccountsCreate.mockResolvedValue(mockAccount);

      const result = await adapter.createConnectedAccount(baseCreateConnectedAccountParams());

      expect(result.id).toBe('acct_fake_123');
      expect(result.apiGeneration).toBe('ACCOUNTS_V1_CONTROLLER_PROPERTIES');

      const [createParams, options] = mockAccountsCreate.mock.calls[0]!;
      // Ne doit PAS contenir type: 'express' ou 'custom'.
      expect(createParams.type).toBeUndefined();
      // Doit contenir controller properties.
      expect(createParams.controller).toBeDefined();
      expect(createParams.controller.fees).toEqual({ payer: 'application' });
      expect(createParams.controller.losses).toEqual({ payments: 'application' });
      expect(createParams.controller.stripe_dashboard).toEqual({ type: 'none' });
      expect(createParams.controller.requirement_collection).toBe('application');
      expect(createParams.country).toBe('FR');
      expect(createParams.metadata).toEqual({
        organization_id: 'org_123',
        environment: 'TEST',
      });
      // L'idempotencyKey doit être passée.
      expect(options.idempotencyKey).toBe('idem_acct_abc');
    });

    it('utilise toujours ACCOUNTS_V1_CONTROLLER_PROPERTIES', async () => {
      const mockAccount = makeMockAccount();
      mockAccountsCreate.mockResolvedValue(mockAccount);

      const result = await adapter.createConnectedAccount(baseCreateConnectedAccountParams());

      expect(result.apiGeneration).toBe('ACCOUNTS_V1_CONTROLLER_PROPERTIES');
    });

    it('mappe correctement les capacités', async () => {
      const mockAccount = makeMockAccount({
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: { transfers: 'active' },
        details_submitted: true,
      });
      mockAccountsCreate.mockResolvedValue(mockAccount);

      const result = await adapter.createConnectedAccount(baseCreateConnectedAccountParams());

      expect(result.chargesEnabled).toBe(true);
      expect(result.payoutsEnabled).toBe(true);
      expect(result.transfersCapabilityStatus).toBe('ACTIVE');
      expect(result.onboardingStatus).toBe('COMPLETE');
    });

    it('mappe transfers capability pending', async () => {
      const mockAccount = makeMockAccount({
        capabilities: { transfers: 'pending' },
      });
      mockAccountsCreate.mockResolvedValue(mockAccount);

      const result = await adapter.createConnectedAccount(baseCreateConnectedAccountParams());

      expect(result.transfersCapabilityStatus).toBe('PENDING');
    });

    it('mappe transfers capability inactive', async () => {
      const mockAccount = makeMockAccount({
        capabilities: { transfers: 'inactive' },
      });
      mockAccountsCreate.mockResolvedValue(mockAccount);

      const result = await adapter.createConnectedAccount(baseCreateConnectedAccountParams());

      expect(result.transfersCapabilityStatus).toBe('INACTIVE');
    });

    it('mappe transfers capability absente → UNREQUESTED', async () => {
      const mockAccount = makeMockAccount({
        capabilities: {},
      });
      mockAccountsCreate.mockResolvedValue(mockAccount);

      const result = await adapter.createConnectedAccount(baseCreateConnectedAccountParams());

      expect(result.transfersCapabilityStatus).toBe('UNREQUESTED');
    });

    it('accepte le preset STANDARD (CONNECTED_ACCOUNT/STRIPE/FULL/STRIPE)', async () => {
      const mockAccount = makeMockAccount();
      mockAccountsCreate.mockResolvedValue(mockAccount);

      const result = await adapter.createConnectedAccount(
        baseCreateConnectedAccountParams({
          controller: {
            feesPayer: 'CONNECTED_ACCOUNT',
            lossesCollector: 'STRIPE',
            stripeDashboard: 'FULL',
            requirementCollection: 'STRIPE',
          },
        }),
      );

      expect(result.id).toBe('acct_fake_123');
    });

    it('accepte le preset EXPRESS (PLATFORM/PLATFORM/EXPRESS/STRIPE)', async () => {
      const mockAccount = makeMockAccount();
      mockAccountsCreate.mockResolvedValue(mockAccount);

      const result = await adapter.createConnectedAccount(
        baseCreateConnectedAccountParams({
          controller: {
            feesPayer: 'PLATFORM',
            lossesCollector: 'PLATFORM',
            stripeDashboard: 'EXPRESS',
            requirementCollection: 'STRIPE',
          },
        }),
      );

      expect(result.id).toBe('acct_fake_123');
    });

    it('accepte le preset CUSTOM (PLATFORM/PLATFORM/NONE/PLATFORM)', async () => {
      const mockAccount = makeMockAccount();
      mockAccountsCreate.mockResolvedValue(mockAccount);

      const result = await adapter.createConnectedAccount(
        baseCreateConnectedAccountParams({
          controller: {
            feesPayer: 'PLATFORM',
            lossesCollector: 'PLATFORM',
            stripeDashboard: 'NONE',
            requirementCollection: 'PLATFORM',
          },
        }),
      );

      expect(result.id).toBe('acct_fake_123');
    });

    it('accepte la configuration hybride CONNECTED_ACCOUNT/STRIPE/NONE/STRIPE', async () => {
      const mockAccount = makeMockAccount();
      mockAccountsCreate.mockResolvedValue(mockAccount);

      const result = await adapter.createConnectedAccount(
        baseCreateConnectedAccountParams({
          controller: {
            feesPayer: 'CONNECTED_ACCOUNT',
            lossesCollector: 'STRIPE',
            stripeDashboard: 'NONE',
            requirementCollection: 'STRIPE',
          },
        }),
      );

      expect(result.id).toBe('acct_fake_123');
    });

    it('accepte la configuration hybride PLATFORM/STRIPE/NONE/STRIPE', async () => {
      const mockAccount = makeMockAccount();
      mockAccountsCreate.mockResolvedValue(mockAccount);

      const result = await adapter.createConnectedAccount(
        baseCreateConnectedAccountParams({
          controller: {
            feesPayer: 'PLATFORM',
            lossesCollector: 'STRIPE',
            stripeDashboard: 'NONE',
            requirementCollection: 'STRIPE',
          },
        }),
      );

      expect(result.id).toBe('acct_fake_123');
    });

    it('rejette FULL avec lossesCollector=PLATFORM', async () => {
      await expect(
        adapter.createConnectedAccount(
          baseCreateConnectedAccountParams({
            controller: {
              feesPayer: 'PLATFORM',
              lossesCollector: 'PLATFORM',
              stripeDashboard: 'FULL',
              requirementCollection: 'STRIPE',
            },
          }),
        ),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('rejette FULL avec feesPayer=PLATFORM', async () => {
      await expect(
        adapter.createConnectedAccount(
          baseCreateConnectedAccountParams({
            controller: {
              feesPayer: 'PLATFORM',
              lossesCollector: 'STRIPE',
              stripeDashboard: 'FULL',
              requirementCollection: 'STRIPE',
            },
          }),
        ),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('rejette NONE avec requirementCollection=STRIPE et lossesCollector=PLATFORM', async () => {
      await expect(
        adapter.createConnectedAccount(
          baseCreateConnectedAccountParams({
            controller: {
              feesPayer: 'PLATFORM',
              lossesCollector: 'PLATFORM',
              stripeDashboard: 'NONE',
              requirementCollection: 'STRIPE',
            },
          }),
        ),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('rejette requirementCollection=PLATFORM avec lossesCollector=STRIPE', async () => {
      await expect(
        adapter.createConnectedAccount(
          baseCreateConnectedAccountParams({
            controller: {
              feesPayer: 'CONNECTED_ACCOUNT',
              lossesCollector: 'STRIPE',
              stripeDashboard: 'FULL',
              requirementCollection: 'PLATFORM',
            },
          }),
        ),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('rejette requirementCollection=PLATFORM avec feesPayer=CONNECTED_ACCOUNT', async () => {
      await expect(
        adapter.createConnectedAccount(
          baseCreateConnectedAccountParams({
            controller: {
              feesPayer: 'CONNECTED_ACCOUNT',
              lossesCollector: 'PLATFORM',
              stripeDashboard: 'NONE',
              requirementCollection: 'PLATFORM',
            },
          }),
        ),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('rejette requirementCollection=PLATFORM avec stripeDashboard=FULL', async () => {
      await expect(
        adapter.createConnectedAccount(
          baseCreateConnectedAccountParams({
            controller: {
              feesPayer: 'CONNECTED_ACCOUNT',
              lossesCollector: 'STRIPE',
              stripeDashboard: 'FULL',
              requirementCollection: 'PLATFORM',
            },
          }),
        ),
      ).rejects.toThrow(PaymentProviderError);
    });
  });

  describe('retrieveConnectedAccount', () => {
    it('récupère un compte existant', async () => {
      const mockAccount = makeMockAccount({
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: { transfers: 'active' },
        details_submitted: true,
      });
      mockAccountsRetrieve.mockResolvedValue(mockAccount);

      const result = await adapter.retrieveConnectedAccount('acct_123');

      expect(result.id).toBe('acct_fake_123');
      expect(result.chargesEnabled).toBe(true);
      expect(result.onboardingStatus).toBe('COMPLETE');
    });
  });

  describe('createOnboardingLink', () => {
    it("crée un lien d'onboarding avec type account_onboarding", async () => {
      const mockLink = makeMockAccountLink();
      mockAccountLinksCreate.mockResolvedValue(mockLink);

      const params: CreateOnboardingLinkParams = {
        accountId: 'acct_123',
        returnUrl: 'https://uttily.example.com/return',
        refreshUrl: 'https://uttily.example.com/refresh',
        idempotencyKey: 'idem_link_abc',
      };
      const result = await adapter.createOnboardingLink(params);

      expect(result.url).toBe('https://connect.stripe.com/onboarding/link_123');
      expect(result.expiresAt).toBe(mockLink.expires_at);

      const [createParams, options] = mockAccountLinksCreate.mock.calls[0]!;
      expect(createParams.account).toBe('acct_123');
      expect(createParams.type).toBe('account_onboarding');
      expect(createParams.return_url).toBe('https://uttily.example.com/return');
      expect(createParams.refresh_url).toBe('https://uttily.example.com/refresh');
      expect(options.idempotencyKey).toBe('idem_link_abc');
    });

    it('rejette un accountId vide avec VALIDATION', async () => {
      const params: CreateOnboardingLinkParams = {
        accountId: '',
        returnUrl: 'https://uttily.example.com/return',
        refreshUrl: 'https://uttily.example.com/refresh',
        idempotencyKey: 'idem_link_abc',
      };

      await expect(adapter.createOnboardingLink(params)).rejects.toThrow(PaymentProviderError);

      try {
        await adapter.createOnboardingLink(params);
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('VALIDATION');
        expect(err.providerErrorCode).toBe('invalid_account_id');
      }
    });

    it('rejette un returnUrl vide avec VALIDATION', async () => {
      const params: CreateOnboardingLinkParams = {
        accountId: 'acct_123',
        returnUrl: '',
        refreshUrl: 'https://uttily.example.com/refresh',
        idempotencyKey: 'idem_link_abc',
      };

      await expect(adapter.createOnboardingLink(params)).rejects.toThrow(PaymentProviderError);

      try {
        await adapter.createOnboardingLink(params);
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('VALIDATION');
        expect(err.providerErrorCode).toBe('invalid_return_url');
      }
    });

    it('rejette un refreshUrl vide avec VALIDATION', async () => {
      const params: CreateOnboardingLinkParams = {
        accountId: 'acct_123',
        returnUrl: 'https://uttily.example.com/return',
        refreshUrl: '',
        idempotencyKey: 'idem_link_abc',
      };

      await expect(adapter.createOnboardingLink(params)).rejects.toThrow(PaymentProviderError);

      try {
        await adapter.createOnboardingLink(params);
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('VALIDATION');
        expect(err.providerErrorCode).toBe('invalid_refresh_url');
      }
    });

    it("rejette une clé d'idempotence vide avec VALIDATION", async () => {
      const params: CreateOnboardingLinkParams = {
        accountId: 'acct_123',
        returnUrl: 'https://uttily.example.com/return',
        refreshUrl: 'https://uttily.example.com/refresh',
        idempotencyKey: '',
      };

      await expect(adapter.createOnboardingLink(params)).rejects.toThrow(PaymentProviderError);

      try {
        await adapter.createOnboardingLink(params);
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('VALIDATION');
        expect(err.providerErrorCode).toBe('invalid_idempotency_key');
      }
    });
  });

  describe('projectCapabilities', () => {
    it('projette les capacités du compte', async () => {
      const mockAccount = makeMockAccount({
        charges_enabled: true,
        payouts_enabled: false,
        capabilities: { transfers: 'active' },
      });
      mockAccountsRetrieve.mockResolvedValue(mockAccount);

      const result = await adapter.projectCapabilities('acct_123');

      expect(result.chargesEnabled).toBe(true);
      expect(result.payoutsEnabled).toBe(false);
      expect(result.transfersCapabilityStatus).toBe('ACTIVE');
    });
  });

  describe('sécurité (ADR-010 §14)', () => {
    it("le client_secret n'apparaît que dans la valeur de retour", async () => {
      const mockIntent = makeMockPaymentIntent({
        client_secret: 'pi_secret_sensitive_123',
      });
      mockPaymentIntentsCreate.mockResolvedValue(mockIntent);

      const result = await adapter.createPaymentIntent(baseCreatePaymentIntentParams());

      // Le client_secret est dans le résultat.
      expect(result.clientSecret).toBe('pi_secret_sensitive_123');

      // Il n'est pas dans les paramètres envoyés à Stripe.
      const [createParams] = mockPaymentIntentsCreate.mock.calls[0]!;
      const paramStr = JSON.stringify(createParams);
      expect(paramStr).not.toContain('client_secret');
      expect(paramStr).not.toContain('pi_secret_sensitive_123');
    });

    it("le client_secret n'est pas dans les metadata", async () => {
      const mockIntent = makeMockPaymentIntent();
      mockPaymentIntentsCreate.mockResolvedValue(mockIntent);

      await adapter.createPaymentIntent(baseCreatePaymentIntentParams());

      const [createParams] = mockPaymentIntentsCreate.mock.calls[0]!;
      // Les metadata ne contiennent que les clés internes non sensibles.
      const metadataKeys = Object.keys(createParams.metadata);
      expect(metadataKeys).not.toContain('client_secret');
      expect(metadataKeys).not.toContain('card');
    });
  });

  describe('PINNED_STRIPE_API_VERSION', () => {
    it('est épinglée et non vide', () => {
      expect(PINNED_STRIPE_API_VERSION).toBe('2026-06-24.dahlia');
      expect(PINNED_STRIPE_API_VERSION.length).toBeGreaterThan(0);
    });
  });

  describe('fail-closed et invariants', () => {
    it('mapPaymentIntentStatus lève UNSUPPORTED_PROVIDER_STATE pour un statut inconnu', async () => {
      const mockIntent = makeMockPaymentIntent({ status: 'unknown_status' });
      mockPaymentIntentsCreate.mockResolvedValue(mockIntent);

      await expect(adapter.createPaymentIntent(baseCreatePaymentIntentParams())).rejects.toThrow(
        PaymentProviderError,
      );

      try {
        await adapter.createPaymentIntent(baseCreatePaymentIntentParams());
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('UNSUPPORTED_PROVIDER_STATE');
      }
    });

    it('verifyWebhook lève PAYMENT_ENVIRONMENT_MISMATCH en cas de mismatch', async () => {
      await expect(
        adapter.verifyWebhook({
          rawBody: '{"id":"evt_123"}',
          signature: 't=123,v1=fake',
          endpoint: 'platform',
          environment: 'LIVE',
        }),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('createConnectedAccount lève PAYMENT_ENVIRONMENT_MISMATCH en cas de mismatch', async () => {
      await expect(
        adapter.createConnectedAccount(baseCreateConnectedAccountParams({ environment: 'LIVE' })),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('LIVE constructor échoue sans PAYMENTS_LIVE_ENABLED=true', () => {
      const originalEnv = process.env.PAYMENTS_LIVE_ENABLED;
      delete process.env.PAYMENTS_LIVE_ENABLED;

      try {
        expect(
          () =>
            new StripeAdapter({
              ...BASE_CONFIG,
              secretKey: 'sk_live_fake_key',
              environment: 'LIVE',
            }),
        ).toThrow('LIVE non activé');
      } finally {
        if (originalEnv !== undefined) {
          process.env.PAYMENTS_LIVE_ENABLED = originalEnv;
        }
      }
    });

    it('LIVE constructor réussit avec PAYMENTS_LIVE_ENABLED=true', () => {
      const originalEnv = process.env.PAYMENTS_LIVE_ENABLED;
      process.env.PAYMENTS_LIVE_ENABLED = 'true';

      try {
        expect(
          () =>
            new StripeAdapter({
              ...BASE_CONFIG,
              secretKey: 'sk_live_fake_key',
              environment: 'LIVE',
            }),
        ).not.toThrow();
      } finally {
        if (originalEnv !== undefined) {
          process.env.PAYMENTS_LIVE_ENABLED = originalEnv;
        } else {
          delete process.env.PAYMENTS_LIVE_ENABLED;
        }
      }
    });

    it('clientSecret est null quand Stripe retourne null', async () => {
      const mockIntent = makeMockPaymentIntent({ client_secret: null });
      mockPaymentIntentsCreate.mockResolvedValue(mockIntent);

      const result = await adapter.createPaymentIntent(baseCreatePaymentIntentParams());

      expect(result.clientSecret).toBeNull();
    });

    it('clientSecret est null sur retrieve quand Stripe retourne null', async () => {
      const mockIntent = makeMockPaymentIntent({ client_secret: null });
      mockPaymentIntentsRetrieve.mockResolvedValue(mockIntent);

      const result = await adapter.retrievePaymentIntent('pi_123');

      expect(result.clientSecret).toBeNull();
    });

    it('clientSecret est null sur cancel quand Stripe retourne null', async () => {
      const mockIntent = makeMockPaymentIntent({ client_secret: null, status: 'canceled' });
      mockPaymentIntentsCancel.mockResolvedValue(mockIntent);

      const result = await adapter.cancelPaymentIntent({
        id: 'pi_123',
        idempotencyKey: 'idem_cancel_abc',
      });

      expect(result.clientSecret).toBeNull();
    });
  });
});
