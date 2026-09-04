'use server';

import { revalidatePath } from 'next/cache';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';
import { clerkClient } from '@clerk/nextjs/server';
import {
  extendPrivacyRequestDeadline,
  flagPrivacyRequestIdentityCheck,
  recordExtensionNotification,
  recordPrivacyResponseNotification,
  resolvePrivacyRequest,
  startPrivacyRequestReview,
  executeErasurePrivacyRequest,
  type EraseUserAccountResult,
  PrivacySupportActionError,
} from '@uttily/core';
import type { ActionResult } from '@uttily/contracts';

function handleActionError(err: unknown): ActionResult<never> {
  const message = err instanceof Error ? err.message : 'Échec de l’action support privacy.';
  const name = err instanceof Error ? err.name : '';

  if (message === 'UNAUTHENTICATED') {
    return { ok: false, code: 'UNAUTHENTICATED', message: 'Non authentifié.' };
  }
  if (name === 'AuthorizationError') {
    return { ok: false, code: 'SUPPORT_UNAUTHORIZED', message };
  }
  if (err instanceof PrivacySupportActionError && err.code === 'NOT_FOUND') {
    return { ok: false, code: 'NOT_FOUND', message: err.message };
  }
  return {
    ok: false,
    code: 'SUPPORT_ACTION_INVALID_STATE',
    message,
  };
}

/**
 * 1. Prise en charge d'une demande de droits RGPD.
 */
export async function startPrivacyReviewAction(
  requestId: string,
): Promise<ActionResult<{ ok: true; requestId: string; status: 'IN_REVIEW' }>> {
  try {
    const { db, user } = await requireSupportPlatformAdmin();
    const result = await startPrivacyRequestReview(db, {
      requestId,
      actorUserId: user.id,
    });
    revalidatePath('/internal/privacy');
    return { ok: true, data: result };
  } catch (err: unknown) {
    return handleActionError(err);
  }
}

/**
 * 2. Demande de vérification d'identité complémentaire (doute raisonnable).
 */
export async function flagPrivacyIdentityCheckAction(
  requestId: string,
): Promise<ActionResult<{ ok: true; requestId: string; status: 'IDENTITY_CHECK_REQUIRED' }>> {
  try {
    const { db, user } = await requireSupportPlatformAdmin();
    const result = await flagPrivacyRequestIdentityCheck(db, {
      requestId,
      actorUserId: user.id,
    });
    revalidatePath('/internal/privacy');
    return { ok: true, data: result };
  } catch (err: unknown) {
    return handleActionError(err);
  }
}

/**
 * 3. Prolongation d'échéance légale (+2 mois max, Art. 12.3 RGPD).
 */
export async function extendPrivacyDeadlineAction(
  requestId: string,
  input: {
    extendedUntil: string;
    reason: string;
  },
): Promise<ActionResult<{ ok: true; requestId: string; extendedUntil: Date }>> {
  try {
    const { db, user } = await requireSupportPlatformAdmin();
    const date = new Date(input.extendedUntil);
    if (isNaN(date.getTime())) {
      return {
        ok: false,
        code: 'VALIDATION',
        message: 'Format de date de prolongation invalide.',
      };
    }

    const result = await extendPrivacyRequestDeadline(db, {
      requestId,
      actorUserId: user.id,
      extendedUntil: date,
      reason: input.reason,
    });
    revalidatePath('/internal/privacy');
    return { ok: true, data: result };
  } catch (err: unknown) {
    return handleActionError(err);
  }
}

/**
 * 3b. Consignation de la preuve d'information du demandeur (Art. 12.3 RGPD).
 * Le SLA effectif n'est prolongé qu'après cette consignation.
 */
export async function recordExtensionNotificationAction(
  requestId: string,
): Promise<ActionResult<{ ok: true; requestId: string; notifiedAt: Date }>> {
  try {
    const { db, user } = await requireSupportPlatformAdmin();
    const result = await recordExtensionNotification(db, {
      requestId,
      actorUserId: user.id,
    });
    revalidatePath('/internal/privacy');
    return { ok: true, data: result };
  } catch (err: unknown) {
    return handleActionError(err);
  }
}

/**
 * 4. Décision interne motivée (Art. 12.3 & 12.4 RGPD).
 * Passe la demande en DECISION_READY (la demande reste ouverte tant que non notifiée).
 */
export async function resolvePrivacyRequestAction(
  requestId: string,
  input: {
    resolutionStatus: 'FULFILLED' | 'PARTIALLY_FULFILLED' | 'REFUSED';
    decisionReasonCode?: string | null;
    resolutionNotes: string;
  },
): Promise<
  ActionResult<{
    ok: true;
    requestId: string;
    status: 'DECISION_READY';
    resolution: 'FULFILLED' | 'PARTIALLY_FULFILLED' | 'REFUSED';
  }>
> {
  try {
    const { db, user } = await requireSupportPlatformAdmin();
    const result = await resolvePrivacyRequest(db, {
      requestId,
      actorUserId: user.id,
      resolutionStatus: input.resolutionStatus,
      decisionReasonCode: input.decisionReasonCode,
      resolutionNotes: input.resolutionNotes,
    });
    revalidatePath('/internal/privacy');
    return { ok: true, data: result };
  } catch (err: unknown) {
    return handleActionError(err);
  }
}

/**
 * 5. Attestation de l’envoi de la réponse au demandeur (Art. 12.3 & 12.4 RGPD).
 * Clôture effective de la demande (passage à COMPLETED).
 */
export async function recordPrivacyResponseNotificationAction(requestId: string): Promise<
  ActionResult<{
    ok: true;
    requestId: string;
    status: 'COMPLETED';
    responseNotifiedAt: Date;
  }>
> {
  try {
    const { db, user } = await requireSupportPlatformAdmin();
    const result = await recordPrivacyResponseNotification(db, {
      requestId,
      actorUserId: user.id,
    });
    revalidatePath('/internal/privacy');
    return { ok: true, data: result };
  } catch (err: unknown) {
    return handleActionError(err);
  }
}

/**
 * 6. Exécution de l'effacement RGPD et scellement probatoire (Art. 17 RGPD, ADR-039).
 */
export async function executeSupportErasureAction(
  requestId: string,
): Promise<ActionResult<EraseUserAccountResult>> {
  try {
    const { db, user } = await requireSupportPlatformAdmin();
    const result = await executeErasurePrivacyRequest(db, {
      requestId,
      actorUserId: user.id,
      deleteExternalIdentity: async (oidcSubject: string) => {
        try {
          const client = await clerkClient();
          await client.users.deleteUser(oidcSubject);
        } catch (clerkErr) {
          const isNotFound =
            clerkErr instanceof Error &&
            (clerkErr.message.includes('404') || clerkErr.message.toLowerCase().includes('not found'));
          if (!isNotFound) {
            console.error('[SupportPrivacyErasure] Clerk deletion warning:', clerkErr);
          }
        }
      },
    });
    revalidatePath('/internal/privacy');
    return { ok: true, data: result };
  } catch (err: unknown) {
    return handleActionError(err);
  }
}

