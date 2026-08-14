import { describe, expect, it } from 'vitest';
import { FakeStripeAdapter } from './fake-stripe-adapter';
import type { CreatePaymentIntentParams } from './types';

const amendmentMetadata = {
  payment_type: 'AMENDMENT' as const,
  amendment_payment_attempt_id: '11111111-1111-4111-8111-111111111111',
  amendment_id: '22222222-2222-4222-8222-222222222222',
  organization_id: '33333333-3333-4333-8333-333333333333',
  environment: 'TEST' as const,
  protocol_version: 'booking-amendment-payment-v1' as const,
};

function params(metadata: CreatePaymentIntentParams['metadata']): CreatePaymentIntentParams {
  return {
    amountMinor: 5000,
    currency: 'EUR',
    connectedAccountId: 'acct_connected',
    applicationFeeAmountMinor: 250,
    onBehalfOfAccountId: 'acct_connected',
    idempotencyKey: 'pi_amendment_metadata_test',
    metadata,
  };
}

describe('metadata PaymentIntent SUPPLEMENT', () => {
  it('accepte exactement le contrat amendment fermé', async () => {
    const result = await new FakeStripeAdapter().createPaymentIntent(params(amendmentMetadata));
    expect(result.id).toMatch(/^pi_/);
  });

  it('refuse une clé inconnue', async () => {
    const metadata = {
      ...amendmentMetadata,
      unexpected: 'value',
    } as unknown as CreatePaymentIntentParams['metadata'];
    await expect(
      new FakeStripeAdapter().createPaymentIntent(params(metadata)),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      providerErrorCode: 'invalid_metadata',
    });
  });

  it('refuse un payment_type inconnu', async () => {
    const metadata = {
      ...amendmentMetadata,
      payment_type: 'UNKNOWN',
    } as unknown as CreatePaymentIntentParams['metadata'];
    await expect(
      new FakeStripeAdapter().createPaymentIntent(params(metadata)),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      providerErrorCode: 'invalid_metadata',
    });
  });

  it('refuse un UUID amendment invalide', async () => {
    const metadata = {
      ...amendmentMetadata,
      amendment_id: 'not-a-uuid',
    } as unknown as CreatePaymentIntentParams['metadata'];
    await expect(
      new FakeStripeAdapter().createPaymentIntent(params(metadata)),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      providerErrorCode: 'invalid_metadata',
    });
  });

  it('refuse un environnement amendment invalide', async () => {
    const metadata = {
      ...amendmentMetadata,
      environment: 'SANDBOX',
    } as unknown as CreatePaymentIntentParams['metadata'];
    await expect(
      new FakeStripeAdapter().createPaymentIntent(params(metadata)),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      providerErrorCode: 'invalid_metadata',
    });
  });

  it('refuse une metadata initiale avec un champ supplémentaire', async () => {
    const metadata = {
      payment_id: 'pay_123',
      payment_attempt_id: 'att_123',
      draft_id: 'draft_123',
      organization_id: 'org_123',
      protocol_version: 'v1',
      extra: 'forbidden',
    } as unknown as CreatePaymentIntentParams['metadata'];
    await expect(
      new FakeStripeAdapter().createPaymentIntent(params(metadata)),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      providerErrorCode: 'invalid_metadata',
    });
  });

  it('préserve une metadata initiale historique valide', async () => {
    const result = await new FakeStripeAdapter().createPaymentIntent(
      params({
        payment_id: 'pay_123',
        payment_attempt_id: 'att_123',
        draft_id: 'draft_123',
        organization_id: 'org_123',
        protocol_version: 'v1',
      }),
    );
    expect(result.id).toMatch(/^pi_/);
  });

  it('refuse un protocole amendment incorrect', async () => {
    const metadata = {
      ...amendmentMetadata,
      protocol_version: 'v2',
    } as unknown as CreatePaymentIntentParams['metadata'];
    await expect(
      new FakeStripeAdapter().createPaymentIntent(params(metadata)),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      providerErrorCode: 'invalid_metadata',
    });
  });
});
