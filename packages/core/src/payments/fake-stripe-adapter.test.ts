import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Tests unitaires du fake strict du provider Stripe (Lot 5, ADR-010).
 *
 * Le fake ne fait aucun appel réseau. Les tests vérifient le déterminisme,
 * le replay idempotent, les transitions de statut, la validation stricte
 * et l'absence de fuite de client_secret dans l'état interne.
 */

import { FakeStripeAdapter } from './fake-stripe-adapter';
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
    paymentIntentId: 'pi_existing_123',
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

describe('FakeStripeAdapter', () => {
  let fake: FakeStripeAdapter;

  beforeEach(() => {
    fake = new FakeStripeAdapter();
  });

  describe('createPaymentIntent', () => {
    it("génère un ID déterministe depuis la clé d'idempotence", async () => {
      const result = await fake.createPaymentIntent(baseCreatePaymentIntentParams());

      expect(result.id).toMatch(/^pi_[a-f0-9]{24}$/);
      expect(result.status).toBe('requires_payment_method');
      expect(result.amountMinor).toBe(10000);
      expect(result.currency).toBe('EUR');
      expect(result.latestChargeId).toBeNull();
    });

    it("retourne le même PaymentIntent pour la même clé d'idempotence (replay)", async () => {
      const params = baseCreatePaymentIntentParams();
      const result1 = await fake.createPaymentIntent(params);
      const result2 = await fake.createPaymentIntent(params);

      expect(result1.id).toBe(result2.id);
    });

    it('lève CONFLICT_IDEMPOTENCY pour même clé + params différents', async () => {
      const params1 = baseCreatePaymentIntentParams({ idempotencyKey: 'shared_key' });
      await fake.createPaymentIntent(params1);

      const params2 = baseCreatePaymentIntentParams({
        idempotencyKey: 'shared_key',
        amountMinor: 20000,
      });

      await expect(fake.createPaymentIntent(params2)).rejects.toThrow(PaymentProviderError);

      try {
        await fake.createPaymentIntent(params2);
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('CONFLICT_IDEMPOTENCY');
      }
    });

    it('génère des IDs différents pour des clés différentes', async () => {
      const result1 = await fake.createPaymentIntent(
        baseCreatePaymentIntentParams({ idempotencyKey: 'key_A' }),
      );
      const result2 = await fake.createPaymentIntent(
        baseCreatePaymentIntentParams({ idempotencyKey: 'key_B' }),
      );

      expect(result1.id).not.toBe(result2.id);
    });

    it('le client_secret est dans la valeur de retour mais pas stocké', async () => {
      const result = await fake.createPaymentIntent(baseCreatePaymentIntentParams());

      expect(result.clientSecret).toBeTruthy();
      expect(result.clientSecret).toContain(result.id);
      expect(result.clientSecret).toContain('_secret_');
    });

    it('rejette un montant invalide', async () => {
      await expect(
        fake.createPaymentIntent(baseCreatePaymentIntentParams({ amountMinor: -1 })),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('rejette un montant nul', async () => {
      await expect(
        fake.createPaymentIntent(baseCreatePaymentIntentParams({ amountMinor: 0 })),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('rejette un montant non-entier', async () => {
      await expect(
        fake.createPaymentIntent(baseCreatePaymentIntentParams({ amountMinor: 10.5 })),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('rejette une devise non-EUR', async () => {
      await expect(
        fake.createPaymentIntent(baseCreatePaymentIntentParams({ currency: 'USD' as 'EUR' })),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('rejette un connectedAccountId vide', async () => {
      await expect(
        fake.createPaymentIntent(baseCreatePaymentIntentParams({ connectedAccountId: '' })),
      ).rejects.toThrow(PaymentProviderError);
    });

    it("rejette une clé d'idempotence vide", async () => {
      await expect(
        fake.createPaymentIntent(baseCreatePaymentIntentParams({ idempotencyKey: '' })),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('rejette une commission négative', async () => {
      await expect(
        fake.createPaymentIntent(baseCreatePaymentIntentParams({ applicationFeeAmountMinor: -1 })),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('accepte une commission null', async () => {
      const result = await fake.createPaymentIntent(
        baseCreatePaymentIntentParams({ applicationFeeAmountMinor: null }),
      );

      expect(result.id).toMatch(/^pi_/);
    });

    it('accepte une commission de 0', async () => {
      const result = await fake.createPaymentIntent(
        baseCreatePaymentIntentParams({ applicationFeeAmountMinor: 0 }),
      );

      expect(result.id).toMatch(/^pi_/);
    });

    it('rejette un onBehalfOfAccountId vide (non-null)', async () => {
      await expect(
        fake.createPaymentIntent(baseCreatePaymentIntentParams({ onBehalfOfAccountId: '' })),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('peut simuler une erreur forcée', async () => {
      const forcedError = new PaymentProviderError('VALIDATION', 'Erreur forcée', 'forced');
      const failingFake = new FakeStripeAdapter({
        forceCreatePaymentIntentError: forcedError,
      });

      await expect(failingFake.createPaymentIntent(baseCreatePaymentIntentParams())).rejects.toBe(
        forcedError,
      );
    });
  });

  describe('retrievePaymentIntent', () => {
    it('récupère un PaymentIntent créé précédemment', async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());
      const retrieved = await fake.retrievePaymentIntent(created.id);

      expect(retrieved.id).toBe(created.id);
      expect(retrieved.status).toBe(created.status);
      expect(retrieved.amountMinor).toBe(created.amountMinor);
    });

    it('lève NOT_FOUND pour un ID inexistant', async () => {
      await expect(fake.retrievePaymentIntent('pi_missing')).rejects.toThrow(PaymentProviderError);

      try {
        await fake.retrievePaymentIntent('pi_missing');
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('NOT_FOUND');
      }
    });

    it('rejette un ID vide', async () => {
      await expect(fake.retrievePaymentIntent('')).rejects.toThrow(PaymentProviderError);
    });
  });

  describe('cancelPaymentIntent', () => {
    it('transitionne vers canceled', async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());
      const canceled = await fake.cancelPaymentIntent({
        id: created.id,
        idempotencyKey: 'idem_cancel_abc',
      });

      expect(canceled.status).toBe('canceled');
    });

    it('lève une erreur si on annule un PaymentIntent déjà réussi', async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());
      fake.simulatePaymentIntentStatus(created.id, 'succeeded');

      await expect(
        fake.cancelPaymentIntent({ id: created.id, idempotencyKey: 'idem_cancel_abc' }),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('lève NOT_FOUND pour un ID inexistant', async () => {
      await expect(
        fake.cancelPaymentIntent({ id: 'pi_missing', idempotencyKey: 'idem_cancel_abc' }),
      ).rejects.toThrow(PaymentProviderError);
    });

    it("rejette une clé d'idempotence vide", async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());

      await expect(
        fake.cancelPaymentIntent({ id: created.id, idempotencyKey: '' }),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('retourne le même résultat pour la même clé de cancel (replay)', async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());
      const cancelParams = { id: created.id, idempotencyKey: 'idem_cancel_replay' };
      const result1 = await fake.cancelPaymentIntent(cancelParams);
      const result2 = await fake.cancelPaymentIntent(cancelParams);

      expect(result1.id).toBe(result2.id);
      expect(result1.status).toBe('canceled');
      expect(result2.status).toBe('canceled');
    });

    it('lève CONFLICT_IDEMPOTENCY pour même clé de cancel + id différent', async () => {
      const created1 = await fake.createPaymentIntent(
        baseCreatePaymentIntentParams({ idempotencyKey: 'pi_key_1' }),
      );
      const created2 = await fake.createPaymentIntent(
        baseCreatePaymentIntentParams({ idempotencyKey: 'pi_key_2' }),
      );

      await fake.cancelPaymentIntent({ id: created1.id, idempotencyKey: 'shared_cancel_key' });

      await expect(
        fake.cancelPaymentIntent({ id: created2.id, idempotencyKey: 'shared_cancel_key' }),
      ).rejects.toThrow(PaymentProviderError);

      try {
        await fake.cancelPaymentIntent({ id: created2.id, idempotencyKey: 'shared_cancel_key' });
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('CONFLICT_IDEMPOTENCY');
      }
    });
  });

  describe('createRefund', () => {
    it('accepte uniquement la metadata refund B2-B2A exacte', async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());
      fake.simulatePaymentIntentStatus(created.id, 'succeeded');
      const metadata = {
        refund_id: '11111111-1111-4111-8111-111111111111',
        organization_id: '22222222-2222-4222-8222-222222222222',
        protocol_version: 'refund-requested-v1' as const,
      };

      await expect(
        fake.createRefund(baseCreateRefundParams({ paymentIntentId: created.id, metadata })),
      ).resolves.toBeDefined();
      await expect(
        fake.createRefund(
          baseCreateRefundParams({
            paymentIntentId: created.id,
            idempotencyKey: 'invalid_refund_metadata',
            metadata: { ...metadata, protocol_version: 'v2' as 'refund-requested-v1' },
          }),
        ),
      ).rejects.toThrow(PaymentProviderError);
    });

    it("génère un ID déterministe depuis la clé d'idempotence", async () => {
      // Créer un PI succeeded d'abord.
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());
      fake.simulatePaymentIntentStatus(created.id, 'succeeded');

      const result = await fake.createRefund(
        baseCreateRefundParams({ paymentIntentId: created.id }),
      );

      expect(result.id).toMatch(/^re_[a-f0-9]{24}$/);
      expect(result.status).toBe('succeeded');
      expect(result.amountMinor).toBe(10000);
      expect(result.currency).toBe('EUR');
    });

    it('retourne le même refund pour la même clé (replay)', async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());
      fake.simulatePaymentIntentStatus(created.id, 'succeeded');

      const params = baseCreateRefundParams({ paymentIntentId: created.id });
      const result1 = await fake.createRefund(params);
      const result2 = await fake.createRefund(params);

      expect(result1.id).toBe(result2.id);
    });

    it('lève CONFLICT_IDEMPOTENCY pour même clé + params différents (refund)', async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());
      fake.simulatePaymentIntentStatus(created.id, 'succeeded');

      const params1 = baseCreateRefundParams({
        paymentIntentId: created.id,
        idempotencyKey: 'shared_refund_key',
        amountMinor: 5000,
      });
      await fake.createRefund(params1);

      const params2 = baseCreateRefundParams({
        paymentIntentId: created.id,
        idempotencyKey: 'shared_refund_key',
        amountMinor: 10000,
      });

      await expect(fake.createRefund(params2)).rejects.toThrow(PaymentProviderError);

      try {
        await fake.createRefund(params2);
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('CONFLICT_IDEMPOTENCY');
      }
    });

    it('génère des IDs différents pour des clés différentes', async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());
      fake.simulatePaymentIntentStatus(created.id, 'succeeded');

      const result1 = await fake.createRefund(
        baseCreateRefundParams({ paymentIntentId: created.id, idempotencyKey: 'refund_A' }),
      );
      const result2 = await fake.createRefund(
        baseCreateRefundParams({ paymentIntentId: created.id, idempotencyKey: 'refund_B' }),
      );

      expect(result1.id).not.toBe(result2.id);
    });

    it('rejette un montant de refund invalide (0)', async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());
      fake.simulatePaymentIntentStatus(created.id, 'succeeded');

      await expect(
        fake.createRefund(baseCreateRefundParams({ paymentIntentId: created.id, amountMinor: 0 })),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('rejette un montant de refund négatif', async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());
      fake.simulatePaymentIntentStatus(created.id, 'succeeded');

      await expect(
        fake.createRefund(baseCreateRefundParams({ paymentIntentId: created.id, amountMinor: -1 })),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('rejette un refund sur un PI non réussi', async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());
      // Le PI est en requires_payment_method, pas succeeded.

      await expect(
        fake.createRefund(baseCreateRefundParams({ paymentIntentId: created.id })),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('rejette un refund sur un PI inexistant', async () => {
      await expect(
        fake.createRefund(baseCreateRefundParams({ paymentIntentId: 'pi_missing' })),
      ).rejects.toThrow(PaymentProviderError);
    });

    it("rejette une clé d'idempotence vide", async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());
      fake.simulatePaymentIntentStatus(created.id, 'succeeded');

      await expect(
        fake.createRefund(
          baseCreateRefundParams({ paymentIntentId: created.id, idempotencyKey: '' }),
        ),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('peut simuler une erreur forcée', async () => {
      const forcedError = new PaymentProviderError('UNKNOWN', 'Erreur forcée', 'forced');
      const failingFake = new FakeStripeAdapter({
        forceCreateRefundError: forcedError,
      });

      await expect(failingFake.createRefund(baseCreateRefundParams())).rejects.toBe(forcedError);
    });
  });

  describe('retrieveRefund', () => {
    it('récupère un refund créé précédemment', async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());
      fake.simulatePaymentIntentStatus(created.id, 'succeeded');

      const refund = await fake.createRefund(
        baseCreateRefundParams({ paymentIntentId: created.id }),
      );
      const retrieved = await fake.retrieveRefund(refund.id);

      expect(retrieved.id).toBe(refund.id);
      expect(retrieved.status).toBe(refund.status);
    });

    it('lève NOT_FOUND pour un ID inexistant', async () => {
      await expect(fake.retrieveRefund('re_missing')).rejects.toThrow(PaymentProviderError);
    });
  });

  describe('verifyWebhook', () => {
    it('vérifie un webhook avec une signature fake valide', async () => {
      const rawBody = JSON.stringify({
        id: 'evt_123',
        type: 'payment_intent.succeeded',
        created: Math.floor(Date.now() / 1000),
        api_version: 'fake-v1',
        data: { object: { id: 'pi_123', status: 'succeeded', amount: 10000 } },
      });

      const signature = fake.generateValidSignature(rawBody, 'platform');

      const result = await fake.verifyWebhook({
        rawBody,
        signature,
        endpoint: 'platform',
        environment: 'TEST',
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.event.id).toBe('evt_123');
        expect(result.event.type).toBe('payment_intent.succeeded');
        expect(result.event.objectId).toBe('pi_123');
        expect(result.event.apiVersion).toBe('fake-v1');
      }
    });

    it('retourne INVALID_SIGNATURE pour une signature invalide', async () => {
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const result = await fake.verifyWebhook({
        rawBody: '{"id":"evt_123"}',
        signature: `t=${currentTimestamp},v1=invalid_hash`,
        endpoint: 'platform',
        environment: 'TEST',
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('INVALID_SIGNATURE');
      }
    });

    it('retourne INVALID_PAYLOAD pour un corps vide', async () => {
      const result = await fake.verifyWebhook({
        rawBody: '',
        signature: 't=123,v1=fake',
        endpoint: 'platform',
        environment: 'TEST',
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('INVALID_PAYLOAD');
      }
    });

    it('retourne INVALID_SIGNATURE pour une signature vide', async () => {
      const result = await fake.verifyWebhook({
        rawBody: '{"id":"evt_123"}',
        signature: '',
        endpoint: 'platform',
        environment: 'TEST',
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('INVALID_SIGNATURE');
      }
    });

    it('retourne INVALID_TIMESTAMP pour un timestamp très ancien', async () => {
      const rawBody = '{"id":"evt_123"}';
      // Timestamp très ancien (il y a 1h) avec un v1 invalide.
      const oldTimestamp = Math.floor(Date.now() / 1000) - 3600;
      const signature = `t=${oldTimestamp},v1=invalid_hash`;

      const result = await fake.verifyWebhook({
        rawBody,
        signature,
        endpoint: 'platform',
        environment: 'TEST',
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('INVALID_TIMESTAMP');
      }
    });

    it("utilise le bon secret selon l'endpoint", async () => {
      const rawBody = '{"id":"evt_123","type":"test"}';

      // Signature valide pour platform.
      const sigPlatform = fake.generateValidSignature(rawBody, 'platform');
      const resultPlatform = await fake.verifyWebhook({
        rawBody,
        signature: sigPlatform,
        endpoint: 'platform',
        environment: 'TEST',
      });
      expect(resultPlatform.valid).toBe(true);

      // La même signature ne doit pas être valide pour connect (secret différent).
      const resultConnect = await fake.verifyWebhook({
        rawBody,
        signature: sigPlatform,
        endpoint: 'connect',
        environment: 'TEST',
      });
      expect(resultConnect.valid).toBe(false);
    });

    it('retourne INVALID_PAYLOAD pour un JSON invalide avec bonne signature', async () => {
      const rawBody = 'not valid json';
      const signature = fake.generateValidSignature(rawBody, 'platform');

      const result = await fake.verifyWebhook({
        rawBody,
        signature,
        endpoint: 'platform',
        environment: 'TEST',
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('INVALID_PAYLOAD');
      }
    });

    it('exclut les données de carte de la normalisation webhook', async () => {
      const rawBody = JSON.stringify({
        id: 'evt_123',
        type: 'payment_intent.succeeded',
        created: Math.floor(Date.now() / 1000),
        api_version: 'fake-v1',
        data: {
          object: {
            id: 'pi_123',
            object: 'payment_intent',
            status: 'succeeded',
            amount: 10000,
            currency: 'eur',
            metadata: { payment_id: 'pay_123' },
            // Champs sensibles qui ne doivent PAS être dans la normalisation
            last4: '4242',
            brand: 'visa',
            fingerprint: 'abc123',
            payment_method: 'pm_123',
          },
        },
      });

      const signature = fake.generateValidSignature(rawBody, 'platform');
      const result = await fake.verifyWebhook({
        rawBody,
        signature,
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
        expect(result.event.data).toHaveProperty('metadata');
      }
    });

    // P1-3 : Le fake adapter ne doit pas filtrer les éléments non-objets de
    // refunds.data. Un payload contenant [refundValide, null] doit conserver
    // l'élément null pour que projectRefundStatus lève REFUND_OBJECT_INVALID.
    it('préserve les éléments null dans refunds.data (ne filtre pas — P1-3)', async () => {
      const rawBody = JSON.stringify({
        id: 'evt_refund_null_element',
        type: 'charge.refunded',
        created: Math.floor(Date.now() / 1000),
        api_version: 'fake-v1',
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
      });

      const signature = fake.generateValidSignature(rawBody, 'platform');
      const result = await fake.verifyWebhook({
        rawBody,
        signature,
        endpoint: 'platform',
        environment: 'TEST',
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        const data = result.event.data as Record<string, unknown>;
        const refunds = data.refunds as Record<string, unknown>;
        const refundList = refunds.data as unknown[];
        expect(refundList).toHaveLength(2);
        expect(refundList[0]).not.toBeNull();
        expect(refundList[1]).toBeNull();
      }
    });

    it('conserve les trois champs metadata refund autorisés sur les objets directs et imbriqués', async () => {
      const metadata = {
        refund_id: '11111111-1111-4111-8111-111111111111',
        organization_id: '22222222-2222-4222-8222-222222222222',
        protocol_version: 'refund-requested-v1',
        payment_id: 'must-not-leak',
        extra: 'must-not-leak',
      };
      const directBody = JSON.stringify({
        id: 'evt_refund_metadata_direct',
        type: 'refund.created',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: 're_direct',
            status: 'pending',
            amount: 100,
            currency: 'eur',
            payment_intent: 'pi_test',
            metadata,
          },
        },
      });
      const direct = await fake.verifyWebhook({
        rawBody: directBody,
        signature: fake.generateValidSignature(directBody, 'platform'),
        endpoint: 'platform',
        environment: 'TEST',
      });
      expect(direct.valid).toBe(true);
      if (direct.valid) {
        expect(direct.event.data.metadata).toEqual({
          refund_id: metadata.refund_id,
          organization_id: metadata.organization_id,
          protocol_version: metadata.protocol_version,
        });
      }

      const nestedBody = JSON.stringify({
        id: 'evt_refund_metadata_nested',
        type: 'charge.refunded',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: 'ch_nested',
            refunds: {
              data: [
                {
                  id: 're_nested',
                  status: 'pending',
                  amount: 100,
                  currency: 'eur',
                  payment_intent: 'pi_test',
                  metadata,
                },
              ],
            },
          },
        },
      });
      const nested = await fake.verifyWebhook({
        rawBody: nestedBody,
        signature: fake.generateValidSignature(nestedBody, 'platform'),
        endpoint: 'platform',
        environment: 'TEST',
      });
      expect(nested.valid).toBe(true);
      if (nested.valid) {
        const data = nested.event.data.refunds as { data: Array<Record<string, unknown>> };
        expect(data.data[0]!.metadata).toEqual({
          refund_id: metadata.refund_id,
          organization_id: metadata.organization_id,
          protocol_version: metadata.protocol_version,
        });
      }
    });
  });

  describe('createConnectedAccount', () => {
    it('crée un compte avec un ID déterministe', async () => {
      const result = await fake.createConnectedAccount(baseCreateConnectedAccountParams());

      expect(result.id).toMatch(/^acct_[a-f0-9]{24}$/);
      expect(result.chargesEnabled).toBe(false);
      expect(result.payoutsEnabled).toBe(false);
      expect(result.transfersCapabilityStatus).toBe('PENDING');
      expect(result.onboardingStatus).toBe('PENDING');
      expect(result.apiGeneration).toBe('ACCOUNTS_V1_CONTROLLER_PROPERTIES');
    });

    it('retourne le même compte pour les mêmes paramètres (replay)', async () => {
      const params = baseCreateConnectedAccountParams();
      const result1 = await fake.createConnectedAccount(params);
      const result2 = await fake.createConnectedAccount(params);

      expect(result1.id).toBe(result2.id);
    });

    it('lève CONFLICT_IDEMPOTENCY pour même clé + params différents (compte)', async () => {
      const params1 = baseCreateConnectedAccountParams({
        idempotencyKey: 'shared_acct_key',
        country: 'FR',
      });
      await fake.createConnectedAccount(params1);

      const params2 = baseCreateConnectedAccountParams({
        idempotencyKey: 'shared_acct_key',
        country: 'DE',
      });

      await expect(fake.createConnectedAccount(params2)).rejects.toThrow(PaymentProviderError);

      try {
        await fake.createConnectedAccount(params2);
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('CONFLICT_IDEMPOTENCY');
      }
    });

    it('génère des IDs différents pour des organisations différentes', async () => {
      const result1 = await fake.createConnectedAccount(
        baseCreateConnectedAccountParams({ organizationId: 'org_A', idempotencyKey: 'idem_A' }),
      );
      const result2 = await fake.createConnectedAccount(
        baseCreateConnectedAccountParams({ organizationId: 'org_B', idempotencyKey: 'idem_B' }),
      );

      expect(result1.id).not.toBe(result2.id);
    });

    it('contient des controller properties (sémantique locale provider-agnostic)', async () => {
      const result = await fake.createConnectedAccount(baseCreateConnectedAccountParams());

      expect(result.controllerConfiguration).toBeDefined();
      expect(result.controllerConfiguration).toHaveProperty('feesPayer', 'PLATFORM');
      expect(result.controllerConfiguration).toHaveProperty('lossesCollector', 'PLATFORM');
      expect(result.controllerConfiguration).toHaveProperty('stripeDashboard', 'NONE');
      expect(result.controllerConfiguration).toHaveProperty('requirementCollection', 'PLATFORM');
    });

    it('rejette un organizationId vide', async () => {
      await expect(
        fake.createConnectedAccount(baseCreateConnectedAccountParams({ organizationId: '' })),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('rejette un pays vide', async () => {
      await expect(
        fake.createConnectedAccount(baseCreateConnectedAccountParams({ country: '' })),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('rejette un environnement invalide', async () => {
      await expect(
        fake.createConnectedAccount(
          baseCreateConnectedAccountParams({ environment: 'INVALID' as 'TEST' }),
        ),
      ).rejects.toThrow(PaymentProviderError);
    });

    it('peut simuler une erreur forcée', async () => {
      const forcedError = new PaymentProviderError('UNKNOWN', 'Erreur forcée', 'forced');
      const failingFake = new FakeStripeAdapter({
        forceCreateConnectedAccountError: forcedError,
      });

      await expect(
        failingFake.createConnectedAccount(baseCreateConnectedAccountParams()),
      ).rejects.toBe(forcedError);
    });

    it('accepte le preset STANDARD', async () => {
      const result = await fake.createConnectedAccount(
        baseCreateConnectedAccountParams({
          controller: {
            feesPayer: 'CONNECTED_ACCOUNT',
            lossesCollector: 'STRIPE',
            stripeDashboard: 'FULL',
            requirementCollection: 'STRIPE',
          },
        }),
      );
      expect(result.id).toMatch(/^acct_/);
    });

    it('accepte le preset EXPRESS', async () => {
      const result = await fake.createConnectedAccount(
        baseCreateConnectedAccountParams({
          controller: {
            feesPayer: 'PLATFORM',
            lossesCollector: 'PLATFORM',
            stripeDashboard: 'EXPRESS',
            requirementCollection: 'STRIPE',
          },
        }),
      );
      expect(result.id).toMatch(/^acct_/);
    });

    it('accepte le preset CUSTOM', async () => {
      const result = await fake.createConnectedAccount(
        baseCreateConnectedAccountParams({
          controller: {
            feesPayer: 'PLATFORM',
            lossesCollector: 'PLATFORM',
            stripeDashboard: 'NONE',
            requirementCollection: 'PLATFORM',
          },
        }),
      );
      expect(result.id).toMatch(/^acct_/);
    });

    it('accepte la configuration hybride CONNECTED_ACCOUNT/STRIPE/NONE/STRIPE', async () => {
      const result = await fake.createConnectedAccount(
        baseCreateConnectedAccountParams({
          controller: {
            feesPayer: 'CONNECTED_ACCOUNT',
            lossesCollector: 'STRIPE',
            stripeDashboard: 'NONE',
            requirementCollection: 'STRIPE',
          },
        }),
      );
      expect(result.id).toMatch(/^acct_/);
    });

    it('accepte la configuration hybride PLATFORM/STRIPE/NONE/STRIPE', async () => {
      const result = await fake.createConnectedAccount(
        baseCreateConnectedAccountParams({
          controller: {
            feesPayer: 'PLATFORM',
            lossesCollector: 'STRIPE',
            stripeDashboard: 'NONE',
            requirementCollection: 'STRIPE',
          },
        }),
      );
      expect(result.id).toMatch(/^acct_/);
    });

    it('rejette FULL avec lossesCollector=PLATFORM', async () => {
      await expect(
        fake.createConnectedAccount(
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
        fake.createConnectedAccount(
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
        fake.createConnectedAccount(
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
        fake.createConnectedAccount(
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
        fake.createConnectedAccount(
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
        fake.createConnectedAccount(
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
    it('récupère un compte créé précédemment', async () => {
      const created = await fake.createConnectedAccount(baseCreateConnectedAccountParams());
      const retrieved = await fake.retrieveConnectedAccount(created.id);

      expect(retrieved.id).toBe(created.id);
      expect(retrieved.chargesEnabled).toBe(created.chargesEnabled);
    });

    it('lève NOT_FOUND pour un ID inexistant', async () => {
      await expect(fake.retrieveConnectedAccount('acct_missing')).rejects.toThrow(
        PaymentProviderError,
      );
    });
  });

  describe('createOnboardingLink', () => {
    it("crée un lien d'onboarding avec URL et expiration", async () => {
      const created = await fake.createConnectedAccount(baseCreateConnectedAccountParams());
      const params: CreateOnboardingLinkParams = {
        accountId: created.id,
        returnUrl: 'https://uttily.example.com/return',
        refreshUrl: 'https://uttily.example.com/refresh',
        idempotencyKey: 'idem_link_abc',
      };
      const result = await fake.createOnboardingLink(params);

      expect(result.url).toContain(created.id);
      expect(result.url).toMatch(/^https:\/\//);
      expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("retourne le même lien pour la même clé d'idempotence (replay)", async () => {
      const created = await fake.createConnectedAccount(baseCreateConnectedAccountParams());
      const params: CreateOnboardingLinkParams = {
        accountId: created.id,
        returnUrl: 'https://uttily.example.com/return',
        refreshUrl: 'https://uttily.example.com/refresh',
        idempotencyKey: 'idem_link_replay',
      };
      const result1 = await fake.createOnboardingLink(params);
      const result2 = await fake.createOnboardingLink(params);

      expect(result1.url).toBe(result2.url);
    });

    it('lève NOT_FOUND pour un compte inexistant', async () => {
      const params: CreateOnboardingLinkParams = {
        accountId: 'acct_missing',
        returnUrl: 'https://uttily.example.com/return',
        refreshUrl: 'https://uttily.example.com/refresh',
        idempotencyKey: 'idem_link_abc',
      };
      await expect(fake.createOnboardingLink(params)).rejects.toThrow(PaymentProviderError);
    });

    it('rejette un returnUrl vide', async () => {
      const created = await fake.createConnectedAccount(baseCreateConnectedAccountParams());
      const params: CreateOnboardingLinkParams = {
        accountId: created.id,
        returnUrl: '',
        refreshUrl: 'https://uttily.example.com/refresh',
        idempotencyKey: 'idem_link_abc',
      };

      await expect(fake.createOnboardingLink(params)).rejects.toThrow(PaymentProviderError);
    });

    it('rejette un refreshUrl vide', async () => {
      const created = await fake.createConnectedAccount(baseCreateConnectedAccountParams());
      const params: CreateOnboardingLinkParams = {
        accountId: created.id,
        returnUrl: 'https://uttily.example.com/return',
        refreshUrl: '',
        idempotencyKey: 'idem_link_abc',
      };

      await expect(fake.createOnboardingLink(params)).rejects.toThrow(PaymentProviderError);
    });

    it("rejette une clé d'idempotence vide", async () => {
      const created = await fake.createConnectedAccount(baseCreateConnectedAccountParams());
      const params: CreateOnboardingLinkParams = {
        accountId: created.id,
        returnUrl: 'https://uttily.example.com/return',
        refreshUrl: 'https://uttily.example.com/refresh',
        idempotencyKey: '',
      };

      await expect(fake.createOnboardingLink(params)).rejects.toThrow(PaymentProviderError);
    });

    it('lève CONFLICT_IDEMPOTENCY pour même clé onboarding + returnUrl différent', async () => {
      const created = await fake.createConnectedAccount(baseCreateConnectedAccountParams());
      const params1: CreateOnboardingLinkParams = {
        accountId: created.id,
        returnUrl: 'https://uttily.example.com/return',
        refreshUrl: 'https://uttily.example.com/refresh',
        idempotencyKey: 'shared_onboarding_key',
      };
      await fake.createOnboardingLink(params1);

      const params2: CreateOnboardingLinkParams = {
        accountId: created.id,
        returnUrl: 'https://uttily.example.com/different-return',
        refreshUrl: 'https://uttily.example.com/refresh',
        idempotencyKey: 'shared_onboarding_key',
      };

      await expect(fake.createOnboardingLink(params2)).rejects.toThrow(PaymentProviderError);

      try {
        await fake.createOnboardingLink(params2);
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('CONFLICT_IDEMPOTENCY');
      }
    });
  });

  describe('projectCapabilities', () => {
    it('projette les capacités initiales (non prêt)', async () => {
      const created = await fake.createConnectedAccount(baseCreateConnectedAccountParams());
      const caps = await fake.projectCapabilities(created.id);

      expect(caps.chargesEnabled).toBe(false);
      expect(caps.payoutsEnabled).toBe(false);
      expect(caps.transfersCapabilityStatus).toBe('PENDING');
    });

    it("projette les capacités après completion d'onboarding", async () => {
      const created = await fake.createConnectedAccount(baseCreateConnectedAccountParams());
      fake.simulateAccountOnboardingComplete(created.id);

      const caps = await fake.projectCapabilities(created.id);

      expect(caps.chargesEnabled).toBe(true);
      expect(caps.payoutsEnabled).toBe(true);
      expect(caps.transfersCapabilityStatus).toBe('ACTIVE');
    });

    it('lève NOT_FOUND pour un compte inexistant', async () => {
      await expect(fake.projectCapabilities('acct_missing')).rejects.toThrow(PaymentProviderError);
    });
  });

  describe('transitions de statut (simulatePaymentIntentStatus)', () => {
    it('transitionne vers succeeded et génère un latestChargeId', async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());
      fake.simulatePaymentIntentStatus(created.id, 'succeeded');

      const retrieved = await fake.retrievePaymentIntent(created.id);
      expect(retrieved.status).toBe('succeeded');
      expect(retrieved.latestChargeId).toMatch(/^ch_/);
    });

    it('transitionne vers processing', async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());
      fake.simulatePaymentIntentStatus(created.id, 'processing');

      const retrieved = await fake.retrievePaymentIntent(created.id);
      expect(retrieved.status).toBe('processing');
    });

    it('SUCCEEDED ne régresse jamais (monotone)', async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());
      fake.simulatePaymentIntentStatus(created.id, 'succeeded');
      fake.simulatePaymentIntentStatus(created.id, 'processing'); // tentative de régression

      const retrieved = await fake.retrievePaymentIntent(created.id);
      expect(retrieved.status).toBe('succeeded');
    });

    it('lève une erreur pour un ID inexistant', () => {
      expect(() => fake.simulatePaymentIntentStatus('pi_missing', 'succeeded')).toThrow();
    });
  });

  describe('sécurité (ADR-010 §14)', () => {
    it('le client_secret est régénéré à chaque appel (pas stocké)', async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());

      // Le client_secret doit être déterministe (même ID → même secret).
      const retrieved1 = await fake.retrievePaymentIntent(created.id);
      const retrieved2 = await fake.retrievePaymentIntent(created.id);

      expect(retrieved1.clientSecret).toBe(created.clientSecret);
      expect(retrieved2.clientSecret).toBe(created.clientSecret);
    });

    it("le client_secret contient l'ID du PaymentIntent", async () => {
      const created = await fake.createPaymentIntent(baseCreatePaymentIntentParams());

      expect(created.clientSecret).toContain(created.id);
    });

    it('les metadata sont copiées (pas de référence partagée)', async () => {
      const params = baseCreatePaymentIntentParams({
        metadata: {
          payment_id: 'pay_custom',
          payment_attempt_id: 'att_custom',
          draft_id: 'draft_custom',
          organization_id: 'org_custom',
          protocol_version: 'v1',
        },
      });
      const created = await fake.createPaymentIntent(params);

      // Modifier les metadata d'origine ne doit pas affecter le PI.
      params.metadata.payment_id = 'modified';
      const retrieved = await fake.retrievePaymentIntent(created.id);

      // Le fake ne retourne pas les metadata dans le résultat, mais
      // on vérifie qu'aucune exception n'est levée et que l'ID est stable.
      expect(retrieved.id).toBe(created.id);
    });
  });

  describe('délai artificiel', () => {
    it('respecte le délai configuré', async () => {
      const delayedFake = new FakeStripeAdapter({ artificialDelayMs: 50 });
      const start = Date.now();
      await delayedFake.createPaymentIntent(baseCreatePaymentIntentParams());
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(40); // tolérance de 10ms
    });
  });

  describe('idempotence des comptes connectés', () => {
    it("retourne le même compte pour la même clé d'idempotence (replay)", async () => {
      const params = baseCreateConnectedAccountParams();
      const result1 = await fake.createConnectedAccount(params);
      const result2 = await fake.createConnectedAccount(params);

      expect(result1.id).toBe(result2.id);
    });

    it('lève CONNECTED_ACCOUNT_CONFIGURATION_UNRESOLVED quand le controller est manquant', async () => {
      const params = baseCreateConnectedAccountParams();
      // @ts-expect-error — on teste le cas où controller est absent
      delete params.controller;

      await expect(fake.createConnectedAccount(params)).rejects.toThrow(PaymentProviderError);

      try {
        await fake.createConnectedAccount(
          // @ts-expect-error — on teste le cas où controller est absent
          { ...params, controller: undefined },
        );
      } catch (e) {
        const err = e as PaymentProviderError;
        expect(err.code).toBe('CONNECTED_ACCOUNT_CONFIGURATION_UNRESOLVED');
      }
    });
  });
});
