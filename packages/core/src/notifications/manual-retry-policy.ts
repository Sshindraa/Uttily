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
  | { readonly allowed: false; readonly code: string; readonly reason: string };

/**
 * Politique métier de relance manuelle des notifications transactionnelles (Chantier 16.1).
 *
 * Invariants de sécurité :
 * 1. Seul le statut FAILED est candidat à une relance manuelle.
 * 2. Si le failureCode est PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED (délai d'incertitude 24h Resend dépassé),
 *    la relance est strictement interdite (fail-closed) pour éviter tout risque de double envoi d'email au client.
 * 3. Les statuts SENT, PENDING, SENDING et CANCELLED sont systématiquement refusés.
 */
export function validateManualNotificationRetry(
  notification: NotificationRetryCandidate,
): ManualNotificationRetryValidationResult {
  if (notification.status !== 'FAILED') {
    return {
      allowed: false,
      code: 'INVALID_STATUS',
      reason: `Seules les notifications en statut FAILED peuvent être relancées (statut actuel: ${notification.status}).`,
    };
  }

  if (notification.failureCode === 'PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED') {
    return {
      allowed: false,
      code: 'UNCERTAIN_WINDOW_EXPIRED_NO_RETRY',
      reason:
        'Relance interdite : la fenêtre d’incertitude du provider est expirée (risque de double envoi d’email).',
    };
  }

  return { allowed: true };
}
