/**
 * apps/web — Endpoint webhook Stripe Connect (Lot 5, ADR-010 §9, §14).
 *
 * URL : /api/webhooks/stripe/connect
 *
 * Reçoit les événements account.updated et événements de capacité du compte
 * connecté. Vérifie la signature AVANT toute mutation, lit le corps brut une
 * seule fois, et délègue au use case handleWebhook.
 *
 * Sécurité (ADR-010 §14) :
 * - POST uniquement, runtime Node.js, force-dynamic.
 * - Signature Stripe obligatoire (fail-closed : 4xx si absente/invalide).
 * - Allow-list IP obligatoire en LIVE (fail-closed, P2-2).
 * - Rate limiting délégué à l'edge Vercel (ADR-010 §14, cf. _lib/rate-limit-notice.ts).
 * - Respecte l'en-tête Stripe-Account (account connecté).
 * - Aucune donnée sensible dans la réponse.
 * - Ne jamais logger le corps webhook complet ni des secrets.
 */

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getStripeAdapter } from '@/lib/stripe';
import { handleWebhook } from '@uttily/core';
import { checkWebhookIpAllowlist } from '../_lib/ip-allowlist';
import { isRateLimitAttested } from '../_lib/rate-limit-notice';
import { resolveStripeEnvironment } from '@/lib/payment-config';

// Désactive l'optimisation statique : cet endpoint doit toujours s'exécuter
// dynamiquement (webhook Stripe).
export const dynamic = 'force-dynamic';

// Runtime Node.js obligatoire (ADR-010 §14) : les webhooks Stripe nécessitent
// le runtime Node.js pour la vérification de signature crypto.
export const runtime = 'nodejs';

/**
 * Endpoint webhook Stripe Connect.
 *
 * @see ADR-010 §9, §14
 */
export async function POST(request: Request): Promise<NextResponse> {
  // 1. Lire le corps brut une seule fois (avant toute interprétation JSON).
  const rawBody = await request.text();

  // 2. Extraire la signature Stripe.
  const signature = request.headers.get('Stripe-Signature');
  if (!signature) {
    console.warn(
      JSON.stringify({
        event: 'webhook.stripe',
        endpoint: 'connect',
        result: 'missing_signature',
      }),
    );
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  // 3. Déterminer l'environnement avec validation runtime. En production,
  // l'absence de configuration ne doit jamais devenir TEST implicitement.
  let environment;
  try {
    environment = resolveStripeEnvironment();
  } catch {
    console.error(
      JSON.stringify({
        event: 'webhook.stripe',
        endpoint: 'connect',
        result: 'invalid_environment',
      }),
    );
    return NextResponse.json({ error: 'Invalid environment' }, { status: 500 });
  }

  // P2-1 : Allow-list IP conditionnelle (ADR-010 §14). Si
  // STRIPE_WEBHOOK_IP_ALLOWLIST est défini, vérifier que l'IP du client est
  // dans la liste. Sinon, skip (en TEST/dev, pas de check).
  const ipCheck = checkWebhookIpAllowlist(request);
  if (!ipCheck.allowed) {
    console.warn(
      JSON.stringify({
        event: 'webhook.stripe',
        endpoint: 'connect',
        result: 'ip_forbidden',
        clientIp: ipCheck.clientIp,
      }),
    );
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // P2-2 : Verrou technique d'activation LIVE — le rate limiting edge doit
  // être attesté (STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED=true) en LIVE (fail-closed).
  if (environment === 'LIVE' && !isRateLimitAttested()) {
    console.warn(
      JSON.stringify({
        event: 'webhook.stripe',
        endpoint: 'connect',
        result: 'rate_limit_not_verified',
      }),
    );
    return NextResponse.json({ error: 'Rate limiting not verified for LIVE' }, { status: 503 });
  }

  try {
    const db = getDb();
    const provider = getStripeAdapter();

    // 4. Déléguer au use case handleWebhook.
    const result = await handleWebhook(
      { db, provider },
      {
        rawBody,
        signature,
        endpoint: 'connect',
        environment,
      },
    );

    if (result.kind === 'SUCCESS') {
      return NextResponse.json({ received: true }, { status: result.statusCode });
    }

    return NextResponse.json(
      { error: result.error, message: result.message },
      { status: result.statusCode },
    );
  } catch (error) {
    // Erreur technique inattendue (ex: adapter non configuré) → 500 (Stripe retry).
    console.error(
      JSON.stringify({
        event: 'webhook.stripe',
        endpoint: 'connect',
        result: 'error',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
