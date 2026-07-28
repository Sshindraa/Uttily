import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getInventoryDetails, getMembership, CATALOG_MANAGERS } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import { InventoryActions } from './inventory-actions';

export default async function InventoryDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; itemId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, itemId } = await params;
  const { db, organizationId, user } = await requireCatalogViewerOf(orgId);
  const details = await getInventoryDetails(db, organizationId, itemId);
  if (details === null) notFound();

  const membership = await getMembership(db, organizationId, user.id);
  const canManage = membership !== null && CATALOG_MANAGERS.includes(membership.role);

  const { item, variant, product, location, movements } = details;

  return (
    <main>
      <h1>Exemplaire — {item.internalSku}</h1>
      <p>SKU interne : {item.internalSku}</p>
      <p>Numéro de série : {item.serialNumber ?? '—'}</p>
      <p>État : {item.condition}</p>
      <p>Statut : {item.status}</p>
      <p>Variante : {variant.name}</p>
      <p>Produit : {product.name}</p>
      <p>Établissement : {location.name}</p>
      <p>Notes : {item.notes ?? '—'}</p>

      {canManage && (
        <section aria-labelledby="actions-heading">
          <h2 id="actions-heading">Actions</h2>
          <InventoryActions orgId={organizationId} itemId={item.id} status={item.status} />
          <p>
            <Link href={`/dashboard/${organizationId}/inventory/${item.id}/edit`}>Éditer</Link>
          </p>
        </section>
      )}

      <section aria-labelledby="movements-heading">
        <h2 id="movements-heading">Mouvements</h2>
        {movements.length === 0 ? (
          <p>Aucun mouvement.</p>
        ) : (
          <ul>
            {movements.map((movement) => (
              <li key={movement.id}>
                {movement.createdAt.toISOString()}
                {' — '}
                {movement.fromLocationId ?? '—'}
                {' → '}
                {movement.toLocationId ?? '—'}
                {movement.reason ? ` — ${movement.reason}` : ''}
                {movement.idempotencyKey ? ` — clé: ${movement.idempotencyKey}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
