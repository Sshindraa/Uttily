import Link from 'next/link';
import { listInventorySummaries, getMembership, CATALOG_MANAGERS } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';

export default async function InventoryListPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { db, organizationId, user } = await requireCatalogViewerOf((await params).orgId);
  const items = await listInventorySummaries(db, organizationId);
  const membership = await getMembership(db, organizationId, user.id);
  const canManage = membership !== null && CATALOG_MANAGERS.includes(membership.role);

  return (
    <main>
      <h1>Inventaire</h1>
      {canManage && (
        <Link href={`/dashboard/${organizationId}/inventory/new`}>Ajouter un exemplaire</Link>
      )}
      {items.length === 0 ? (
        <p>Aucun exemplaire.</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <Link href={`/dashboard/${organizationId}/inventory/${item.id}`}>
                {item.internalSku}
              </Link>
              {' — '}
              {item.serialNumber ?? 'sans série'}
              {' — '}
              {item.condition}
              {' — '}
              {item.status}
              {' — '}
              {item.productName} / {item.variantName}
              {' — '}
              {item.locationName}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
