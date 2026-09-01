import {
  listLocations,
  listMaintenanceDashboardSignals,
  listOperationalBookings,
  countOperationalBookings,
  listMembers,
  listInventorySummaries,
  getOrganizationOnboardingReadiness,
  getOrganizationById,
  getMerchantFinanceOverview,
  getProfessionalVerification,
} from '@uttily/core';
import type { ReactElement } from 'react';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import { DashboardCockpit, type DashboardTask } from '@/features/dashboard';

export default async function OrganizationDashboardPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<ReactElement> {
  const { orgId } = await params;
  const { db, organizationId } = await requireFulfillmentOperatorOf(orgId);
  const asOf = new Date();
  const org = await getOrganizationById(db, organizationId);
  const readiness = await getOrganizationOnboardingReadiness(db, organizationId);
  const professionalVerification = await getProfessionalVerification(db, organizationId, 'LIVE');
  const locations = await listLocations(db, organizationId);
  const maintenanceSignals = await listMaintenanceDashboardSignals(db, organizationId, { asOf });
  const todayPickups = await listOperationalBookings(db, organizationId, {
    statuses: ['CONFIRMED', 'READY_FOR_PICKUP'],
    localDateAt: asOf,
    localDateField: 'START',
    limit: null,
  });
  const todayReturns = await listOperationalBookings(db, organizationId, {
    statuses: ['ACTIVE'],
    localDateAt: asOf,
    localDateField: 'END',
    limit: null,
  });
  const activeBookingCount = await countOperationalBookings(db, organizationId, [
    'CONFIRMED',
    'READY_FOR_PICKUP',
    'ACTIVE',
  ]);
  const members = await listMembers(db, organizationId);
  const inventoryItems = await listInventorySummaries(db, organizationId);
  const financesOverview = await getMerchantFinanceOverview(db, organizationId);

  const activeFleetCount = inventoryItems.filter(
    (item) => item.status === 'ACTIVE' && item.condition !== 'BROKEN',
  ).length;
  const todayTasks: DashboardTask[] = [
    ...todayPickups.map((booking) => ({
      type: 'PICKUP' as const,
      bookingId: booking.id,
      time: booking.customerStartAt,
      timeZone: booking.locationTimeZone,
      modelName: `${booking.bookingItemCount} équipement(s) à remettre`,
      sku: `#${booking.id.slice(0, 6).toUpperCase()}`,
      locationName: booking.locationName,
    })),
    ...todayReturns.map((booking) => ({
      type: 'RETURN' as const,
      bookingId: booking.id,
      time: booking.customerEndAt,
      timeZone: booking.locationTimeZone,
      modelName: `${booking.bookingItemCount} équipement(s) à réceptionner`,
      sku: `#${booking.id.slice(0, 6).toUpperCase()}`,
      locationName: booking.locationName,
    })),
  ].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  const referenceTimeZone = locations[0]?.timeZone;
  const formattedDate = new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(referenceTimeZone ? { timeZone: referenceTimeZone } : {}),
  }).format(asOf);

  return (
    <DashboardCockpit
      data={{
        organizationId,
        organizationName: org?.legalName ?? 'votre organisation',
        formattedDate,
        readiness,
        professionalVerification,
        pickupCount: todayPickups.length,
        returnCount: todayReturns.length,
        activeFleetCount,
        maintenanceSignals,
        todayTasks,
        activeBookingCount,
        locationCount: locations.length,
        memberCount: members.length,
        financePeriodLabel: financesOverview.period.label,
        netAfterCommissionMinor: financesOverview.merchant.netAfterCommissionMinor,
      }}
    />
  );
}
