import { notFound } from 'next/navigation';
import { getInventoryDetails, listLocations } from '@uttily/core';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { TransferForm } from './transfer-form';

export default async function TransferInventoryItemPage({
  params,
}: {
  params: Promise<{ orgId: string; itemId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, itemId } = await params;
  const { db, organizationId } = await requireCatalogManagerOf(orgId);
  const details = await getInventoryDetails(db, organizationId, itemId);
  if (details === null) notFound();
  const locations = await listLocations(db, organizationId);

  // Clé d'idempotence générée côté serveur à l'affichage du formulaire.
  // Stable pendant les retries : la même clé est réutilisée tant que le
  // composant client n'est pas remonté, ce qui permet au domaine de détecter
  // le rejeu et de retourner le mouvement existant.
  const idempotencyKey = crypto.randomUUID();

  return (
    <main>
      <h1>Transférer l'exemplaire — {details.item.internalSku}</h1>
      <TransferForm
        orgId={organizationId}
        itemId={details.item.id}
        currentLocationId={details.item.currentLocationId}
        locations={locations}
        idempotencyKey={idempotencyKey}
      />
    </main>
  );
}
