'use server';

import { revalidatePath } from 'next/cache';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  getMembership,
  requireMembership,
  ROLE_MANAGERS,
  previewBookingCancellation,
  cancelConfirmedBooking,
  type CancellationActorReason,
  type CancellationPreviewResult,
  type CancelConfirmedBookingResult,
} from '@uttily/core';

export async function previewBookingCancellationAction(
  organizationId: string,
  bookingId: string,
  actorReason?: CancellationActorReason,
): Promise<CancellationPreviewResult> {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');

  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireMembership(membership, ROLE_MANAGERS);

  return previewBookingCancellation(db, organizationId, bookingId, { actorReason });
}

export async function cancelConfirmedBookingAction(
  organizationId: string,
  bookingId: string,
  actorReason: CancellationActorReason,
  idempotencyKey: string,
): Promise<CancelConfirmedBookingResult> {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');

  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireMembership(membership, ROLE_MANAGERS);

  const result = await cancelConfirmedBooking(db, {
    organizationId,
    bookingId,
    actorUserId: user.id,
    actorReason,
    idempotencyKey,
  });

  revalidatePath(`/dashboard/${organizationId}/bookings/${bookingId}`);
  revalidatePath(`/dashboard/${organizationId}/bookings`);
  revalidatePath(`/dashboard/${organizationId}/finances`);
  revalidatePath(`/dashboard/${organizationId}/planning`);
  revalidatePath(`/dashboard/${organizationId}`);

  return result;
}
