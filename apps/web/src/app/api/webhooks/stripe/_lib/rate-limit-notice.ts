/**
 * apps/web — Runbook rate limiting des webhooks Stripe (ADR-010 §14).
 *
 * Le rate limiting est délégué à l'infrastructure edge (Vercel Firewall) pour
 * le MVP. Un rate limiter applicatif basé sur Redis est autorisé par
 * l'architecture (cf. docs/architecture/overview.md) mais n'est pas justifié
 * au stade MVP : Vercel Firewall fournit une protection suffisante sans
 * introduire de dépendance opérationnelle supplémentaire.
 *
 * ## Configuration Vercel
 *
 * 1. Edge Middleware ou Vercel Firewall pour limiter le débit par IP source.
 * 2. Seuils recommandés :
 *    - Platform : 10 req/s par IP, burst 20
 *    - Connect : 5 req/s par IP, burst 10
 *    - Compatible avec les retries Stripe (exponentiel, max ~5 retries sur 24h)
 * 3. Réponse 429 avec Retry-After (ex: 5s) pour les requêtes limitées.
 *
 * ## Procédure de vérification
 *
 * 1. Avant activation LIVE : vérifier que Vercel Firewall est configuré.
 * 2. Test : envoyer > 10 req/s vers /api/webhooks/stripe/platform → 429.
 * 3. Vérifier que les webhooks Stripe légitimes ne sont pas limités.
 *
 * ## Verrou d'activation LIVE
 *
 * STRIPE_ENVIRONMENT=LIVE ne doit être activé qu'après :
 * - Configuration du Vercel Firewall (ou équivalent edge)
 * - Vérification de l'efficacité du rate limiting
 * - Configuration de l'IP allow-list (STRIPE_WEBHOOK_IP_ALLOWLIST)
 *
 * Sans rate limiting configuré, un pic de retries Stripe pourrait submerger
 * l'endpoint. La signature Stripe reste la primaire défense, mais le rate
 * limiting protège contre les pics.
 *
 * ## Verrou technique d'activation LIVE
 *
 * STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED doit être `true` pour activer
 * STRIPE_ENVIRONMENT=LIVE. Cette variable est une attestation explicite que
 * le rate limiting edge (Vercel Firewall ou équivalent) a été configuré et
 * vérifié. En LIVE, si cette variable n'est pas `true`, les endpoints
 * webhook refusent les requêtes (fail-closed).
 */
export const RATE_LIMITING_DELEGATED_TO_EDGE = true;

/**
 * Vérifie que le rate limiting edge a été attesté comme configuré.
 * En LIVE, STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED doit être `true` (fail-closed).
 */
export function isRateLimitAttested(): boolean {
  return process.env.STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED === 'true';
}
