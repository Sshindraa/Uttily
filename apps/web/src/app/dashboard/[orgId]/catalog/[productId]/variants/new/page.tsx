import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProductDetails } from '@uttily/core';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { NewVariantForm } from './new-variant-form';

export default async function NewVariantPage({
  params,
}: {
  params: Promise<{ orgId: string; productId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, productId } = await params;
  const { db, organizationId } = await requireCatalogManagerOf(orgId);
  const details = await getProductDetails(db, organizationId, productId);
  if (details === null) notFound();

  return (
    <main>
      <h1>Nouvelle variante — {details.product.name}</h1>
      <NewVariantForm orgId={organizationId} productId={productId} />
      <p>
        <Link href={`/dashboard/${organizationId}/catalog/${productId}`}>Retour au produit</Link>
      </p>
    </main>
  );
}
