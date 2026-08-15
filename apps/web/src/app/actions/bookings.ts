'use server';

import type { ActionErrorCode, ActionResult } from '@uttily/contracts';
import {
  createBookingDraftWithHold,
  PostgresPhotoPublicationGate,
  resolvePublicBookingAuthority,
  type FlexibleCreateBookingDraftInput,
} from '@uttily/core';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export interface CreateBookingDraftIntentInput {
  kind: 'DAY_RANGE' | 'TIME_RANGE';
  startDate?: string;
  endDateExclusive?: string;
  startAt?: string;
  endAt?: string;
}

export interface CreateBookingDraftActionInput {
  publicProductId: string;
  publicLocationId: string;
  publicVariantId: string;
  quantity?: number;
  intent: CreateBookingDraftIntentInput;
  locale?: string;
  idempotencyKey: string;
}

export interface CreateBookingDraftActionSuccess {
  draftId: string;
  redirectUrl: string;
}

/**
 * Mapping fermé et exhaustif des erreurs Core vers des messages utilisateurs sûrs.
 * Ne divulgue aucun message SQL, nom de table, secret ou UUID interne.
 */
export async function mapBookingDraftError(
  error: string | undefined,
  locale: 'fr' | 'en',
): Promise<{ code: ActionErrorCode; message: string }> {
  const fr = locale === 'fr';
  switch (error) {
    case 'CONFLICT_BLOCK':
      return {
        code: 'CONFLICT_BLOCK',
        message: fr
          ? 'Cet équipement n’est plus disponible pour la période sélectionnée.'
          : 'This equipment is no longer available for the selected dates.',
      };
    case 'CONFLICT_IDEMPOTENCY':
      return {
        code: 'CONFLICT_IDEMPOTENCY',
        message: fr
          ? 'Une requête différente a déjà été soumise avec la même clé.'
          : 'A conflicting request was already submitted with this key.',
      };
    case 'OUTSIDE_OPENING_HOURS':
    case 'LOCATION_CLOSED':
      return {
        code: 'VALIDATION',
        message: fr
          ? 'Le lieu est fermé sur ce créneau ou les horaires sont en dehors des heures d’ouverture.'
          : 'The location is closed during this time or outside opening hours.',
      };
    case 'VALIDATION':
      return {
        code: 'VALIDATION',
        message: fr
          ? 'Les paramètres de réservation sont invalides.'
          : 'The booking parameters are invalid.',
      };
    default:
      return {
        code: 'UNKNOWN',
        message: fr
          ? 'La réservation n’a pas pu être créée. Veuillez vérifier les informations et réessayer.'
          : 'The booking could not be created. Please verify your details and try again.',
      };
  }
}

/**
 * Server Action : Crée atomiquement un booking draft avec hold temporaire (G7E / Pont Checkout).
 *
 * Résout côté serveur les identifiants internes transactionnels (organizationId, locationId,
 * productId, variantId) à partir des identifiants publics autorisés (publicProductId,
 * publicLocationId, publicVariantId) en appliquant les mêmes règles d'éligibilité que la consultation.
 *
 * Aucune autorité de tarification ou de réservation n'est déléguée au navigateur.
 */
export async function createBookingDraftAction(
  input: CreateBookingDraftActionInput,
): Promise<ActionResult<CreateBookingDraftActionSuccess>> {
  const locale: 'fr' | 'en' = input?.locale === 'en' ? 'en' : 'fr';
  const fr = locale === 'fr';

  const user = await getAuthenticatedUser();
  if (!user) {
    return {
      ok: false,
      code: 'UNAUTHENTICATED',
      message: fr
        ? 'Vous devez être connecté pour effectuer une réservation.'
        : 'You must be signed in to make a booking.',
    };
  }

  // 1. Validation de l'entrée
  if (!input || typeof input !== 'object') {
    return {
      ok: false,
      code: 'VALIDATION',
      message: fr ? 'Paramètres invalides.' : 'Invalid parameters.',
    };
  }

  if (
    !input.publicProductId ||
    typeof input.publicProductId !== 'string' ||
    !UUID_RE.test(input.publicProductId.trim())
  ) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: fr ? 'Identifiant de produit invalide.' : 'Invalid product identifier.',
    };
  }

  if (
    !input.publicLocationId ||
    typeof input.publicLocationId !== 'string' ||
    !UUID_RE.test(input.publicLocationId.trim())
  ) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: fr ? 'Identifiant de lieu invalide.' : 'Invalid location identifier.',
    };
  }

  if (
    !input.publicVariantId ||
    typeof input.publicVariantId !== 'string' ||
    !UUID_RE.test(input.publicVariantId.trim())
  ) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: fr ? 'Identifiant de variante invalide.' : 'Invalid variant identifier.',
    };
  }

  if (
    !input.idempotencyKey ||
    typeof input.idempotencyKey !== 'string' ||
    !UUID_RE.test(input.idempotencyKey.trim())
  ) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: fr ? 'Clé d’idempotence invalide.' : 'Invalid idempotency key.',
    };
  }

  const quantity = input.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: fr
        ? 'La quantité doit être supérieure ou égale à 1.'
        : 'Quantity must be at least 1.',
    };
  }

  if (!input.intent || typeof input.intent !== 'object') {
    return {
      ok: false,
      code: 'VALIDATION',
      message: fr ? 'Période de réservation invalide.' : 'Invalid booking period.',
    };
  }

  let flexibleIntent: FlexibleCreateBookingDraftInput['intent'];
  if (input.intent.kind === 'DAY_RANGE') {
    if (
      !input.intent.startDate ||
      !DATE_RE.test(input.intent.startDate) ||
      !input.intent.endDateExclusive ||
      !DATE_RE.test(input.intent.endDateExclusive)
    ) {
      return {
        ok: false,
        code: 'VALIDATION',
        message: fr
          ? 'Dates de réservation invalides (format YYYY-MM-DD attendu).'
          : 'Invalid booking dates (YYYY-MM-DD format expected).',
      };
    }
    if (input.intent.endDateExclusive <= input.intent.startDate) {
      return {
        ok: false,
        code: 'VALIDATION',
        message: fr
          ? 'La date de fin doit être postérieure à la date de début.'
          : 'End date must be after start date.',
      };
    }
    flexibleIntent = {
      kind: 'DAY_RANGE',
      startDate: input.intent.startDate,
      endDateExclusive: input.intent.endDateExclusive,
    };
  } else if (input.intent.kind === 'TIME_RANGE') {
    if (
      !input.intent.startAt ||
      !DATETIME_LOCAL_RE.test(input.intent.startAt) ||
      !input.intent.endAt ||
      !DATETIME_LOCAL_RE.test(input.intent.endAt)
    ) {
      return {
        ok: false,
        code: 'VALIDATION',
        message: fr
          ? 'Horaires de réservation invalides (format YYYY-MM-DDTHH:mm attendu).'
          : 'Invalid booking times (YYYY-MM-DDTHH:mm format expected).',
      };
    }
    const cleanStartAt =
      input.intent.startAt.length === 16 ? `${input.intent.startAt}:00` : input.intent.startAt;
    const cleanEndAt =
      input.intent.endAt.length === 16 ? `${input.intent.endAt}:00` : input.intent.endAt;
    if (cleanEndAt <= cleanStartAt) {
      return {
        ok: false,
        code: 'VALIDATION',
        message: fr
          ? 'L’heure de fin doit être postérieure à l’heure de début.'
          : 'End time must be after start time.',
      };
    }
    flexibleIntent = {
      kind: 'TIME_RANGE',
      startAt: cleanStartAt,
      endAt: cleanEndAt,
    };
  } else {
    return {
      ok: false,
      code: 'VALIDATION',
      message: fr ? 'Type de période invalide.' : 'Invalid period type.',
    };
  }

  const db = getDb();
  const cleanPublicProductId = input.publicProductId.trim();
  const cleanPublicLocationId = input.publicLocationId.trim();
  const cleanPublicVariantId = input.publicVariantId.trim();
  const cleanIdempotencyKey = input.idempotencyKey.trim();

  // 2. Résolution d'autorité côté serveur (mêmes règles d'éligibilité que la fiche publique)
  const authorityRes = await resolvePublicBookingAuthority(
    db,
    {
      publicProductId: cleanPublicProductId,
      publicLocationId: cleanPublicLocationId,
      publicVariantId: cleanPublicVariantId,
    },
    { publicationGate: new PostgresPhotoPublicationGate() },
  );

  if (authorityRes.kind !== 'SUCCESS') {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: fr
        ? 'Offre ou option d’équipement introuvable ou non disponible.'
        : 'Offer or equipment option not found or unavailable.',
    };
  }

  const { authority } = authorityRes;

  // 3. Appel de la primitive Core createBookingDraftWithHold
  const draftInput: FlexibleCreateBookingDraftInput = {
    pricingMode: 'FLEXIBLE',
    organizationId: authority.organizationId,
    locationId: authority.locationId,
    customerUserId: user.id,
    locale,
    intent: flexibleIntent,
    lines: [{ variantId: authority.variantId, quantity }],
    idempotencyKey: cleanIdempotencyKey,
  };

  try {
    const result = await createBookingDraftWithHold(db, draftInput);

    if (result.kind === 'SUCCESS') {
      return {
        ok: true,
        data: {
          draftId: result.resourceId,
          redirectUrl: `/checkout/${result.resourceId}`,
        },
      };
    }

    const { code, message } = await mapBookingDraftError(result.body?.error, locale);
    return { ok: false, code, message };
  } catch {
    return {
      ok: false,
      code: 'UNKNOWN',
      message: fr
        ? 'Une erreur interne est survenue lors de la création de la réservation.'
        : 'An internal error occurred while creating the booking.',
    };
  }
}
