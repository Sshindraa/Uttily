import { notFound } from 'next/navigation';
import { getInventoryDetails } from '@uttily/core';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { EditInventoryForm } from './edit-inventory-form';

export default async function EditInventoryItemPage({
  params,
}: {
  params: Promise<{ orgId: string; itemId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, itemId } = await params;
  const { db, organizationId } = await requireCatalogManagerOf(orgId);
  const details = await getInventoryDetails(db, organizationId, itemId);
  if (details === null) notFound();

  return (
    <main>
      <h1>Éditer l'exemplaire — {details.item.internalSku}</h1>
      <EditInventoryForm orgId={organizationId} item={details.item} />
    </main>
  );
}
