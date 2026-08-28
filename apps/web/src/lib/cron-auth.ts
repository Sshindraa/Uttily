/**
 * apps/web — Authentification partagée des endpoints Cron (Chantier 18-A).
 *
 * Factorise la convention cron déjà appliquée par les routes existantes
 * (`expire-holds`, `reconcile-payments`, `process-compensations`,
 * `process-refund-requests`) : secret partagé `CRON_SECRET` transmis via
 * `Authorization: Bearer <secret>`, refus fail-closed si le secret est absent
 * ou vide, et comparaison à temps constant contre les timing attacks.
 *
 * Aucun journal ni réponse ne contient le secret, ni sa longueur.
 */

/**
 * Vérifie le secret partagé CRON_SECRET via le header Authorization.
 * Utilise une comparaison à temps constant pour éviter les timing attacks.
 *
 * Fail-closed : si `CRON_SECRET` est absent ou vide, la requête est refusée.
 *
 * @returns true si l'authentification est valide, false sinon.
 */
export function verifyCronSecret(request: Request): boolean {
  const authHeader = request.headers.get('Authorization');
  const cronSecret = process.env.CRON_SECRET;

  // Pas de secret configuré → refuser (fail-closed).
  if (!cronSecret) {
    return false;
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.substring(7);

  // Comparaison à temps constant pour éviter les timing attacks.
  if (token.length !== cronSecret.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ cronSecret.charCodeAt(i);
  }
  return diff === 0;
}
