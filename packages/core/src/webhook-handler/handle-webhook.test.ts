/**
 * @uttily/core — Tests unitaires du module Webhook Handler (Lot 5, ADR-010).
 *
 * Tests sans DB : extraction, projection monotone, validation, signature.
 */

import { describe, it, expect } from 'vitest';
import { extractPaymentIntentEventData } from './extract-event';
import { projectAttemptStatus, isStaleEvent } from './project-status';
import { computePayloadSha256 } from './dedupe-event';
import { FakeStripeAdapter } from '../payments/fake-stripe-adapter';
import type { VerifiedWebhookEvent } from '../payments/types';

// ─────────────────────────────────────────────────────────────────────────────
// extractPaymentIntentEventData
// ─────────────────────────────────────────────────────────────────────────────

describe('extractPaymentIntentEventData', () => {
  function makeEvent(data: Record<string, unknown>): VerifiedWebhookEvent {
    return {
      id: 'evt_test_1',
      type: 'payment_intent.succeeded',
      created: Math.floor(Date.now() / 1000),
      apiVersion: '2026-06-24.dahlia',
      objectId: 'pi_test_1',
      accountId: null,
      data,
    };
  }

  it('extrait les champs requis depuis des données valides', () => {
    const event = makeEvent({
      id: 'pi_test_123',
      status: 'succeeded',
      amount: 10000,
      currency: 'eur',
      metadata: {
        payment_id: 'pay_1',
        payment_attempt_id: 'att_1',
        draft_id: 'draft_1',
        organization_id: 'org_1',
        protocol_version: 'v1',
      },
    });
    const result = extractPaymentIntentEventData(event);
    expect(result.id).toBe('pi_test_123');
    expect(result.status).toBe('succeeded');
    expect(result.amount).toBe(10000);
    expect(result.currency).toBe('eur');
    expect(result.metadata?.payment_id).toBe('pay_1');
    expect(result.metadata?.payment_attempt_id).toBe('att_1');
    expect(result.metadata?.draft_id).toBe('draft_1');
    expect(result.metadata?.organization_id).toBe('org_1');
    expect(result.metadata?.protocol_version).toBe('v1');
  });

  it('gère les metadata absentes', () => {
    const event = makeEvent({
      id: 'pi_test_123',
      status: 'succeeded',
      amount: 10000,
      currency: 'eur',
    });
    const result = extractPaymentIntentEventData(event);
    expect(result.metadata).toEqual({});
  });

  it('filtre les clés metadata non autorisées', () => {
    const event = makeEvent({
      id: 'pi_test_123',
      status: 'succeeded',
      amount: 10000,
      currency: 'eur',
      metadata: {
        payment_id: 'pay_1',
        card_number: '4242424242424242', // ne doit pas être extrait
      },
    });
    const result = extractPaymentIntentEventData(event);
    expect(result.metadata?.payment_id).toBe('pay_1');
    expect((result.metadata as Record<string, unknown>).card_number).toBeUndefined();
  });

  it('lève une erreur si id est manquant', () => {
    const event = makeEvent({ status: 'succeeded', amount: 10000, currency: 'eur' });
    expect(() => extractPaymentIntentEventData(event)).toThrow();
  });

  it('lève une erreur si status est manquant', () => {
    const event = makeEvent({ id: 'pi_1', amount: 10000, currency: 'eur' });
    expect(() => extractPaymentIntentEventData(event)).toThrow();
  });

  it("lève une erreur si amount n'est pas un entier", () => {
    const event = makeEvent({
      id: 'pi_1',
      status: 'succeeded',
      amount: 100.5,
      currency: 'eur',
    });
    expect(() => extractPaymentIntentEventData(event)).toThrow();
  });

  it('lève une erreur si currency est manquante', () => {
    const event = makeEvent({ id: 'pi_1', status: 'succeeded', amount: 10000 });
    expect(() => extractPaymentIntentEventData(event)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// projectAttemptStatus
// ─────────────────────────────────────────────────────────────────────────────

describe('projectAttemptStatus', () => {
  it('payment_intent.succeeded → SUCCEEDED depuis un statut non terminal', () => {
    const result = projectAttemptStatus('payment_intent.succeeded', 'PROCESSING');
    expect(result.newStatus).toBe('SUCCEEDED');
    expect(result.ignored).toBe(false);
  });

  it('payment_intent.succeeded → ignoré si déjà SUCCEEDED (doublon)', () => {
    const result = projectAttemptStatus('payment_intent.succeeded', 'SUCCEEDED');
    expect(result.newStatus).toBeNull();
    expect(result.ignored).toBe(true);
  });

  it('payment_intent.succeeded → ignoré si déjà FAILED (incohérence)', () => {
    const result = projectAttemptStatus('payment_intent.succeeded', 'FAILED');
    expect(result.newStatus).toBeNull();
    expect(result.ignored).toBe(true);
  });

  it('payment_intent.succeeded → ignoré si déjà CANCELLED (incohérence)', () => {
    const result = projectAttemptStatus('payment_intent.succeeded', 'CANCELLED');
    expect(result.newStatus).toBeNull();
    expect(result.ignored).toBe(true);
  });

  it('payment_intent.canceled → CANCELLED depuis un statut non terminal', () => {
    const result = projectAttemptStatus('payment_intent.canceled', 'PROCESSING');
    expect(result.newStatus).toBe('CANCELLED');
    expect(result.ignored).toBe(false);
  });

  it('payment_intent.canceled → ignoré si déjà CANCELLED (doublon)', () => {
    const result = projectAttemptStatus('payment_intent.canceled', 'CANCELLED');
    expect(result.newStatus).toBeNull();
    expect(result.ignored).toBe(true);
  });

  it('payment_intent.canceled → ignoré si déjà SUCCEEDED (incohérence)', () => {
    const result = projectAttemptStatus('payment_intent.canceled', 'SUCCEEDED');
    expect(result.newStatus).toBeNull();
    expect(result.ignored).toBe(true);
  });

  it('payment_intent.processing → PROCESSING depuis un statut non terminal', () => {
    const result = projectAttemptStatus('payment_intent.processing', 'PENDING_PROVIDER');
    expect(result.newStatus).toBe('PROCESSING');
    expect(result.ignored).toBe(false);
  });

  it('payment_intent.processing → ignoré si déjà PROCESSING', () => {
    const result = projectAttemptStatus('payment_intent.processing', 'PROCESSING');
    expect(result.newStatus).toBeNull();
    expect(result.ignored).toBe(true);
  });

  it('payment_intent.processing → ignoré si déjà SUCCEEDED (pas de régression)', () => {
    const result = projectAttemptStatus('payment_intent.processing', 'SUCCEEDED');
    expect(result.newStatus).toBeNull();
    expect(result.ignored).toBe(true);
  });

  it('payment_intent.payment_failed → REQUIRES_PAYMENT_METHOD depuis un statut non terminal', () => {
    const result = projectAttemptStatus('payment_intent.payment_failed', 'PROCESSING');
    expect(result.newStatus).toBe('REQUIRES_PAYMENT_METHOD');
    expect(result.ignored).toBe(false);
  });

  it('payment_intent.payment_failed → ignoré si déjà REQUIRES_PAYMENT_METHOD', () => {
    const result = projectAttemptStatus('payment_intent.payment_failed', 'REQUIRES_PAYMENT_METHOD');
    expect(result.newStatus).toBeNull();
    expect(result.ignored).toBe(true);
  });

  it('payment_intent.payment_failed → ignoré si déjà SUCCEEDED (pas de régression)', () => {
    const result = projectAttemptStatus('payment_intent.payment_failed', 'SUCCEEDED');
    expect(result.newStatus).toBeNull();
    expect(result.ignored).toBe(true);
  });

  it('événement inconnu → ignoré (fail-closed)', () => {
    const result = projectAttemptStatus('charge.refunded', 'PROCESSING');
    expect(result.newStatus).toBeNull();
    expect(result.ignored).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isStaleEvent
// ─────────────────────────────────────────────────────────────────────────────

describe('isStaleEvent', () => {
  it('retourne false si aucun événement précédent', () => {
    expect(isStaleEvent(1000, null)).toBe(false);
  });

  it("retourne true si l'événement est plus ancien", () => {
    expect(isStaleEvent(1000, 2000)).toBe(true);
  });

  it("retourne false si l'événement est plus récent", () => {
    expect(isStaleEvent(3000, 2000)).toBe(false);
  });

  it("retourne false si l'événement a le même timestamp", () => {
    expect(isStaleEvent(2000, 2000)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computePayloadSha256
// ─────────────────────────────────────────────────────────────────────────────

describe('computePayloadSha256', () => {
  it('retourne un hash SHA-256 hex de 64 caractères', () => {
    const hash = computePayloadSha256('test body');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('est déterministe (même entrée → même hash)', () => {
    const hash1 = computePayloadSha256('test body');
    const hash2 = computePayloadSha256('test body');
    expect(hash1).toBe(hash2);
  });

  it('produit des hashes différents pour des entrées différentes', () => {
    const hash1 = computePayloadSha256('body1');
    const hash2 = computePayloadSha256('body2');
    expect(hash1).not.toBe(hash2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FakeStripeAdapter — verifyWebhook
// ─────────────────────────────────────────────────────────────────────────────

describe('FakeStripeAdapter — verifyWebhook', () => {
  it('valide une signature correcte', async () => {
    const adapter = new FakeStripeAdapter({
      platformWebhookSecret: 'whsec_test_platform',
      environment: 'TEST',
    });
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'pi_1', status: 'succeeded', amount: 10000, currency: 'eur' } },
    });
    const signature = adapter.generateValidSignature(body, 'platform');
    const result = await adapter.verifyWebhook({
      rawBody: body,
      signature,
      endpoint: 'platform',
      environment: 'TEST',
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.event.type).toBe('payment_intent.succeeded');
      expect(result.event.objectId).toBe('pi_1');
    }
  });

  it('rejette une signature invalide', async () => {
    const adapter = new FakeStripeAdapter({
      platformWebhookSecret: 'whsec_test_platform',
      environment: 'TEST',
    });
    const body = JSON.stringify({ id: 'evt_1', type: 'test' });
    const result = await adapter.verifyWebhook({
      rawBody: body,
      signature: 't=123,v1=invalid',
      endpoint: 'platform',
      environment: 'TEST',
    });
    expect(result.valid).toBe(false);
  });

  it('rejette un corps altéré (signature ne correspond plus)', async () => {
    const adapter = new FakeStripeAdapter({
      platformWebhookSecret: 'whsec_test_platform',
      environment: 'TEST',
    });
    const originalBody = JSON.stringify({ id: 'evt_1', type: 'test' });
    const signature = adapter.generateValidSignature(originalBody, 'platform');
    const tamperedBody = JSON.stringify({ id: 'evt_1', type: 'tampered' });
    const result = await adapter.verifyWebhook({
      rawBody: tamperedBody,
      signature,
      endpoint: 'platform',
      environment: 'TEST',
    });
    expect(result.valid).toBe(false);
  });

  it('rejette une signature vide', async () => {
    const adapter = new FakeStripeAdapter({
      platformWebhookSecret: 'whsec_test_platform',
      environment: 'TEST',
    });
    const body = JSON.stringify({ id: 'evt_1', type: 'test' });
    const result = await adapter.verifyWebhook({
      rawBody: body,
      signature: '',
      endpoint: 'platform',
      environment: 'TEST',
    });
    expect(result.valid).toBe(false);
  });

  it('rejette un corps vide', async () => {
    const adapter = new FakeStripeAdapter({
      platformWebhookSecret: 'whsec_test_platform',
      environment: 'TEST',
    });
    const result = await adapter.verifyWebhook({
      rawBody: '',
      signature: 't=123,v1=abc',
      endpoint: 'platform',
      environment: 'TEST',
    });
    expect(result.valid).toBe(false);
  });

  it('utilise des secrets distincts pour platform et connect', async () => {
    const adapter = new FakeStripeAdapter({
      platformWebhookSecret: 'whsec_platform',
      connectWebhookSecret: 'whsec_connect',
      environment: 'TEST',
    });
    const body = JSON.stringify({ id: 'evt_1', type: 'test' });
    const platformSig = adapter.generateValidSignature(body, 'platform');
    // La signature platform ne doit pas valider sur connect.
    const result = await adapter.verifyWebhook({
      rawBody: body,
      signature: platformSig,
      endpoint: 'connect',
      environment: 'TEST',
    });
    expect(result.valid).toBe(false);
  });
});
