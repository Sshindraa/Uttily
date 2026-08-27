import { getOperationalPlanning, listLocations } from '@uttily/core';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import { PlanningView } from './planning-view';
import styles from './planning.module.css';

export default async function PlanningPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams?: Promise<{ locationId?: string; from?: string; to?: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const sp = (await searchParams) ?? {};

  const { db, organizationId } = await requireFulfillmentOperatorOf(orgId);
  const locations = await listLocations(db, organizationId);

  const selectedLocationId = sp.locationId ?? locations[0]?.id ?? null;
  const fromDate = sp.from ? new Date(sp.from) : undefined;
  const toDate = sp.to ? new Date(sp.to) : undefined;

  const planning = await getOperationalPlanning(db, organizationId, {
    locationId: selectedLocationId ?? undefined,
    from: fromDate,
    to: toDate,
  });

  return (
    <main className={styles.main}>
      <PlanningView
        orgId={organizationId}
        planning={planning}
        locations={locations.map((l) => ({ id: l.id, name: l.name }))}
        selectedLocationId={selectedLocationId}
      />
    </main>
  );
}
