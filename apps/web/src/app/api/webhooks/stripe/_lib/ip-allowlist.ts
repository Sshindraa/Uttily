/**
 * apps/web — Allow-list IP conditionnelle pour les webhooks Stripe (ADR-010 §14, P2-1).
 *
 * Si `STRIPE_WEBHOOK_IP_ALLOWLIST` est défini et non vide, vérifie que l'IP du
 * client (depuis `x-forwarded-for` ou `x-real-ip`) est dans la liste. La liste
 * est une liste d'IPs séparées par des virgules.
 *
 * P2-2 : En environnement LIVE, l'allow-list est OBLIGATOIRE (fail-closed) :
 * si la variable n'est pas définie ou vide, la requête est refusée. En TEST,
 * le check est skippé si l'allow-list n'est pas définie.
 *
 * Scénario réseau supporté :
 * - Sur Vercel, `x-forwarded-for` est réécrit par la plateforme pour refléter
 *   l'IP réelle du client (anti-spoofing). Voir
 *   https://vercel.com/docs/headers/request-headers. L'allow-list IP est donc
 *   fiable sur Vercel car `x-forwarded-for` n'est pas spoofable.
 * - En local/dev (sans Vercel), `x-forwarded-for` peut être spoofé — l'allow-list
 *   ne doit pas être utilisée comme seule défense (la signature Stripe reste
 *   primaire).
 * - Le rate limiting est géré par Vercel Edge Middleware / Vercel Firewall
 *   (voir rate-limit-notice.ts).
 *
 * La signature Stripe reste obligatoire même quand l'IP est autorisée.
 */

/** Résultat du check IP. */
export interface IpAllowlistResult {
  /** true si l'IP est autorisée ou si le check est skippé (allowlist non définie). */
  allowed: boolean;
  /** L'IP du client extraite (peut être null si non déterminable). */
  clientIp: string | null;
  /** true si le check a été skippé (allowlist non définie). */
  skipped: boolean;
}

/**
 * Extrait l'IP du client depuis les en-têtes `x-forwarded-for` ou `x-real-ip`.
 * Pour `x-forwarded-for`, prend la première IP de la liste (le client originel).
 */
function extractClientIp(request: Request): string | null {
  const xForwardedFor = request.headers.get('x-forwarded-for');
  if (xForwardedFor) {
    const firstIp = xForwardedFor.split(',')[0]?.trim();
    if (firstIp) return firstIp;
  }
  const xRealIp = request.headers.get('x-real-ip');
  if (xRealIp) return xRealIp.trim();
  return null;
}

/**
 * Vérifie si l'IP du client est dans l'allow-list Stripe.
 *
 * - En LIVE : si `STRIPE_WEBHOOK_IP_ALLOWLIST` n'est pas défini ou vide →
 *   refus (fail-closed). L'allow-list est obligatoire en production.
 * - En TEST : si `STRIPE_WEBHOOK_IP_ALLOWLIST` n'est pas défini ou vide →
 *   skip (allowed=true).
 * - Si défini → l'IP du client doit être dans la liste, sinon 403.
 */
export function checkWebhookIpAllowlist(request: Request): IpAllowlistResult {
  const allowlistRaw = process.env.STRIPE_WEBHOOK_IP_ALLOWLIST;
  const clientIp = extractClientIp(request);
  const environment = process.env.STRIPE_ENVIRONMENT ?? 'TEST';
  const isLive = environment === 'LIVE';

  // P2-2 : Fail-closed en LIVE — l'allow-list est obligatoire.
  if (!allowlistRaw || allowlistRaw.trim().length === 0) {
    if (isLive) {
      // En LIVE, l'allow-list est obligatoire (fail-closed).
      return { allowed: false, clientIp, skipped: false };
    }
    return { allowed: true, clientIp, skipped: true };
  }

  const allowlist = allowlistRaw
    .split(',')
    .map((ip) => ip.trim())
    .filter((ip) => ip.length > 0);

  if (allowlist.length === 0) {
    if (isLive) {
      return { allowed: false, clientIp, skipped: false };
    }
    return { allowed: true, clientIp, skipped: true };
  }

  // Si l'IP du client ne peut pas être déterminée, refuser par défaut (fail-closed).
  if (!clientIp) {
    return { allowed: false, clientIp: null, skipped: false };
  }

  const allowed = allowlist.includes(clientIp);
  return { allowed, clientIp, skipped: false };
}
