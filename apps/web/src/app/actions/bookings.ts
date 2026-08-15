'use server';

import type { ActionResult } from '@uttily/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import { locations, products, productVariants } from '@uttily/database';
import { createBookingDraftWithHold, type FlexibleCreateBookingDraftInput } from '@uttily/core';
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
  variantId: string;
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
 * Server Action : Crée atomiquement un booking draft avec hold temporaire (G7E / Pont Checkout).
 *
 * Résout côté serveur les identifiants internes (organizationId, locationId, productId)
 * à partir des identifiants publics autorisés (publicProductId, publicLocationId).
 * Aucune autorité de réservation n'est déléguée au navigateur.
 */
export async function createBookingDraftAction(
  input: CreateBookingDraftActionInput,
): Promise<ActionResult<CreateBookingDraftActionSuccess>> {
  const user = await getAuthenticatedUser();
  if (!user) {
    return {
      ok: false,
      code: 'UNAUTHENTICATED',
      message: 'Vous devez être connecté pour effectuer une réservation.',
    };
  }

  // 1. Validation de l'entrée
  if (!input || typeof input !== 'object') {
    return { ok: false, code: 'VALIDATION', message: 'Paramètres invalides.' };
  }

  if (
    !input.publicProductId ||
    typeof input.publicProductId !== 'string' ||
    !UUID_RE.test(input.publicProductId.trim())
  ) {
    return { ok: false, code: 'VALIDATION', message: 'Identifiant de produit invalide.' };
  }

  if (
    !input.publicLocationId ||
    typeof input.publicLocationId !== 'string' ||
    !UUID_RE.test(input.publicLocationId.trim())
  ) {
    return { ok: false, code: 'VALIDATION', message: 'Identifiant de lieu invalide.' };
  }

  if (
    !input.variantId ||
    typeof input.variantId !== 'string' ||
    !UUID_RE.test(input.variantId.trim())
  ) {
    return { ok: false, code: 'VALIDATION', message: 'Identifiant de variante invalide.' };
  }

  if (
    !input.idempotencyKey ||
    typeof input.idempotencyKey !== 'string' ||
    !UUID_RE.test(input.idempotencyKey.trim())
  ) {
    return { ok: false, code: 'VALIDATION', message: 'Clé d’idempotence invalide.' };
  }

  const quantity = input.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'La quantité doit être supérieure ou égale à 1.',
    };
  }

  if (!input.intent || typeof input.intent !== 'object') {
    return { ok: false, code: 'VALIDATION', message: 'Période de réservation invalide.' };
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
        message: 'Dates de réservation invalides (format YYYY-MM-DD attendu).',
      };
    }
    if (input.intent.endDateExclusive <= input.intent.startDate) {
      return {
        ok: false,
        code: 'VALIDATION',
        message: 'La date de fin doit être postérieure à la date de début.',
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
        message: 'Horaires de réservation invalides (format YYYY-MM-DDTHH:mm attendu).',
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
        message: 'L’heure de fin doit être postérieure à l’heure de début.',
      };
    }
    flexibleIntent = {
      kind: 'TIME_RANGE',
      startAt: cleanStartAt,
      endAt: cleanEndAt,
    };
  } else {
    return { ok: false, code: 'VALIDATION', message: 'Type de période invalide.' };
  }

  const db = getDb();
  const cleanPublicProductId = input.publicProductId.trim();
  const cleanPublicLocationId = input.publicLocationId.trim();
  const cleanVariantId = input.variantId.trim();
  const cleanIdempotencyKey = input.idempotencyKey.trim();
  const locale = input.locale === 'en' ? 'en' : 'fr';

  // 2. Résolution d'autorité côté serveur (produit, organisation, lieu, variante)
  const rows = await db
    .select({
      productId: products.id,
      productOrgId: products.organizationId,
      productPublicationStatus: products.publicationStatus,
      productDeletedAt: products.deletedAt,
      locationId: locations.id,
      locationOrgId: locations.organizationId,
      locationDeletedAt: locations.deletedAt,
      isPubliclyListed: locations.isPubliclyListed,
      pickupEnabled: locations.pickupEnabled,
    })
    .from(products)
    .innerJoin(locations, eq(locations.publicId, cleanPublicLocationId))
    .where(eq(products.publicId, cleanPublicProductId))
    .limit(1);

  if (rows.length === 0) {
    return { ok: false, code: 'NOT_FOUND', message: 'Offre introuvable ou non disponible.' };
  }

  const r = rows[0]!;
  if (r.productOrgId !== r.locationOrgId) {
    return { ok: false, code: 'NOT_FOUND', message: 'Offre introuvable ou non disponible.' };
  }

  if (
    r.productPublicationStatus !== 'PUBLISHED' ||
    r.productDeletedAt !== null ||
    r.locationDeletedAt !== null ||
    !r.isPubliclyListed ||
    !r.pickupEnabled
  ) {
    return { ok: false, code: 'NOT_FOUND', message: 'Offre introuvable ou non disponible.' };
  }

  // Vérifier la variante
  const variantRows = await db
    .select({
      id: productVariants.id,
      isActive: productVariants.isActive,
      deletedAt: productVariants.deletedAt,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.id, cleanVariantId),
        eq(productVariants.productId, r.productId),
        isNull(productVariants.deletedAt),
      ),
    )
    .limit(1);

  if (variantRows.length === 0 || !variantRows[0]!.isActive) {
    return { ok: false, code: 'NOT_FOUND', message: 'Variante introuvable ou non disponible.' };
  }

  // 3. Appel de la primitive Core createBookingDraftWithHold
  const draftInput: FlexibleCreateBookingDraftInput = {
    pricingMode: 'FLEXIBLE',
    organizationId: r.productOrgId,
    locationId: r.locationId,
    customerUserId: user.id,
    locale,
    intent: flexibleIntent,
    lines: [{ variantId: cleanVariantId, quantity }],
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

    // Mapping d'erreur fermé et typé
    switch (result.body.error) {
      case 'CONFLICT_BLOCK':
        return {
          ok: false,
          code: 'CONFLICT_BLOCK',
          message: 'Cet équipement n’est plus disponible pour la période sélectionnée.',
        };
      case 'CONFLICT_IDEMPOTENCY':
        return {
          ok: false,
          code: 'CONFLICT_IDEMPOTENCY',
          message: 'Une requête différente a déjà été soumise avec la même clé.',
        };
      case 'VALIDATION':
        return {
          ok: false,
          code: 'VALIDATION',
          message:
            result.body.message ||
            'Les paramètres de réservation sont invalides ou le lieu est fermé.',
        };
      default:
        return {
          ok: false,
          code: 'UNKNOWN',
          message: 'La réservation n’a pas pu être créée. Veuillez réessayer.',
        };
    }
  } catch {
    return {
      ok: false,
      code: 'UNKNOWN',
      message: 'Une erreur interne est survenue lors de la création de la réservation.',
    };
  }
}
