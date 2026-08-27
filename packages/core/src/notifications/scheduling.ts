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
  buildBookingConfirmedCustomerKey,
  buildBookingConfirmedMerchantKey,
  buildPickupReminderCustomerKey,
  buildRefundActionRequiredMerchantKey,
  buildRefundConfirmedCustomerKey,
  buildReturnReminderCustomerKey,
} from './idempotency-keys';

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

  // 2. Trouver l'email du responsable de l'organisation (owner / admin)
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

  // Return reminder : 2h avant la fin
  const returnReminderTime = new Date(
    Math.max(now.getTime(), booking.customerEndAt.getTime() - 2 * 60 * 60 * 1000),
  );

  // 4. Insérer les notifications (idempotent grâce à idempotency_key UNIQUE)
  const toInsert = [
    {
      organizationId: booking.organizationId,
      bookingId: booking.bookingId,
      channel: 'EMAIL' as const,
      template: 'BOOKING_CONFIRMED_CUSTOMER' as const,
      recipient: booking.customerEmail,
      status: 'PENDING' as const,
      scheduledFor: now,
      idempotencyKey: buildBookingConfirmedCustomerKey(booking.bookingId),
    },
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
      idempotencyKey: buildPickupReminderCustomerKey(booking.bookingId),
    },
    {
      organizationId: booking.organizationId,
      bookingId: booking.bookingId,
      channel: 'EMAIL' as const,
      template: 'RETURN_REMINDER_CUSTOMER' as const,
      recipient: booking.customerEmail,
      status: 'PENDING' as const,
      scheduledFor: returnReminderTime,
      idempotencyKey: buildReturnReminderCustomerKey(booking.bookingId),
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
        eq(notifications.status, 'PENDING'),
        inArray(notifications.template, ['PICKUP_REMINDER_CUSTOMER', 'RETURN_REMINDER_CUSTOMER']),
      ),
    );

  // 2. Charger les données de la réservation et de l'annulation
  const rows = await db
    .select({
      bookingId: bookings.id,
      organizationId: bookings.organizationId,
      customerEmail: users.email,
      refundId: bookingCancellations.refundId,
    })
    .from(bookings)
    .innerJoin(users, eq(bookings.customerUserId, users.id))
    .innerJoin(bookingCancellations, eq(bookingCancellations.id, cancellationId))
    .where(eq(bookings.id, bookingId));

  if (rows.length === 0) return;
  const booking = rows[0]!;

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
      refundId: booking.refundId,
      channel: 'EMAIL' as const,
      template: 'BOOKING_CANCELLED_CUSTOMER' as const,
      recipient: booking.customerEmail,
      status: 'PENDING' as const,
      scheduledFor: now,
      idempotencyKey: buildBookingCancelledCustomerKey(booking.bookingId),
    },
    ...(merchantEmail
      ? [
          {
            organizationId: booking.organizationId,
            bookingId: booking.bookingId,
            refundId: booking.refundId,
            channel: 'EMAIL' as const,
            template: 'BOOKING_CANCELLED_MERCHANT' as const,
            recipient: merchantEmail,
            status: 'PENDING' as const,
            scheduledFor: now,
            idempotencyKey: buildBookingCancelledMerchantKey(booking.bookingId),
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
    .leftJoin(payments, eq(refunds.paymentId, payments.id))
    .leftJoin(bookings, eq(payments.id, bookings.paymentId))
    .leftJoin(users, eq(payments.customerUserId, users.id))
    .where(eq(refunds.id, refundId));

  if (rows.length === 0) return;
  const refund = rows[0]!;

  if (!refund.customerEmail) return;

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
    .leftJoin(payments, eq(refunds.paymentId, payments.id))
    .leftJoin(bookings, eq(payments.id, bookings.paymentId))
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
