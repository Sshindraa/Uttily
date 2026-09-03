'use server';

import { revalidatePath } from 'next/cache';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  createPrivacyRequest,
  VALID_PRIVACY_REQUEST_TYPES,
  type PrivacyRequestType,
} from '@uttily/core';

export type PrivacyActionResult<T> =
  { ok: true; data: T } | { ok: false; error: string; message: string };

export interface SubmitPrivacyRequestResult {
  readonly requestId: string;
  readonly requestType: PrivacyRequestType;
  readonly responseDueAt: string;
}

/**
 * Server Action pour soumettre une demande d'exercice de droits RGPD.
 *
 * Scoped strictement à l'utilisateur connecté.
 */
export async function submitPrivacyRequestAction(
  requestTypeInput: string,
  detailsInput?: string | null,
): Promise<PrivacyActionResult<SubmitPrivacyRequestResult>> {
  const user = await getAuthenticatedUser();
  if (!user) {
    return {
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Vous devez être connecté pour soumettre une demande.',
    };
  }

  const type = requestTypeInput?.trim() as PrivacyRequestType;
  if (!VALID_PRIVACY_REQUEST_TYPES.includes(type)) {
    return {
      ok: false,
      error: 'INVALID_REQUEST_TYPE',
      message: 'Type de demande non reconnu.',
    };
  }

  const trimmedDetails = detailsInput?.trim() ? detailsInput.trim().slice(0, 4000) : null;

  try {
    const db = getDb();
    const result = await createPrivacyRequest(db, {
      userId: user.id,
      requestType: type,
      details: trimmedDetails,
    });

    revalidatePath('/[locale]/account/privacy', 'page');

    return {
      ok: true,
      data: {
        requestId: result.id,
        requestType: result.requestType,
        responseDueAt: result.responseDueAt.toISOString(),
      },
    };
  } catch {
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Une erreur est survenue lors de l’enregistrement de votre demande.',
    };
  }
}
