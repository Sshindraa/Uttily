import { eq } from 'drizzle-orm';
import type { DbExecutor, NotificationRecord } from '@uttily/database';
import {
  bookingCancellations,
  bookingLines,
  bookings,
  locations,
  organizations,
  payments,
  products,
  productVariants,
  refunds,
  users,
} from '@uttily/database';
import type { RenderedEmail } from './types';
import {
  renderBookingCancelledCustomer,
  renderBookingCancelledMerchant,
  renderBookingConfirmedCustomer,
  renderBookingConfirmedMerchant,
  renderPickupReminderCustomer,
  renderRefundActionRequiredMerchant,
  renderRefundConfirmedCustomer,
  renderReturnReminderCustomer,
} from './templates';

export async function renderNotificationRecord(
  db: DbExecutor,
  notification: NotificationRecord,
): Promise<RenderedEmail> {
  switch (notification.template) {
    case 'BOOKING_CONFIRMED_CUSTOMER': {
      if (!notification.bookingId)
        throw new Error('bookingId manquant pour BOOKING_CONFIRMED_CUSTOMER');
      const rows = await db
        .select({
          bookingId: bookings.id,
          customerStartAt: bookings.customerStartAt,
          customerEndAt: bookings.customerEndAt,
          totalAmountMinor: bookings.totalAmountMinor,
          organizationName: organizations.legalName,
          locationName: locations.name,
          locationAddress: locations.slug,
          timeZone: locations.timeZone,
          productName: products.name,
        })
        .from(bookings)
        .innerJoin(organizations, eq(bookings.organizationId, organizations.id))
        .innerJoin(locations, eq(bookings.locationId, locations.id))
        .leftJoin(bookingLines, eq(bookings.id, bookingLines.bookingId))
        .leftJoin(productVariants, eq(bookingLines.variantId, productVariants.id))
        .leftJoin(products, eq(productVariants.productId, products.id))
        .where(eq(bookings.id, notification.bookingId))
        .limit(1);

      if (rows.length === 0) throw new Error(`Réservation ${notification.bookingId} introuvable`);
      const row = rows[0]!;

      return renderBookingConfirmedCustomer({
        bookingId: row.bookingId,
        organizationName: row.organizationName,
        productName: row.productName ?? 'Équipement Uttily',
        customerStartAt: row.customerStartAt,
        customerEndAt: row.customerEndAt,
        locationName: row.locationName,
        timeZone: row.timeZone,
        totalAmountMinor: row.totalAmountMinor,
      });
    }

    case 'BOOKING_CONFIRMED_MERCHANT': {
      if (!notification.bookingId)
        throw new Error('bookingId manquant pour BOOKING_CONFIRMED_MERCHANT');
      const rows = await db
        .select({
          bookingId: bookings.id,
          customerStartAt: bookings.customerStartAt,
          customerEndAt: bookings.customerEndAt,
          totalAmountMinor: bookings.totalAmountMinor,
          commissionAmountMinor: bookings.commissionAmountMinor,
          customerEmail: users.email,
          organizationName: organizations.legalName,
          locationName: locations.name,
          timeZone: locations.timeZone,
          productName: products.name,
        })
        .from(bookings)
        .innerJoin(organizations, eq(bookings.organizationId, organizations.id))
        .innerJoin(locations, eq(bookings.locationId, locations.id))
        .innerJoin(users, eq(bookings.customerUserId, users.id))
        .leftJoin(bookingLines, eq(bookings.id, bookingLines.bookingId))
        .leftJoin(productVariants, eq(bookingLines.variantId, productVariants.id))
        .leftJoin(products, eq(productVariants.productId, products.id))
        .where(eq(bookings.id, notification.bookingId))
        .limit(1);

      if (rows.length === 0) throw new Error(`Réservation ${notification.bookingId} introuvable`);
      const row = rows[0]!;
      const commission = row.commissionAmountMinor ?? 0;
      const netRevenueMinor = row.totalAmountMinor - commission;

      return renderBookingConfirmedMerchant({
        bookingId: row.bookingId,
        organizationName: row.organizationName,
        customerEmail: row.customerEmail,
        productName: row.productName ?? 'Équipement Uttily',
        customerStartAt: row.customerStartAt,
        customerEndAt: row.customerEndAt,
        locationName: row.locationName,
        timeZone: row.timeZone,
        netRevenueMinor,
      });
    }

    case 'BOOKING_CANCELLED_CUSTOMER': {
      if (!notification.bookingId)
        throw new Error('bookingId manquant pour BOOKING_CANCELLED_CUSTOMER');
      const rows = await db
        .select({
          bookingId: bookings.id,
          organizationName: organizations.legalName,
          productName: products.name,
          refundAmountMinor: bookingCancellations.refundAmountMinor,
          retainedAmountMinor: bookingCancellations.retainedAmountMinor,
        })
        .from(bookings)
        .innerJoin(organizations, eq(bookings.organizationId, organizations.id))
        .leftJoin(bookingCancellations, eq(bookings.id, bookingCancellations.bookingId))
        .leftJoin(bookingLines, eq(bookings.id, bookingLines.bookingId))
        .leftJoin(productVariants, eq(bookingLines.variantId, productVariants.id))
        .leftJoin(products, eq(productVariants.productId, products.id))
        .where(eq(bookings.id, notification.bookingId))
        .limit(1);

      if (rows.length === 0) throw new Error(`Réservation ${notification.bookingId} introuvable`);
      const row = rows[0]!;

      return renderBookingCancelledCustomer({
        bookingId: row.bookingId,
        organizationName: row.organizationName,
        productName: row.productName ?? 'Équipement Uttily',
        refundAmountMinor: row.refundAmountMinor ?? 0,
        retainedAmountMinor: row.retainedAmountMinor ?? 0,
      });
    }

    case 'BOOKING_CANCELLED_MERCHANT': {
      if (!notification.bookingId)
        throw new Error('bookingId manquant pour BOOKING_CANCELLED_MERCHANT');
      const rows = await db
        .select({
          bookingId: bookings.id,
          organizationName: organizations.legalName,
          customerEmail: users.email,
          productName: products.name,
          actorReason: bookingCancellations.actorReason,
          retainedAmountMinor: bookingCancellations.retainedAmountMinor,
          finalMerchantRevenueMinor: bookingCancellations.finalMerchantRevenueMinor,
        })
        .from(bookings)
        .innerJoin(organizations, eq(bookings.organizationId, organizations.id))
        .innerJoin(users, eq(bookings.customerUserId, users.id))
        .leftJoin(bookingCancellations, eq(bookings.id, bookingCancellations.bookingId))
        .leftJoin(bookingLines, eq(bookings.id, bookingLines.bookingId))
        .leftJoin(productVariants, eq(bookingLines.variantId, productVariants.id))
        .leftJoin(products, eq(productVariants.productId, products.id))
        .where(eq(bookings.id, notification.bookingId))
        .limit(1);

      if (rows.length === 0) throw new Error(`Réservation ${notification.bookingId} introuvable`);
      const row = rows[0]!;

      return renderBookingCancelledMerchant({
        bookingId: row.bookingId,
        organizationName: row.organizationName,
        customerEmail: row.customerEmail,
        productName: row.productName ?? 'Équipement Uttily',
        actorReason: row.actorReason ?? 'Annulation',
        retainedAmountMinor: row.retainedAmountMinor ?? 0,
        finalMerchantRevenueMinor: row.finalMerchantRevenueMinor ?? 0,
      });
    }

    case 'REFUND_CONFIRMED_CUSTOMER': {
      if (!notification.refundId)
        throw new Error('refundId manquant pour REFUND_CONFIRMED_CUSTOMER');
      const rows = await db
        .select({
          refundId: refunds.id,
          amountMinor: refunds.amountMinor,
          organizationName: organizations.legalName,
          productName: products.name,
        })
        .from(refunds)
        .innerJoin(organizations, eq(refunds.organizationId, organizations.id))
        .leftJoin(payments, eq(refunds.paymentId, payments.id))
        .leftJoin(bookings, eq(payments.id, bookings.paymentId))
        .leftJoin(bookingLines, eq(bookings.id, bookingLines.bookingId))
        .leftJoin(productVariants, eq(bookingLines.variantId, productVariants.id))
        .leftJoin(products, eq(productVariants.productId, products.id))
        .where(eq(refunds.id, notification.refundId))
        .limit(1);

      if (rows.length === 0) throw new Error(`Remboursement ${notification.refundId} introuvable`);
      const row = rows[0]!;

      return renderRefundConfirmedCustomer({
        refundId: row.refundId,
        organizationName: row.organizationName,
        productName: row.productName ?? 'Équipement Uttily',
        amountMinor: row.amountMinor,
      });
    }

    case 'PICKUP_REMINDER_CUSTOMER': {
      if (!notification.bookingId)
        throw new Error('bookingId manquant pour PICKUP_REMINDER_CUSTOMER');
      const rows = await db
        .select({
          bookingId: bookings.id,
          customerStartAt: bookings.customerStartAt,
          organizationName: organizations.legalName,
          locationName: locations.name,
          timeZone: locations.timeZone,
          productName: products.name,
        })
        .from(bookings)
        .innerJoin(organizations, eq(bookings.organizationId, organizations.id))
        .innerJoin(locations, eq(bookings.locationId, locations.id))
        .leftJoin(bookingLines, eq(bookings.id, bookingLines.bookingId))
        .leftJoin(productVariants, eq(bookingLines.variantId, productVariants.id))
        .leftJoin(products, eq(productVariants.productId, products.id))
        .where(eq(bookings.id, notification.bookingId))
        .limit(1);

      if (rows.length === 0) throw new Error(`Réservation ${notification.bookingId} introuvable`);
      const row = rows[0]!;

      return renderPickupReminderCustomer({
        bookingId: row.bookingId,
        organizationName: row.organizationName,
        productName: row.productName ?? 'Équipement Uttily',
        customerStartAt: row.customerStartAt,
        locationName: row.locationName,
        timeZone: row.timeZone,
      });
    }

    case 'RETURN_REMINDER_CUSTOMER': {
      if (!notification.bookingId)
        throw new Error('bookingId manquant pour RETURN_REMINDER_CUSTOMER');
      const rows = await db
        .select({
          bookingId: bookings.id,
          customerEndAt: bookings.customerEndAt,
          organizationName: organizations.legalName,
          locationName: locations.name,
          timeZone: locations.timeZone,
          productName: products.name,
        })
        .from(bookings)
        .innerJoin(organizations, eq(bookings.organizationId, organizations.id))
        .innerJoin(locations, eq(bookings.locationId, locations.id))
        .leftJoin(bookingLines, eq(bookings.id, bookingLines.bookingId))
        .leftJoin(productVariants, eq(bookingLines.variantId, productVariants.id))
        .leftJoin(products, eq(productVariants.productId, products.id))
        .where(eq(bookings.id, notification.bookingId))
        .limit(1);

      if (rows.length === 0) throw new Error(`Réservation ${notification.bookingId} introuvable`);
      const row = rows[0]!;

      return renderReturnReminderCustomer({
        bookingId: row.bookingId,
        organizationName: row.organizationName,
        productName: row.productName ?? 'Équipement Uttily',
        customerEndAt: row.customerEndAt,
        locationName: row.locationName,
        timeZone: row.timeZone,
      });
    }

    case 'REFUND_ACTION_REQUIRED_MERCHANT': {
      if (!notification.refundId)
        throw new Error('refundId manquant pour REFUND_ACTION_REQUIRED_MERCHANT');
      const rows = await db
        .select({
          refundId: refunds.id,
          amountMinor: refunds.amountMinor,
          organizationName: organizations.legalName,
          bookingId: bookings.id,
        })
        .from(refunds)
        .innerJoin(organizations, eq(refunds.organizationId, organizations.id))
        .leftJoin(payments, eq(refunds.paymentId, payments.id))
        .leftJoin(bookings, eq(payments.id, bookings.paymentId))
        .where(eq(refunds.id, notification.refundId))
        .limit(1);

      if (rows.length === 0) throw new Error(`Remboursement ${notification.refundId} introuvable`);
      const row = rows[0]!;

      return renderRefundActionRequiredMerchant({
        refundId: row.refundId,
        organizationName: row.organizationName,
        bookingId: row.bookingId ?? 'N/A',
        amountMinor: row.amountMinor,
        failureCode: notification.failureCode ?? undefined,
      });
    }

    default:
      throw new Error(`Template inconnu : ${(notification as { template: string }).template}`);
  }
}
