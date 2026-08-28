'use server';

import { revalidatePath } from 'next/cache';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';
import {
  retryNotificationSupport,
  cancelNotificationSupport,
  resendInvitationNotificationSupport,
  reconcilePaymentSupport,
} from '@uttily/core';
import type { ActionResult } from '@uttily/contracts';

/**
 * Server Actions pour le Support Interne Uttily.
 * Réservé exclusivement aux administrateurs de la plateforme (fail-closed).
 */

export async function retryNotificationAction(
  notificationId: string,
  reason: string,
): Promise<ActionResult<{ ok: true; notificationId: string }>> {
  try {
    const { db, user } = await requireSupportPlatformAdmin();
    const result = await retryNotificationSupport(db, {
      notificationId,
      actorUserId: user.id,
      reason,
    });
    revalidatePath('/internal/notifications');
    return { ok: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Échec de l’action support.';
    const name = err instanceof Error ? err.name : '';
    if (message === 'UNAUTHENTICATED') {
      return { ok: false, code: 'UNAUTHENTICATED', message: 'Non authentifié.' };
    }
    if (name === 'AuthorizationError') {
      return { ok: false, code: 'SUPPORT_UNAUTHORIZED', message };
    }
    return {
      ok: false,
      code: 'SUPPORT_ACTION_INVALID_STATE',
      message,
    };
  }
}

export async function cancelNotificationAction(
  notificationId: string,
  reason: string,
): Promise<ActionResult<{ ok: true; notificationId: string }>> {
  try {
    const { db, user } = await requireSupportPlatformAdmin();
    const result = await cancelNotificationSupport(db, {
      notificationId,
      actorUserId: user.id,
      reason,
    });
    revalidatePath('/internal/notifications');
    return { ok: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Échec de l’action support.';
    const name = err instanceof Error ? err.name : '';
    if (message === 'UNAUTHENTICATED') {
      return { ok: false, code: 'UNAUTHENTICATED', message: 'Non authentifié.' };
    }
    if (name === 'AuthorizationError') {
      return { ok: false, code: 'SUPPORT_UNAUTHORIZED', message };
    }
    return {
      ok: false,
      code: 'SUPPORT_ACTION_INVALID_STATE',
      message,
    };
  }
}

export async function resendInvitationNotificationAction(
  invitationId: string,
  reason: string,
  supportRequestId: string,
): Promise<ActionResult<{ ok: true; invitationId: string }>> {
  try {
    const { db, user } = await requireSupportPlatformAdmin();
    // Garde de présence fail-closed côté action (le Core valide en plus le format UUID) :
    // un renvoi sans requestId d'intention n'atteint jamais le domaine.
    if (!supportRequestId || supportRequestId.trim().length === 0) {
      return {
        ok: false,
        code: 'SUPPORT_ACTION_INVALID_STATE',
        message:
          'supportRequestId est obligatoire pour le renvoi d’une invitation (aucun fallback silencieux).',
      };
    }
    const result = await resendInvitationNotificationSupport(db, {
      invitationId,
      actorUserId: user.id,
      reason,
      supportRequestId,
    });
    revalidatePath('/internal/notifications');
    return { ok: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Échec de l’action support.';
    const name = err instanceof Error ? err.name : '';
    if (message === 'UNAUTHENTICATED') {
      return { ok: false, code: 'UNAUTHENTICATED', message: 'Non authentifié.' };
    }
    if (name === 'AuthorizationError') {
      return { ok: false, code: 'SUPPORT_UNAUTHORIZED', message };
    }
    return {
      ok: false,
      code: 'SUPPORT_ACTION_INVALID_STATE',
      message,
    };
  }
}

export async function reconcilePaymentSupportAction(
  paymentId: string,
  reason: string,
): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const { db, user } = await requireSupportPlatformAdmin();
    const result = await reconcilePaymentSupport(db, {
      paymentId,
      actorUserId: user.id,
      reason,
    });
    revalidatePath('/internal/payments');
    return { ok: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Échec de la réconciliation de paiement.';
    const name = err instanceof Error ? err.name : '';
    if (message === 'UNAUTHENTICATED') {
      return { ok: false, code: 'UNAUTHENTICATED', message: 'Non authentifié.' };
    }
    if (name === 'AuthorizationError') {
      return { ok: false, code: 'SUPPORT_UNAUTHORIZED', message };
    }
    return {
      ok: false,
      code: 'SUPPORT_ACTION_INVALID_STATE',
      message,
    };
  }
}
