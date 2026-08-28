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
  } catch (err: any) {
    if (err?.message === 'UNAUTHENTICATED') {
      return { ok: false, code: 'UNAUTHENTICATED', message: 'Non authentifié.' };
    }
    if (err?.name === 'AuthorizationError') {
      return { ok: false, code: 'SUPPORT_UNAUTHORIZED', message: err.message };
    }
    return {
      ok: false,
      code: 'SUPPORT_ACTION_INVALID_STATE',
      message: err?.message ?? 'Échec de l’action support.',
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
  } catch (err: any) {
    if (err?.message === 'UNAUTHENTICATED') {
      return { ok: false, code: 'UNAUTHENTICATED', message: 'Non authentifié.' };
    }
    if (err?.name === 'AuthorizationError') {
      return { ok: false, code: 'SUPPORT_UNAUTHORIZED', message: err.message };
    }
    return {
      ok: false,
      code: 'SUPPORT_ACTION_INVALID_STATE',
      message: err?.message ?? 'Échec de l’action support.',
    };
  }
}

export async function resendInvitationNotificationAction(
  invitationId: string,
  reason: string,
): Promise<ActionResult<{ ok: true; invitationId: string }>> {
  try {
    const { db, user } = await requireSupportPlatformAdmin();
    const result = await resendInvitationNotificationSupport(db, {
      invitationId,
      actorUserId: user.id,
      reason,
    });
    revalidatePath('/internal/notifications');
    return { ok: true, data: result };
  } catch (err: any) {
    if (err?.message === 'UNAUTHENTICATED') {
      return { ok: false, code: 'UNAUTHENTICATED', message: 'Non authentifié.' };
    }
    if (err?.name === 'AuthorizationError') {
      return { ok: false, code: 'SUPPORT_UNAUTHORIZED', message: err.message };
    }
    return {
      ok: false,
      code: 'SUPPORT_ACTION_INVALID_STATE',
      message: err?.message ?? 'Échec de l’action support.',
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
  } catch (err: any) {
    if (err?.message === 'UNAUTHENTICATED') {
      return { ok: false, code: 'UNAUTHENTICATED', message: 'Non authentifié.' };
    }
    if (err?.name === 'AuthorizationError') {
      return { ok: false, code: 'SUPPORT_UNAUTHORIZED', message: err.message };
    }
    return {
      ok: false,
      code: 'SUPPORT_ACTION_INVALID_STATE',
      message: err?.message ?? 'Échec de la réconciliation de paiement.',
    };
  }
}
