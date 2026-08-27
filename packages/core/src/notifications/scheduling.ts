import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbExecutor } from '@uttily/database';
import {
  bookingCancellations,
  bookings,
  locations,
  notifications,
  organizationMemberships,
  organizations,
  payments,
  refunds,
  users,
} from '@uttily/database';
import {
  buildBookingCancelledCustomerKey,
  buildBookingCancelledMerchantKey,
  buildBookingConfirmedMerchantKey,
  buildPickupReminderCustomerKey,
  buildRefundActionRequiredMerchantKey,
  buildRefundConfirmedCustomerKey,
  buildReturnReminderCustomerKey,
} from './idempotency-keys';

/**
 * Planifie les notifications lors de la confirmation d'une réservation :
 * - Confirmation loueur (EMAIL)
 * - Rappel de retrait locataire (EMAIL, planifié à T-24h, révision r0)
 * - Rappel de retour locataire (EMAIL, planifié à T-2h, révision r0)
 *
 * NOTE (Chantier 13.2) : La confirmation locataire avec pièces jointes PDF contractuelles
 * est la responsabilité exclusive de l'ancien pipeline documentaire (`executeTransactionalEmailPipeline`).
 * Un type d'email = un seul pipeline propriétaire.
 */
export async function scheduleBookingConfirmedNotifications(
  db: DbExecutor,
  bookingId: string,
  options?: { now?: Date },
): Promise<void> {
  const now = options?.now ?? new Date();

  // 1. Charger la réservation et les parties prenantes
  const rows = await db
    .select({
      bookingId: bookings.id,
      organizationId: bookings.organizationId,
      customerUserId: bookings.customerUserId,
      customerStartAt: bookings.customerStartAt,
      customerEndAt: bookings.customerEndAt,
      customerEmail: users.email,
      organizationName: organizations.legalName,
      locationName: locations.name,
    })
    .from(bookings)
    .innerJoin(organizations, eq(bookings.organizationId, organizations.id))
    .innerJoin(locations, eq(bookings.locationId, locations.id))
    .innerJoin(users, eq(bookings.customerUserId, users.id))
    .where(eq(bookings.id, bookingId));

  if (rows.length === 0) return;
  const booking = rows[0]!;

  // 2. Trouver l'email du responsable de l'organisation (owner / admin / manager)
  const merchantMembers = await db
    .select({ email: users.email })
    .from(organizationMemberships)
    .innerJoin(users, eq(organizationMemberships.userId, users.id))
    .where(
      and(
        eq(organizationMemberships.organizationId, booking.organizationId),
        inArray(organizationMemberships.role, ['OWNER', 'ADMIN', 'MANAGER']),
      ),
    )
    .limit(1);

  const merchantEmail = merchantMembers[0]?.email;

  // 3. Calculer les horaires de rappel
  // Pickup reminder : 24h avant départ (ou immédiatement si départ dans moins de 24h)
  const pickupReminderTime = new Date(
    Math.max(now.getTime(), booking.customerStartAt.getTime() - 24 * 60 * 60 * 1000),
  );

  // Return reminder : 2h avant la fin (ou immédiatement si fin dans moins de 2h)
  const returnReminderTime = new Date(
    Math.max(now.getTime(), booking.customerEndAt.getTime() - 2 * 60 * 60 * 1000),
  );

  // 4. Insérer les notifications (idempotent grâce à idempotency_key UNIQUE)
  const toInsert = [
    ...(merchantEmail
      ? [
          {
            organizationId: booking.organizationId,
            bookingId: booking.bookingId,
            channel: 'EMAIL' as const,
            template: 'BOOKING_CONFIRMED_MERCHANT' as const,
            recipient: merchantEmail,
            status: 'PENDING' as const,
            scheduledFor: now,
            idempotencyKey: buildBookingConfirmedMerchantKey(booking.bookingId),
          },
        ]
      : []),
    {
      organizationId: booking.organizationId,
      bookingId: booking.bookingId,
      channel: 'EMAIL' as const,
      template: 'PICKUP_REMINDER_CUSTOMER' as const,
      recipient: booking.customerEmail,
      status: 'PENDING' as const,
      scheduledFor: pickupReminderTime,
      idempotencyKey: buildPickupReminderCustomerKey(booking.bookingId, 0),
    },
    {
      organizationId: booking.organizationId,
      bookingId: booking.bookingId,
      channel: 'EMAIL' as const,
      template: 'RETURN_REMINDER_CUSTOMER' as const,
      recipient: booking.customerEmail,
      status: 'PENDING' as const,
      scheduledFor: returnReminderTime,
      idempotencyKey: buildReturnReminderCustomerKey(booking.bookingId, 0),
    },
  ];

  await db.insert(notifications).values(toInsert).onConflictDoNothing();
}

export async function scheduleBookingCancelledNotifications(
  db: DbExecutor,
  bookingId: string,
  cancellationId: string,
  options?: { now?: Date },
): Promise<void> {
  const now = options?.now ?? new Date();

  // 1. Annuler immédiatement tous les rappels programmés encore PENDING pour cette réservation
  await db
    .update(notifications)
    .set({
      status: 'CANCELLED',
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(notifications.bookingId, bookingId),
        inArray(notifications.template, ['PICKUP_REMINDER_CUSTOMER', 'RETURN_REMINDER_CUSTOMER']),
        eq(notifications.status, 'PENDING'),
      ),
    );

  // 2. Charger les données de réservation et d'annulation
  const rows = await db
    .select({
      bookingId: bookings.id,
      organizationId: bookings.organizationId,
      customerEmail: users.email,
      cancellationId: bookingCancellations.id,
    })
    .from(bookings)
    .innerJoin(bookingCancellations, eq(bookingCancellations.bookingId, bookings.id))
    .innerJoin(users, eq(bookings.customerUserId, users.id))
    .where(and(eq(bookings.id, bookingId), eq(bookingCancellations.id, cancellationId)));

  if (rows.length === 0) return;
  const booking = rows[0]!;

  // 3. Email responsable loueur
  const merchantMembers = await db
    .select({ email: users.email })
    .from(organizationMemberships)
    .innerJoin(users, eq(organizationMemberships.userId, users.id))
    .where(
      and(
        eq(organizationMemberships.organizationId, booking.organizationId),
        inArray(organizationMemberships.role, ['OWNER', 'ADMIN', 'MANAGER']),
      ),
    )
    .limit(1);

  const merchantEmail = merchantMembers[0]?.email;

  const toInsert = [
    {
      organizationId: booking.organizationId,
      bookingId: booking.bookingId,
      cancellationId: booking.cancellationId,
      channel: 'EMAIL' as const,
      template: 'BOOKING_CANCELLED_CUSTOMER' as const,
      recipient: booking.customerEmail,
      status: 'PENDING' as const,
      scheduledFor: now,
      idempotencyKey: buildBookingCancelledCustomerKey(booking.cancellationId),
    },
    ...(merchantEmail
      ? [
          {
            organizationId: booking.organizationId,
            bookingId: booking.bookingId,
            cancellationId: booking.cancellationId,
            channel: 'EMAIL' as const,
            template: 'BOOKING_CANCELLED_MERCHANT' as const,
            recipient: merchantEmail,
            status: 'PENDING' as const,
            scheduledFor: now,
            idempotencyKey: buildBookingCancelledMerchantKey(booking.cancellationId),
          },
        ]
      : []),
  ];

  await db.insert(notifications).values(toInsert).onConflictDoNothing();
}

export async function scheduleRefundConfirmedNotification(
  db: DbExecutor,
  refundId: string,
  options?: { now?: Date },
): Promise<void> {
  const now = options?.now ?? new Date();

  const rows = await db
    .select({
      refundId: refunds.id,
      organizationId: refunds.organizationId,
      bookingId: bookings.id,
      customerEmail: users.email,
    })
    .from(refunds)
    .innerJoin(payments, eq(refunds.paymentId, payments.id))
    .innerJoin(bookings, eq(bookings.paymentId, payments.id))
    .innerJoin(users, eq(bookings.customerUserId, users.id))
    .where(eq(refunds.id, refundId));

  if (rows.length === 0) return;
  const refund = rows[0]!;

  await db
    .insert(notifications)
    .values({
      organizationId: refund.organizationId,
      bookingId: refund.bookingId,
      refundId: refund.refundId,
      channel: 'EMAIL',
      template: 'REFUND_CONFIRMED_CUSTOMER',
      recipient: refund.customerEmail,
      status: 'PENDING',
      scheduledFor: now,
      idempotencyKey: buildRefundConfirmedCustomerKey(refund.refundId),
    })
    .onConflictDoNothing();
}

export async function scheduleRefundActionRequiredNotification(
  db: DbExecutor,
  refundId: string,
  failureCode?: string,
  options?: { now?: Date },
): Promise<void> {
  const now = options?.now ?? new Date();

  const rows = await db
    .select({
      refundId: refunds.id,
      organizationId: refunds.organizationId,
      bookingId: bookings.id,
    })
    .from(refunds)
    .innerJoin(payments, eq(refunds.paymentId, payments.id))
    .innerJoin(bookings, eq(bookings.paymentId, payments.id))
    .where(eq(refunds.id, refundId));

  if (rows.length === 0) return;
  const refund = rows[0]!;

  const merchantMembers = await db
    .select({ email: users.email })
    .from(organizationMemberships)
    .innerJoin(users, eq(organizationMemberships.userId, users.id))
    .where(
      and(
        eq(organizationMemberships.organizationId, refund.organizationId),
        inArray(organizationMemberships.role, ['OWNER', 'ADMIN', 'MANAGER']),
      ),
    )
    .limit(1);

  const merchantEmail = merchantMembers[0]?.email;
  if (!merchantEmail) return;

  await db
    .insert(notifications)
    .values({
      organizationId: refund.organizationId,
      bookingId: refund.bookingId,
      refundId: refund.refundId,
      channel: 'EMAIL',
      template: 'REFUND_ACTION_REQUIRED_MERCHANT',
      recipient: merchantEmail,
      status: 'PENDING',
      scheduledFor: now,
      failureCode: failureCode ?? null,
      idempotencyKey: buildRefundActionRequiredMerchantKey(refund.refundId),
    })
    .onConflictDoNothing();
}

/**
 * Recalcule et planifie les nouveaux rappels de réservation lors d'un amendement de dates (Chantier 13.2) :
 * - Les anciens rappels PENDING sont marqués CANCELLED.
 * - Les anciens rappels SENT restent intacts (historique véridique).
 * - De nouveaux rappels sont insérés avec la révision incrémentée (`rN:v1`) et les nouvelles dates.
 */
export async function rescheduleBookingReminders(
  db: DbExecutor,
  bookingId: string,
  newStartAt?: Date,
  newEndAt?: Date,
  options?: { now?: Date },
): Promise<void> {
  const now = options?.now ?? new Date();

  // 1. Charger la réservation
  const bookingRows = await db
    .select({
      bookingId: bookings.id,
      organizationId: bookings.organizationId,
      customerUserId: bookings.customerUserId,
      customerStartAt: bookings.customerStartAt,
      customerEndAt: bookings.customerEndAt,
      customerEmail: users.email,
    })
    .from(bookings)
    .innerJoin(users, eq(bookings.customerUserId, users.id))
    .where(eq(bookings.id, bookingId));

  if (bookingRows.length === 0) return;
  const booking = bookingRows[0]!;

  // 2. Trouver tous les rappels existants pour calculer la révision suivante
  const existingReminders = await db
    .select({
      id: notifications.id,
      status: notifications.status,
      idempotencyKey: notifications.idempotencyKey,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.bookingId, bookingId),
        inArray(notifications.template, ['PICKUP_REMINDER_CUSTOMER', 'RETURN_REMINDER_CUSTOMER']),
      ),
    );

  let maxRevision = 0;
  for (const r of existingReminders) {
    const match = r.idempotencyKey.match(/:r(\d+):v1$/);
    if (match && match[1]) {
      const rev = parseInt(match[1], 10);
      if (rev > maxRevision) maxRevision = rev;
    }
  }
  const nextRevision = maxRevision + 1;

  // 3. Annuler les rappels PENDING existants
  const pendingIds = existingReminders.filter((r) => r.status === 'PENDING').map((r) => r.id);
  if (pendingIds.length > 0) {
    await db
      .update(notifications)
      .set({
        status: 'CANCELLED',
        updatedAt: sql`now()`,
      })
      .where(inArray(notifications.id, pendingIds));
  }

  // 4. Calculer les nouveaux horaires de rappel et insérer la nouvelle révision
  const effectiveStart = newStartAt ?? booking.customerStartAt;
  const effectiveEnd = newEndAt ?? booking.customerEndAt;

  const newPickupTime = new Date(
    Math.max(now.getTime(), effectiveStart.getTime() - 24 * 60 * 60 * 1000),
  );
  const newReturnTime = new Date(
    Math.max(now.getTime(), effectiveEnd.getTime() - 2 * 60 * 60 * 1000),
  );

  const toInsert = [
    {
      organizationId: booking.organizationId,
      bookingId: booking.bookingId,
      channel: 'EMAIL' as const,
      template: 'PICKUP_REMINDER_CUSTOMER' as const,
      recipient: booking.customerEmail,
      status: 'PENDING' as const,
      scheduledFor: newPickupTime,
      idempotencyKey: buildPickupReminderCustomerKey(booking.bookingId, nextRevision),
    },
    {
      organizationId: booking.organizationId,
      bookingId: booking.bookingId,
      channel: 'EMAIL' as const,
      template: 'RETURN_REMINDER_CUSTOMER' as const,
      recipient: booking.customerEmail,
      status: 'PENDING' as const,
      scheduledFor: newReturnTime,
      idempotencyKey: buildReturnReminderCustomerKey(booking.bookingId, nextRevision),
    },
  ];

  await db.insert(notifications).values(toInsert).onConflictDoNothing();
}
