'use server';

import type { ActionResult } from '@uttily/contracts';
import {
  previewBookingAmendment,
  type PreviewBookingAmendmentCommand,
  type PreviewBookingAmendmentSuccess,
  type NeutralAmendmentIntent,
} from '@uttily/core';
import { requireAmendmentManagerOf } from '@/lib/amendment-auth';
import { isValidUuid } from '@/lib/operations-helpers';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_LOCAL_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export interface PreviewBookingAmendmentLineInput {
  logicalLineId?: string;
  variantId: string;
  quantity: number;
}

export interface PreviewBookingAmendmentInput {
  bookingId: string;
  expectedLastAppliedAmendmentNumber: number;
  intent: NeutralAmendmentIntent;
  lines: PreviewBookingAmendmentLineInput[];
}

/**
 * Server Action : calcule la prévisualisation déterministe et read-only d'un amendement.
 *
 * @param organizationId UUID de l'organisation loueur.
 * @param input Paramètres de l'amendement (dates/heures cibles et quantités).
 * @returns ActionResult contenant la prévisualisation détaillée en cas de succès.
 */
export async function previewBookingAmendmentAction(
  organizationId: string,
  input: PreviewBookingAmendmentInput,
): Promise<ActionResult<PreviewBookingAmendmentSuccess>> {
  if (!isValidUuid(organizationId)) {
    return { ok: false, code: 'VALIDATION', message: 'Organisation invalide.' };
  }

  if (typeof input !== 'object' || input === null) {
    return { ok: false, code: 'VALIDATION', message: 'Données invalides.' };
  }

  if (!isValidUuid(input.bookingId)) {
    return { ok: false, code: 'VALIDATION', message: 'Réservation invalide.' };
  }

  if (
    typeof input.expectedLastAppliedAmendmentNumber !== 'number' ||
    !Number.isInteger(input.expectedLastAppliedAmendmentNumber) ||
    input.expectedLastAppliedAmendmentNumber < 0
  ) {
    return { ok: false, code: 'VALIDATION', message: 'Numéro de version invalide.' };
  }

  if (typeof input.intent !== 'object' || input.intent === null) {
    return { ok: false, code: 'VALIDATION', message: 'Intention de réservation invalide.' };
  }

  if (input.intent.kind === 'TIME_RANGE') {
    if (
      typeof input.intent.startAt !== 'string' ||
      !DATETIME_LOCAL_REGEX.test(input.intent.startAt) ||
      typeof input.intent.endAt !== 'string' ||
      !DATETIME_LOCAL_REGEX.test(input.intent.endAt)
    ) {
      return {
        ok: false,
        code: 'VALIDATION',
        message: 'Horaires invalides (format YYYY-MM-DDTHH:mm attendu).',
      };
    }
    if (input.intent.endAt <= input.intent.startAt) {
      return {
        ok: false,
        code: 'VALIDATION',
        message: 'La date et heure de fin doivent être postérieures au début.',
      };
    }
  } else if (input.intent.kind === 'DAY_RANGE') {
    if (
      typeof input.intent.startDate !== 'string' ||
      !DATE_REGEX.test(input.intent.startDate) ||
      typeof input.intent.endDateExclusive !== 'string' ||
      !DATE_REGEX.test(input.intent.endDateExclusive)
    ) {
      return {
        ok: false,
        code: 'VALIDATION',
        message: 'Dates invalides (format YYYY-MM-DD attendu).',
      };
    }
    if (input.intent.endDateExclusive <= input.intent.startDate) {
      return {
        ok: false,
        code: 'VALIDATION',
        message: 'La date de fin doit être strictement postérieure au début.',
      };
    }
  } else {
    return { ok: false, code: 'VALIDATION', message: 'Type d intention invalide.' };
  }

  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return { ok: false, code: 'VALIDATION', message: 'Articles requis.' };
  }

  for (const line of input.lines) {
    if (!isValidUuid(line.variantId)) {
      return { ok: false, code: 'VALIDATION', message: 'Identifiant de variante invalide.' };
    }
    if (
      typeof line.quantity !== 'number' ||
      !Number.isInteger(line.quantity) ||
      line.quantity < 0
    ) {
      return { ok: false, code: 'VALIDATION', message: 'Quantité invalide.' };
    }
  }

  const positiveLines = input.lines.filter((l) => l.quantity > 0);
  if (positiveLines.length === 0) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'La réservation doit comporter au moins un article avec une quantité positive.',
    };
  }

  let authContext;
  try {
    authContext = await requireAmendmentManagerOf(organizationId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg === 'UNAUTHENTICATED') {
      return { ok: false, code: 'UNAUTHENTICATED', message: 'Vous devez être connecté.' };
    }
    return { ok: false, code: 'FORBIDDEN', message: 'Accès non autorisé.' };
  }

  const { user, db } = authContext;

  const command: PreviewBookingAmendmentCommand = {
    bookingId: input.bookingId,
    expectedLastAppliedAmendmentNumber: input.expectedLastAppliedAmendmentNumber,
    intent: input.intent,
    desiredLines: input.lines.map((l) =>
      l.logicalLineId
        ? { logicalLineId: l.logicalLineId, variantId: l.variantId, quantity: l.quantity }
        : { variantId: l.variantId, quantity: l.quantity },
    ),
  };

  try {
    const result = await previewBookingAmendment(db, user, organizationId, command);

    switch (result.kind) {
      case 'SUCCESS':
        return { ok: true, data: result };
      case 'FORBIDDEN':
        return { ok: false, code: 'FORBIDDEN', message: 'Accès non autorisé.' };
      case 'NOT_FOUND':
        return { ok: false, code: 'NOT_FOUND', message: 'Réservation introuvable.' };
      case 'BOOKING_NOT_CONFIRMED':
        return {
          ok: false,
          code: 'VALIDATION',
          message: 'Seules les réservations confirmées peuvent être modifiées.',
        };
      case 'ACTIVE_AMENDMENT_EXISTS':
        return {
          ok: false,
          code: 'CONFLICT_IDEMPOTENCY',
          message: 'Une modification est déjà en cours sur cette réservation.',
        };
      case 'STALE_EFFECTIVE_BOOKING':
        return {
          ok: false,
          code: 'CONFLICT_IDEMPOTENCY',
          message: 'La réservation a été modifiée entre-temps. Veuillez recharger la page.',
        };
      case 'AVAILABILITY_CONFLICT':
        return {
          ok: false,
          code: 'CONFLICT_BLOCK',
          message: 'Certains articles ne sont plus disponibles pour les dates demandées.',
        };
      case 'INVALID_INPUT':
        return {
          ok: false,
          code: 'VALIDATION',
          message: 'Les changements demandés ne peuvent pas être prévisualisés.',
        };
      default:
        return { ok: false, code: 'UNKNOWN', message: 'Une erreur inattendue est survenue.' };
    }
  } catch {
    return {
      ok: false,
      code: 'UNKNOWN',
      message: 'Une erreur interne est survenue lors de la prévisualisation.',
    };
  }
}
