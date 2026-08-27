'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { bookings } from '@uttily/database';
import {
  cancelConfirmedBooking,
  previewBookingCancellation,
  type CancellationPreviewResult,
  type CancelConfirmedBookingResult,
} from '@uttily/core';

export type CustomerActionResult<T> =
  { ok: true; data: T } | { ok: false; error: string; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Calcule l'aperçu financier de l'annulation d'une réservation pour le locataire connecté.
 * Sécurité : fail-closed avec retour NOT_FOUND (404) si la réservation n'appartient pas au locataire.
 */
export async function previewMyBookingCancellationAction(
  bookingId: string,
): Promise<CustomerActionResult<CancellationPreviewResult>> {
  const user = await getAuthenticatedUser();
  if (!user) {
    return {
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Vous devez être connecté pour accéder à cette réservation.',
    };
  }

  if (!bookingId || !UUID_RE.test(bookingId.trim())) {
    return {
      ok: false,
      error: 'NOT_FOUND',
      message: 'Réservation introuvable.',
    };
  }

  const cleanBookingId = bookingId.trim();
  const db = getDb();

  // 1. Contrôle d'appartenance strict
  const bookingRows = await db
    .select({
      id: bookings.id,
      organizationId: bookings.organizationId,
      customerUserId: bookings.customerUserId,
      status: bookings.status,
    })
    .from(bookings)
    .where(and(eq(bookings.id, cleanBookingId), eq(bookings.customerUserId, user.id)))
    .limit(1);

  if (bookingRows.length === 0) {
    return {
      ok: false,
      error: 'NOT_FOUND',
      message: 'Réservation introuvable.',
    };
  }

  const booking = bookingRows[0]!;

  try {
    const preview = await previewBookingCancellation(db, booking.organizationId, booking.id, {
      actorReason: 'CUSTOMER_CANCELLATION',
    });

    return { ok: true, data: preview };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Impossible de calculer l’aperçu d’annulation.';
    return { ok: false, error: 'PREVIEW_ERROR', message };
  }
}

/**
 * Exécute l'annulation définitive d'une réservation par le locataire connecté.
 * Sécurité : fail-closed avec contrôle d'empreinte financière (previewFingerprint) et idempotence stricte.
 */
export async function cancelMyBookingAction(input: {
  bookingId: string;
  idempotencyKey: string;
  previewFingerprint: string;
}): Promise<CustomerActionResult<CancelConfirmedBookingResult>> {
  const user = await getAuthenticatedUser();
  if (!user) {
    return {
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Vous devez être connecté pour annuler une réservation.',
    };
  }

  if (!input.bookingId || !UUID_RE.test(input.bookingId.trim())) {
    return {
      ok: false,
      error: 'NOT_FOUND',
      message: 'Réservation introuvable.',
    };
  }

  const cleanBookingId = input.bookingId.trim();
  const db = getDb();

  // 1. Contrôle d'appartenance strict
  const bookingRows = await db
    .select({
      id: bookings.id,
      organizationId: bookings.organizationId,
      customerUserId: bookings.customerUserId,
      status: bookings.status,
    })
    .from(bookings)
    .where(and(eq(bookings.id, cleanBookingId), eq(bookings.customerUserId, user.id)))
    .limit(1);

  if (bookingRows.length === 0) {
    return {
      ok: false,
      error: 'NOT_FOUND',
      message: 'Réservation introuvable.',
    };
  }

  const booking = bookingRows[0]!;

  try {
    const result = await cancelConfirmedBooking(db, {
      bookingId: booking.id,
      organizationId: booking.organizationId,
      actorUserId: user.id,
      actorReason: 'CUSTOMER_CANCELLATION',
      idempotencyKey: input.idempotencyKey,
      previewFingerprint: input.previewFingerprint,
    });

    // Revalidation des caches Next.js locataire
    revalidatePath('/[locale]/account/bookings', 'page');
    revalidatePath(`/[locale]/account/bookings/${booking.id}`, 'page');

    return { ok: true, data: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Impossible d’annuler la réservation.';
    return { ok: false, error: 'CANCELLATION_ERROR', message };
  }
}
