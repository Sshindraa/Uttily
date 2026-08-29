import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  bookingDrafts,
  bookingDraftLines,
  productVariants,
  products,
  organizations,
} from '@uttily/database';
import { CheckoutClient } from './checkout-client';
import { getPublicAppUrl } from '@/lib/public-app-url';
import { ClientShell } from '@/components/client-shell';

/**
 * Page de checkout — récapitulatif du panier de réservation puis paiement sécurisé Stripe.
 */
export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ draftId: string }>;
}): Promise<React.ReactElement> {
  const { draftId } = await params;
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');
  const db = getDb();

  // Lire le brouillon côté serveur.
  const draft = await db
    .select({
      id: bookingDrafts.id,
      organizationId: bookingDrafts.organizationId,
      customerUserId: bookingDrafts.customerUserId,
      totalAmountMinor: bookingDrafts.totalAmountMinor,
      currency: bookingDrafts.currency,
      status: bookingDrafts.status,
      expiresAt: bookingDrafts.expiresAt,
      orgLegalName: organizations.legalName,
      orgPublicDisplayName: organizations.publicDisplayName,
    })
    .from(bookingDrafts)
    .leftJoin(organizations, eq(bookingDrafts.organizationId, organizations.id))
    .where(eq(bookingDrafts.id, draftId))
    .limit(1);

  if (draft.length === 0) {
    return (
      <ClientShell>
        <main style={{ maxWidth: 640, margin: '4rem auto', padding: '1rem', textAlign: 'center' }}>
          <h1>Réservation introuvable ou expirée</h1>
          <p style={{ color: 'var(--ut-color-ink-muted)' }}>
            Ce panier de réservation n’est plus valide. Veuillez relancer une recherche.
          </p>
        </main>
      </ClientShell>
    );
  }

  const d = draft[0]!;
  if (d.customerUserId !== user.id) {
    return (
      <ClientShell>
        <main style={{ maxWidth: 640, margin: '4rem auto', padding: '1rem', textAlign: 'center' }}>
          <h1>Accès refusé</h1>
          <p style={{ color: 'var(--ut-color-ink-muted)' }}>
            Cette réservation appartient à un autre compte utilisateur.
          </p>
        </main>
      </ClientShell>
    );
  }

  const publicAppUrl = getPublicAppUrl();

  // Lire les lignes du brouillon avec les libellés réels des vélos et variantes
  const lines = await db
    .select({
      variantId: bookingDraftLines.variantId,
      quantity: bookingDraftLines.quantity,
      lineTotalAmountMinor: bookingDraftLines.lineTotalAmountMinor,
      productName: products.name,
      variantName: productVariants.name,
    })
    .from(bookingDraftLines)
    .leftJoin(productVariants, eq(bookingDraftLines.variantId, productVariants.id))
    .leftJoin(products, eq(productVariants.productId, products.id))
    .where(eq(bookingDraftLines.draftId, draftId));

  const formattedLines = lines.map((l) => ({
    variantId: l.variantId,
    quantity: l.quantity,
    lineTotalAmountMinor: l.lineTotalAmountMinor,
    title: l.productName
      ? l.variantName
        ? `${l.productName} (${l.variantName})`
        : l.productName
      : 'Équipement loué',
  }));

  const renterName = d.orgPublicDisplayName || d.orgLegalName || 'Loueur partenaire';

  return (
    <ClientShell>
      <main style={{ maxWidth: 540, margin: '2rem auto', padding: '1rem' }}>
        <CheckoutClient
          draftId={draftId}
          returnUrl={`${publicAppUrl}/checkout/${draftId}`}
          totalAmountMinor={d.totalAmountMinor}
          currency={d.currency}
          lines={formattedLines}
          renterName={renterName}
          expiresAt={d.expiresAt ? d.expiresAt.toISOString() : null}
        />
      </main>
    </ClientShell>
  );
}
