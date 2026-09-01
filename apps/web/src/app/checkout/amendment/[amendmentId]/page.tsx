import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getSupplementCheckoutSummary } from '@uttily/core';
import { ClientShell } from '@/components/shells/client-shell';
import { CheckoutFrame, CheckoutMessage, SupplementCheckoutPageView } from '@/features/checkout';

interface PageProps {
  params: Promise<{ amendmentId: string }>;
}

export default async function AmendmentCheckoutPage({
  params,
}: PageProps): Promise<React.ReactElement> {
  const { amendmentId } = await params;
  const user = await getAuthenticatedUser();
  if (!user) {
    redirect(
      `/sign-in?redirect_url=${encodeURIComponent(`/checkout/amendment/${encodeURIComponent(amendmentId)}`)}`,
    );
  }

  const db = getDb();
  const summary = await getSupplementCheckoutSummary(db, {
    amendmentId,
    customerUserId: user.id,
  });

  if (summary.kind === 'NOT_FOUND') {
    return (
      <ClientShell>
        <CheckoutFrame>
          <CheckoutMessage
            title="Paiement introuvable"
            description="Ce paiement de modification n'existe pas ou ne vous est pas accessible."
          />
        </CheckoutFrame>
      </ClientShell>
    );
  }

  if (summary.kind === 'EXPIRED') {
    return (
      <ClientShell>
        <CheckoutFrame>
          <CheckoutMessage
            title="Délai de paiement expiré"
            description="Le délai de 10 minutes pour régler cette modification a expiré. Les articles associés ont été libérés."
          />
        </CheckoutFrame>
      </ClientShell>
    );
  }

  if (summary.kind === 'PAID') {
    return (
      <ClientShell>
        <CheckoutFrame>
          <CheckoutMessage
            title="Modification déjà réglée"
            description="Ce supplément a déjà été réglé. La modification est en cours d'application ou a déjà été confirmée."
          />
        </CheckoutFrame>
      </ClientShell>
    );
  }

  if (summary.kind === 'PROCESSING') {
    return (
      <ClientShell>
        <CheckoutFrame>
          <CheckoutMessage
            title="Paiement en cours de traitement"
            description="Votre paiement est en cours de validation bancaire. Vous serez notifié dès sa confirmation."
          />
        </CheckoutFrame>
      </ClientShell>
    );
  }

  if (summary.kind === 'INVALID_STATE') {
    return (
      <ClientShell>
        <CheckoutFrame>
          <CheckoutMessage
            title="Paiement indisponible"
            description="Ce paiement ne peut pas être effectué dans l'état actuel. Veuillez contacter votre loueur."
          />
        </CheckoutFrame>
      </ClientShell>
    );
  }

  return (
    <ClientShell>
      <CheckoutFrame>
        <SupplementCheckoutPageView
          amendmentId={amendmentId}
          amountMinor={summary.amountMinor}
          currency={summary.currency}
          holdDeadline={summary.holdDeadline}
          timeZone={summary.timeZone}
        />
      </CheckoutFrame>
    </ClientShell>
  );
}
