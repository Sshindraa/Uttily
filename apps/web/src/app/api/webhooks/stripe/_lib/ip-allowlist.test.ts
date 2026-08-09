/**
 * apps/web — Tests unitaires de l'allow-list IP des webhooks Stripe (P2-2).
 *
 * Teste le comportement fail-closed en LIVE, le skip en TEST, et l'allow-list
 * avec IPs valides/invalides.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkWebhookIpAllowlist } from './ip-allowlist';

function makeRequest(headers: Record<string, string | null> = {}): Request {
  const h = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value !== null) h.set(key, value);
  }
  return new Request('http://localhost/api/webhooks/stripe/platform', {
    method: 'POST',
    headers: h,
  });
}

describe('checkWebhookIpAllowlist', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Réinitialiser les variables d'environnement pertinentes avant chaque test.
    delete process.env.STRIPE_WEBHOOK_IP_ALLOWLIST;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('TEST environment (fail-open)', () => {
    beforeEach(() => {
      process.env.STRIPE_ENVIRONMENT = 'TEST';
    });

    it('skip si allow-list non définie (allowed=true, skipped=true)', () => {
      const result = checkWebhookIpAllowlist(makeRequest());
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
    });

    it('skip si allow-list vide', () => {
      process.env.STRIPE_WEBHOOK_IP_ALLOWLIST = '   ';
      const result = checkWebhookIpAllowlist(makeRequest());
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(true);
    });

    it('allowed si IP dans la liste', () => {
      process.env.STRIPE_WEBHOOK_IP_ALLOWLIST = '127.0.0.1,10.0.0.1';
      const result = checkWebhookIpAllowlist(makeRequest({ 'x-forwarded-for': '127.0.0.1' }));
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(false);
    });

    it('refusé si IP pas dans la liste', () => {
      process.env.STRIPE_WEBHOOK_IP_ALLOWLIST = '127.0.0.1';
      const result = checkWebhookIpAllowlist(makeRequest({ 'x-forwarded-for': '192.168.1.1' }));
      expect(result.allowed).toBe(false);
      expect(result.skipped).toBe(false);
    });

    it('refusé si IP non déterminable', () => {
      process.env.STRIPE_WEBHOOK_IP_ALLOWLIST = '127.0.0.1';
      const result = checkWebhookIpAllowlist(makeRequest());
      expect(result.allowed).toBe(false);
      expect(result.skipped).toBe(false);
    });
  });

  describe('LIVE environment (fail-closed)', () => {
    beforeEach(() => {
      process.env.STRIPE_ENVIRONMENT = 'LIVE';
    });

    it('refusé si allow-list non définie (fail-closed)', () => {
      const result = checkWebhookIpAllowlist(makeRequest());
      expect(result.allowed).toBe(false);
      expect(result.skipped).toBe(false);
    });

    it('refusé si allow-list vide (fail-closed)', () => {
      process.env.STRIPE_WEBHOOK_IP_ALLOWLIST = '   ';
      const result = checkWebhookIpAllowlist(makeRequest());
      expect(result.allowed).toBe(false);
      expect(result.skipped).toBe(false);
    });

    it('allowed si IP dans la liste', () => {
      process.env.STRIPE_WEBHOOK_IP_ALLOWLIST = '127.0.0.1,10.0.0.1';
      const result = checkWebhookIpAllowlist(makeRequest({ 'x-forwarded-for': '10.0.0.1' }));
      expect(result.allowed).toBe(true);
      expect(result.skipped).toBe(false);
    });

    it('refusé si IP pas dans la liste (fail-closed)', () => {
      process.env.STRIPE_WEBHOOK_IP_ALLOWLIST = '127.0.0.1,10.0.0.1';
      const result = checkWebhookIpAllowlist(makeRequest({ 'x-forwarded-for': '192.168.1.1' }));
      expect(result.allowed).toBe(false);
      expect(result.skipped).toBe(false);
    });
  });
});
