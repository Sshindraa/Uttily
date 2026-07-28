import { listActiveVariantOptions, listLocations } from '@uttily/core';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { NewInventoryForm } from './new-inventory-form';

export default async function NewInventoryItemPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { db, organizationId } = await requireCatalogManagerOf((await params).orgId);
  const variants = await listActiveVariantOptions(db, organizationId);
  const locations = await listLocations(db, organizationId);

  return (
    <main>
      <h1>Nouvel exemplaire</h1>
      <NewInventoryForm orgId={organizationId} variants={variants} locations={locations} />
    </main>
  );
}
