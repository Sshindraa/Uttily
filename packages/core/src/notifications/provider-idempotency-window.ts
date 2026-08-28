/**
 * Fenêtre d'idempotence provider (Resend) — source unique partagée.
 *
 * Cette constante est LA référence de la fenêtre d'idempotence provider de 24 h
 * (ADR-013, G5H-C « Politique d'idempotence Resend < 24 h »). Elle est utilisée :
 * 1. par le moteur de notifications (`processDueNotifications`) pour basculer en
 *    `PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED` ;
 * 2. par la politique de relance manuelle (`validateManualNotificationRetry`)
 *    pour décider si une relance manuelle `MAX_RETRIES_EXCEEDED` est sûre.
 *
 * Deux consommateurs, une seule constante : aucune divergence possible.
 *
 * Note : la pipeline transactional-email (G5H-C1, table `notification_deliveries`)
 * applique volontairement un cutoff plus conservateur de 23 h (24 h − 1 h de marge
 * réseau/horloge). Ce cutoff est un choix documenté distinct de la fenêtre brute
 * provider et n'est PAS couvert par cette constante.
 */
export const RESEND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 heures

/**
 * Détermine si la fenêtre d'idempotence provider est dépassée pour une
 * notification dont la première tentative provider a commencé à
 * `firstAttemptStartedAt`. Sémantique strictement identique au moteur de
 * notifications (comparaison stricte `>`), pour qu'aucune divergence ne puisse
 * apparaître entre le basculement automatique et la décision de relance manuelle.
 *
 * Fail-closed : `firstAttemptStartedAt` absent/null/invalidité temporelle =>
 * fenêtre considérée dépassée (impossible à déterminer).
 */
export function isProviderIdempotencyWindowExpired(
  firstAttemptStartedAt: Date | null | undefined,
  now: Date,
): boolean {
  if (!(firstAttemptStartedAt instanceof Date) || Number.isNaN(firstAttemptStartedAt.getTime())) {
    return true;
  }
  return now.getTime() - firstAttemptStartedAt.getTime() > RESEND_IDEMPOTENCY_WINDOW_MS;
}
