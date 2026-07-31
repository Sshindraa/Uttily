/**
 * apps/web — Factory pour l'adapter Stripe (Lot 5, ADR-010 §3, §14).
 *
 * Construit une instance de StripeAdapter depuis les variables d'environnement.
 * Les secrets sont lus côté serveur uniquement, jamais exposés au client.
 * L'environnement est déterminé par STRIPE_ENVIRONMENT (défaut : TEST).
 */

import { StripeAdapter, type StripeAdapterConfig } from '@uttily/core';

let cached: StripeAdapter | null = null;

/**
 * Retourne l'instance singleton de l'adapter Stripe.
 * Lit les secrets depuis les variables d'environnement.
 *
 * @throws Error si une variable requise est manquante.
 */
export function getStripeAdapter(): StripeAdapter {
  if (cached) return cached;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY est requis pour initialiser l'adapter Stripe");
  }

  const platformWebhookSecret = process.env.STRIPE_PLATFORM_WEBHOOK_SECRET;
  const connectWebhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!platformWebhookSecret) {
    throw new Error('STRIPE_PLATFORM_WEBHOOK_SECRET est requis');
  }
  if (!connectWebhookSecret) {
    throw new Error('STRIPE_CONNECT_WEBHOOK_SECRET est requis');
  }

  const rawEnvironment = process.env.STRIPE_ENVIRONMENT ?? 'TEST';
  if (rawEnvironment !== 'TEST' && rawEnvironment !== 'LIVE') {
    throw new Error(`STRIPE_ENVIRONMENT invalide : "${rawEnvironment}" (attendu : TEST ou LIVE)`);
  }
  const environment = rawEnvironment;

  const config: StripeAdapterConfig = {
    secretKey,
    platformWebhookSecret,
    connectWebhookSecret,
    environment,
    apiVersion: '2026-06-24.dahlia',
  };

  cached = new StripeAdapter(config);
  return cached;
}
