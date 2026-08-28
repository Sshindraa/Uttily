import {
  RESEND_IDEMPOTENCY_WINDOW_MS,
  isProviderIdempotencyWindowExpired,
} from './provider-idempotency-window';

export interface NotificationRetryCandidate {
  readonly status: string;
  readonly failureCode?: string | null;
  readonly requiresManualReview?: boolean | null;
  readonly attemptCount?: number | null;
  readonly failedAt?: Date | null;
  readonly providerFirstAttemptStartedAt?: Date | null;
}

export type ManualNotificationRetryValidationResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: ManualNotificationRetryRefusalCode;
      readonly reason: string;
    };

/**
 * Codes de refus fermés de la politique de relance manuelle (V1).
 * Toute branche de refus est explicitement nommée : aucun refus implicite.
 */
export type ManualNotificationRetryRefusalCode =
  | 'INVALID_STATUS'
  | 'DETERMINISTIC_FAILURE_NO_RETRY'
  | 'UNCERTAIN_WINDOW_EXPIRED_NO_RETRY'
  | 'MAX_RETRIES_WINDOW_UNDETERMINABLE'
  | 'MAX_RETRIES_IDEMPOTENCY_WINDOW_EXPIRED'
  | 'FAILURE_CODE_FAIL_CLOSED';

/**
 * Politique métier FERMÉE de relance manuelle des notifications transactionnelles
 * (Chantier 16.1 puis 16.1.1).
 *
 * Invariants de sécurité (fail-closed par défaut) :
 * 1. Seul le statut FAILED est candidat à une relance manuelle.
 * 2. `PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED` (fenêtre d'idempotence provider
 *    24 h dépassée en état incertain) => refus STRICT, quel que soit le contexte :
 *    le provider ne déduplique plus, un renvoi doublerait l'email du client.
 * 3. `INVALID_REQUEST` / erreur déterministe provider => refus manuel : répéter
 *    la même requête ne corrige pas la cause (destinataire invalide, payload
 *    refusé). La correction passe par la réparation de la donnée, pas par un retry.
 * 4. `MAX_RETRIES_EXCEEDED` => décision EXPLICITE fondée sur
 *    `providerFirstAttemptStartedAt` et la fenêtre d'idempotence provider
 *    (constante partagée `RESEND_IDEMPOTENCY_WINDOW_MS`) :
 *      - fenêtre sûre dépassée OU indéterminable (horodatage absent) => refus fail-closed ;
 *      - encore dans la fenêtre sûre => relance manuelle autorisée, avec motif
 *        obligatoire (garanti par `retryNotificationSupport` qui exige un motif
 *        non vide et le consigne dans l'audit).
 * 5. Tout autre code d'échec FAILED (inconnu, legacy, brut, ou absent) =>
 *    refus fail-closed : la politique est une allowlist fermée, pas une
 *    denylist (« tout FAILED sauf un code » est interdit).
 *
 * L'horloge est injectable (`now`) pour des tests déterministes ; en production
 * la décision de relance reste subordonnée à la fenêtre provider, indépendamment
 * de l'horloge de la base.
 */
export function validateManualNotificationRetry(
  notification: NotificationRetryCandidate,
  now: Date = new Date(),
): ManualNotificationRetryValidationResult {
  if (notification.status !== 'FAILED') {
    return {
      allowed: false,
      code: 'INVALID_STATUS',
      reason: `Seules les notifications en statut FAILED peuvent être relancées (statut actuel: ${notification.status}).`,
    };
  }

  const failureCode = notification.failureCode?.trim();

  if (!failureCode) {
    return {
      allowed: false,
      code: 'FAILURE_CODE_FAIL_CLOSED',
      reason:
        'Relance refusée (fail-closed) : notification FAILED sans code d’échec exploitable — la cause réelle est inconnue.',
    };
  }

  if (failureCode === 'PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED') {
    return {
      allowed: false,
      code: 'UNCERTAIN_WINDOW_EXPIRED_NO_RETRY',
      reason:
        'Relance interdite : la fenêtre d’incertitude du provider est expirée (risque de double envoi d’email).',
    };
  }

  if (failureCode === 'INVALID_REQUEST') {
    return {
      allowed: false,
      code: 'DETERMINISTIC_FAILURE_NO_RETRY',
      reason:
        'Relance manuelle refusée : erreur déterministe du provider (INVALID_REQUEST). Répéter la même requête ne corrige pas la cause.',
    };
  }

  if (failureCode === 'MAX_RETRIES_EXCEEDED') {
    if (!notification.providerFirstAttemptStartedAt) {
      return {
        allowed: false,
        code: 'MAX_RETRIES_WINDOW_UNDETERMINABLE',
        reason:
          'Relance refusée (fail-closed) : budget de tentatives épuisé et horodatage de première tentative provider absent — la fenêtre d’idempotence provider est indéterminable.',
      };
    }

    if (isProviderIdempotencyWindowExpired(notification.providerFirstAttemptStartedAt, now)) {
      return {
        allowed: false,
        code: 'MAX_RETRIES_IDEMPOTENCY_WINDOW_EXPIRED',
        reason: `Relance refusée (fail-closed) : la fenêtre d’idempotence provider (${Math.round(RESEND_IDEMPOTENCY_WINDOW_MS / 3_600_000)} h) est dépassée depuis la première tentative — un renvoi ne serait plus dédupliqué par le provider.`,
      };
    }

    // Encore dans la fenêtre sûre : le provider déduplique via la clé d'idempotence
    // conservée par la notification. Le motif de la relance reste obligatoire
    // (imposé par retryNotificationSupport) et est consigné dans l'audit.
    return { allowed: true };
  }

  return {
    allowed: false,
    code: 'FAILURE_CODE_FAIL_CLOSED',
    reason: `Relance refusée (fail-closed) : code d’échec FAILED inconnu ou non autorisé par la politique fermée V1 ("${failureCode}").`,
  };
}
