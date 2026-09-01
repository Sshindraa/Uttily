import { notFound } from 'next/navigation';
import { getMaintenanceCaseDetails } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import { isValidUuid } from '@/lib/operations-helpers';
import { MaintenanceCaseDetailView } from '@/features/fleet';

export default async function MaintenanceCaseDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; blockId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, blockId } = await params;

  if (!isValidUuid(blockId)) notFound();

  const { db, organizationId } = await requireCatalogViewerOf(orgId);
  const caseDetails = await getMaintenanceCaseDetails(db, organizationId, blockId);
  if (caseDetails === null) notFound();

  return <MaintenanceCaseDetailView organizationId={organizationId} caseDetails={caseDetails} />;
}
