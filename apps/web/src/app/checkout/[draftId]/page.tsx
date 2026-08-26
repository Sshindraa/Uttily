import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { bookingDrafts, bookingDraftLines } from '@uttily/database';
import { CheckoutClient } from './checkout-client';
import { getPublicAppUrl } from '@/lib/public-app-url';

/**
 * Page de checkout — récapitulatif du brouillon de réservation puis paiement.
 *
 * Côté serveur : authentification, lecture du brouillon et validation que
 * l'utilisateur courant en est le customer. Le clientSecret n'est jamais lu
 * ici — il transite uniquement de la Server Action au composant client.
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
    })
    .from(bookingDrafts)
    .where(eq(bookingDrafts.id, draftId))
    .limit(1);

  if (draft.length === 0) {
    return (
      <main>
        <h1>Brouillon introuvable</h1>
        <p>Ce brouillon de réservation n'existe pas ou a expiré.</p>
      </main>
    );
  }

  const d = draft[0]!;
  if (d.customerUserId !== user.id) {
    return (
      <main>
        <h1>Accès refusé</h1>
        <p>Ce brouillon ne vous appartient pas.</p>
      </main>
    );
  }

  const publicAppUrl = getPublicAppUrl();

  // Lire les lignes du brouillon pour le récapitulatif.
  const lines = await db
    .select({
      variantId: bookingDraftLines.variantId,
      quantity: bookingDraftLines.quantity,
      lineTotalAmountMinor: bookingDraftLines.lineTotalAmountMinor,
    })
    .from(bookingDraftLines)
    .where(eq(bookingDraftLines.draftId, draftId));

  return (
    <main>
      <h1>Paiement</h1>
      <CheckoutClient
        draftId={draftId}
        returnUrl={`${publicAppUrl}/checkout/${draftId}`}
        totalAmountMinor={d.totalAmountMinor}
        currency={d.currency}
        lines={lines}
        expiresAt={d.expiresAt ? d.expiresAt.toISOString() : null}
      />
    </main>
  );
}
