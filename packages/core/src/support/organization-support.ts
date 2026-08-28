import { and, count, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import type { DatabaseClient, DbExecutor } from '@uttily/database';
import {
  bookings,
  damageReports,
  inventoryItems,
  locationOpeningHours,
  locations,
  locationScheduleExceptions,
  maintenanceCases,
  notifications,
  organizationInvitations,
  organizationMemberships,
  organizationPaymentAccounts,
  organizations,
  payments,
  products,
  productVariants,
  users,
} from '@uttily/database';
import { getOrganizationOnboardingReadiness } from '../dashboard/onboarding-readiness';
import type { OrganizationSupportDetails } from './types';

export class SupportOrganizationNotFoundError extends Error {
  constructor(organizationId: string) {
    super(`Organisation introuvable: ${organizationId}`);
    this.name = 'SupportOrganizationNotFoundError';
  }
}

/**
 * Récupère la vue support exhaustive 360° pour une organisation.
 * Réutilise l'autorité officielle de readiness et les modèles de données métier.
 */
export async function getOrganizationSupportDetails(
  db: DatabaseClient | DbExecutor,
  organizationId: string,
): Promise<OrganizationSupportDetails> {
  // 1. Organisation
  const [org] = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
    .limit(1);

  if (!org) {
    throw new SupportOrganizationNotFoundError(organizationId);
  }

  // 2. Readiness officielle (autorité du domaine)
  // Casting db to DatabaseClient for readiness loader which expects DatabaseClient
  const readiness = await getOrganizationOnboardingReadiness(
    db as DatabaseClient,
    organizationId,
  );

  // 3. Établissements
  const locationRows = await db
    .select({
      id: locations.id,
      name: locations.name,
      addressLine1: locations.addressLine1,
      city: locations.city,
      postalCode: locations.postalCode,
      countryCode: locations.countryCode,
      timeZone: locations.timeZone,
      pickupEnabled: locations.pickupEnabled,
    })
    .from(locations)
    .where(and(eq(locations.organizationId, organizationId), isNull(locations.deletedAt)));

  const locationIds = locationRows.map((l) => l.id);

  let openingHoursCounts: Record<string, number> = {};
  let scheduleExceptionsCounts: Record<string, number> = {};

  if (locationIds.length > 0) {
    const hoursRows = await db
      .select({
        locationId: locationOpeningHours.locationId,
        count: count(),
      })
      .from(locationOpeningHours)
      .where(inArray(locationOpeningHours.locationId, locationIds))
      .groupBy(locationOpeningHours.locationId);

    for (const r of hoursRows) {
      openingHoursCounts[r.locationId] = Number(r.count);
    }

    const exRows = await db
      .select({
        locationId: locationScheduleExceptions.locationId,
        count: count(),
      })
      .from(locationScheduleExceptions)
      .where(inArray(locationScheduleExceptions.locationId, locationIds))
      .groupBy(locationScheduleExceptions.locationId);

    for (const r of exRows) {
      scheduleExceptionsCounts[r.locationId] = Number(r.count);
    }
  }

  const locationsData = locationRows.map((l) => ({
    id: l.id,
    name: l.name,
    addressLine1: l.addressLine1 ?? '',
    city: l.city ?? '',
    postalCode: l.postalCode ?? '',
    countryCode: l.countryCode ?? 'FR',
    timeZone: l.timeZone,
    pickupEnabled: l.pickupEnabled ?? false,
    openingHoursCount: openingHoursCounts[l.id] ?? 0,
    scheduleExceptionsCount: scheduleExceptionsCounts[l.id] ?? 0,
  }));

  // 4. Membres & Invitations
  const memberRows = await db
    .select({
      id: organizationMemberships.id,
      userId: organizationMemberships.userId,
      role: organizationMemberships.role,
      status: organizationMemberships.status,
      createdAt: organizationMemberships.createdAt,
      acceptedAt: organizationMemberships.acceptedAt,
      email: users.email,
      displayName: users.displayName,
      isPlatformAdmin: users.isPlatformAdmin,
    })
    .from(organizationMemberships)
    .innerJoin(users, eq(organizationMemberships.userId, users.id))
    .where(eq(organizationMemberships.organizationId, organizationId));

  const invitationRows = await db
    .select({
      id: organizationInvitations.id,
      email: organizationInvitations.email,
      role: organizationInvitations.role,
      status: organizationInvitations.status,
      expiresAt: organizationInvitations.expiresAt,
      createdAt: organizationInvitations.createdAt,
    })
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.organizationId, organizationId),
        eq(organizationInvitations.status, 'PENDING'),
      ),
    );

  // 5. Compte de paiement Stripe Connect
  const [paymentAccountRow] = await db
    .select({
      id: organizationPaymentAccounts.id,
      providerAccountId: organizationPaymentAccounts.providerAccountId,
      onboardingStatus: organizationPaymentAccounts.onboardingStatus,
      chargesEnabled: organizationPaymentAccounts.chargesEnabled,
      payoutsEnabled: organizationPaymentAccounts.payoutsEnabled,
      transfersCapabilityStatus: organizationPaymentAccounts.transfersCapabilityStatus,
    })
    .from(organizationPaymentAccounts)
    .where(
      and(
        eq(organizationPaymentAccounts.organizationId, organizationId),
        eq(organizationPaymentAccounts.provider, 'STRIPE'),
      ),
    )
    .limit(1);

  // 6. Inventaire
  const inventoryRows = await db
    .select({
      itemId: inventoryItems.id,
      status: inventoryItems.status,
      productId: products.id,
      productName: products.name,
    })
    .from(inventoryItems)
    .innerJoin(productVariants, eq(inventoryItems.productVariantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(products.organizationId, organizationId),
        isNull(inventoryItems.deletedAt),
        isNull(products.deletedAt),
      ),
    );

  let activeInvCount = 0;
  let retiredInvCount = 0;
  let lostInvCount = 0;
  const byProductMap: Record<
    string,
    { productId: string; productName: string; totalCount: number; activeCount: number }
  > = {};

  for (const inv of inventoryRows) {
    if (inv.status === 'ACTIVE') activeInvCount++;
    else if (inv.status === 'RETIRED') retiredInvCount++;
    else if (inv.status === 'LOST') lostInvCount++;

    const entry = byProductMap[inv.productId] ?? {
      productId: inv.productId,
      productName: inv.productName,
      totalCount: 0,
      activeCount: 0,
    };
    entry.totalCount++;
    if (inv.status === 'ACTIVE') {
      entry.activeCount++;
    }
    byProductMap[inv.productId] = entry;
  }

  // 7. Réservations récentes (10 dernières)
  const recentBookingRows = await db
    .select({
      id: bookings.id,
      customerEmail: users.email,
      status: bookings.status,
      totalAmountMinor: bookings.totalAmountMinor,
      currency: bookings.currency,
      pickupDate: bookings.customerStartAt,
      returnDate: bookings.customerEndAt,
      createdAt: bookings.createdAt,
    })
    .from(bookings)
    .innerJoin(users, eq(bookings.customerUserId, users.id))
    .where(eq(bookings.organizationId, organizationId))
    .orderBy(desc(bookings.createdAt))
    .limit(10);

  const recentBookingsData = recentBookingRows.map((b) => ({
    id: b.id,
    customerEmail: b.customerEmail ?? null,
    status: b.status,
    totalAmountMinor: b.totalAmountMinor,
    currency: b.currency,
    pickupDate: b.pickupDate,
    returnDate: b.returnDate,
    createdAt: b.createdAt,
  }));

  // 8. Incidents opérationnels
  const openMaintenanceRows = await db
    .select({
      id: maintenanceCases.id,
      status: maintenanceCases.status,
      reason: maintenanceCases.reason,
      openedAt: maintenanceCases.openedAt,
      inventoryItemId: maintenanceCases.inventoryItemId,
      bikeIdentifier: inventoryItems.internalSku,
    })
    .from(maintenanceCases)
    .innerJoin(inventoryItems, eq(maintenanceCases.inventoryItemId, inventoryItems.id))
    .where(
      and(
        eq(maintenanceCases.organizationId, organizationId),
        ne(maintenanceCases.status, 'RESOLVED'),
        isNull(maintenanceCases.deletedAt),
      ),
    )
    .limit(20);

  const [damageReportsCountRow] = await db
    .select({ val: count() })
    .from(damageReports)
    .where(eq(damageReports.organizationId, organizationId));

  // 9. Alertes
  const [failedNotifsRow] = await db
    .select({ val: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.organizationId, organizationId),
        or(
          eq(notifications.status, 'FAILED'),
          eq(notifications.requiresManualReview, true),
        ),
      ),
    );

  const [failedPaymentsRow] = await db
    .select({ val: count() })
    .from(payments)
    .where(
      and(
        eq(payments.organizationId, organizationId),
        eq(payments.status, 'FAILED'),
      ),
    );

  const failedNotifsCount = Number(failedNotifsRow?.val ?? 0);
  const failedPaymentsCount = Number(failedPaymentsRow?.val ?? 0);
  const openMaintenanceCount = openMaintenanceRows.length;

  return {
    id: org.id,
    legalName: org.legalName,
    slug: org.slug,
    publicDisplayName: org.publicDisplayName,
    status: org.status,
    defaultCurrency: org.defaultCurrency,
    defaultCancellationPolicyCode: org.defaultCancellationPolicyCode,
    createdAt: org.createdAt,
    readiness,
    locations: locationsData,
    members: memberRows.map((m) => ({
      id: m.id,
      userId: m.userId,
      email: m.email,
      displayName: m.displayName,
      role: m.role,
      status: m.status,
      isPlatformAdmin: m.isPlatformAdmin,
      createdAt: m.createdAt,
      acceptedAt: m.acceptedAt,
    })),
    pendingInvitations: invitationRows.map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      status: inv.status,
      expiresAt: inv.expiresAt,
      createdAt: inv.createdAt,
    })),
    paymentAccount: paymentAccountRow
      ? {
          id: paymentAccountRow.id,
          providerAccountId: paymentAccountRow.providerAccountId,
          onboardingStatus: paymentAccountRow.onboardingStatus,
          chargesEnabled: paymentAccountRow.chargesEnabled ?? false,
          payoutsEnabled: paymentAccountRow.payoutsEnabled ?? false,
          transfersCapabilityStatus: paymentAccountRow.transfersCapabilityStatus,
        }
      : null,
    inventoryOverview: {
      total: inventoryRows.length,
      active: activeInvCount,
      retired: retiredInvCount,
      lost: lostInvCount,
      byProduct: Object.values(byProductMap),
    },
    recentBookings: recentBookingsData,
    openIncidents: {
      openMaintenanceCount,
      damageReportsCount: Number(damageReportsCountRow?.val ?? 0),
      maintenanceCases: openMaintenanceRows.map((mc) => ({
        id: mc.id,
        status: mc.status,
        reason: mc.reason,
        openedAt: mc.openedAt,
        inventoryItemId: mc.inventoryItemId,
        bikeIdentifier: mc.bikeIdentifier,
      })),
    },
    alerts: {
      failedNotificationsCount: failedNotifsCount,
      failedPaymentsCount,
      requiresAttentionCount: failedNotifsCount + failedPaymentsCount + openMaintenanceCount,
    },
  };
}
