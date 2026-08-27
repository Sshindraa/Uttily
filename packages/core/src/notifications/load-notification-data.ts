import { eq } from 'drizzle-orm';
import type { DbExecutor, NotificationRecord } from '@uttily/database';
import {
  bookingCancellations,
  bookingLines,
  bookings,
  locations,
  organizationInvitations,
  organizations,
  payments,
  products,
  productVariants,
  refunds,
  users,
} from '@uttily/database';
import { createSignedInvitationToken } from '../identity/invitations';
import { getPublicAppUrl } from '../identity/public-app-url';
import type { RenderedEmail } from './types';
import {
  renderBookingCancelledCustomer,
  renderBookingCancelledMerchant,
  renderBookingConfirmedCustomer,
  renderBookingConfirmedMerchant,
  renderOrganizationInvitation,
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
        productName: row.productName ?? 'Équipement Uttily',
        customerStartAt: row.customerStartAt,
        customerEndAt: row.customerEndAt,
        customerEmail: row.customerEmail,
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
          refundAmountMinor: bookingCancellations.refundAmountMinor,
          retainedAmountMinor: bookingCancellations.retainedAmountMinor,
          customerStartAt: bookings.customerStartAt,
          productName: products.name,
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
          retainedAmountMinor: bookingCancellations.retainedAmountMinor,
          finalMerchantRevenueMinor: bookingCancellations.finalMerchantRevenueMinor,
          actorReason: bookingCancellations.actorReason,
          productName: products.name,
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
        productName: row.productName ?? 'Équipement Uttily',
        customerEmail: row.customerEmail,
        actorReason: row.actorReason ?? 'ANNULATION_CLIENT',
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
          locationAddress: locations.addressLine1,
          locationPhone: locations.publicPhone,
          pickupInstructions: locations.pickupInstructions,
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
        locationAddress: row.locationAddress ?? undefined,
        locationPhone: row.locationPhone,
        pickupInstructions: row.pickupInstructions,
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
          locationAddress: locations.addressLine1,
          locationPhone: locations.publicPhone,
          returnInstructions: locations.returnInstructions,
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
        locationAddress: row.locationAddress ?? undefined,
        locationPhone: row.locationPhone,
        returnInstructions: row.returnInstructions,
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
        bookingId: row.bookingId ?? 'N/A',
        organizationName: row.organizationName,
        amountMinor: row.amountMinor,
      });
    }

    case 'ORGANIZATION_INVITATION': {
      const meta = (notification.metadata ?? {}) as {
        organizationName?: string;
        roleName?: string;
        invitationId?: string;
      };

      const invitationId =
        meta.invitationId || notification.idempotencyKey?.replace(/^invitation:/, '');
      if (!invitationId) {
        throw new Error('invitationId manquant pour ORGANIZATION_INVITATION');
      }

      const rows = await db
        .select({
          id: organizationInvitations.id,
          organizationId: organizationInvitations.organizationId,
          email: organizationInvitations.email,
          role: organizationInvitations.role,
          expiresAt: organizationInvitations.expiresAt,
          status: organizationInvitations.status,
          orgLegalName: organizations.legalName,
          orgDisplayName: organizations.publicDisplayName,
        })
        .from(organizationInvitations)
        .innerJoin(organizations, eq(organizationInvitations.organizationId, organizations.id))
        .where(eq(organizationInvitations.id, invitationId))
        .limit(1);

      if (rows.length === 0) {
        throw new Error(`Invitation ${invitationId} introuvable`);
      }
      const invitationRow = rows[0]!;

      const roleLabels: Record<string, string> = {
        OWNER: 'Propriétaire',
        ADMIN: 'Administrateur',
        MANAGER: 'Responsable',
        STAFF: "Membre d'équipe",
      };

      const organizationName =
        meta.organizationName ??
        invitationRow.orgDisplayName ??
        invitationRow.orgLegalName ??
        'Votre organisation';
      const roleName = meta.roleName ?? roleLabels[invitationRow.role] ?? invitationRow.role;

      // Reconstruire le token signé
      const token = createSignedInvitationToken({
        invitationId: invitationRow.id,
        organizationId: invitationRow.organizationId,
        email: invitationRow.email,
        expiresAt: invitationRow.expiresAt,
      });

      // Résoudre l'URL canonique validée de l'application
      const baseUrl = getPublicAppUrl(process.env);
      const acceptUrl = `${baseUrl}/invitations?token=${encodeURIComponent(token)}`;

      return renderOrganizationInvitation({
        organizationName,
        roleName,
        acceptUrl,
        expiresInDays: Math.max(
          1,
          Math.ceil((invitationRow.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
        ),
      });
    }

    default:
      throw new Error(`Template inconnu : ${notification.template}`);
  }
}
