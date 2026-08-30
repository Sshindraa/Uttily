import React from 'react';
import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getSupplementCheckoutSummary } from '@uttily/core';
import { ClientShell } from '@/components/client-shell';
import { SupplementCheckoutClient } from './supplement-checkout-client';

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
      <CheckoutFrame>
        <h1>Paiement introuvable</h1>
        <p>Ce paiement de modification n'existe pas ou ne vous est pas accessible.</p>
      </CheckoutFrame>
    );
  }

  if (summary.kind === 'EXPIRED') {
    return (
      <CheckoutFrame>
        <h1>Délai de paiement expiré</h1>
        <p>
          Le délai de 10 minutes pour régler cette modification a expiré. Les articles associés ont
          été libérés.
        </p>
      </CheckoutFrame>
    );
  }

  if (summary.kind === 'PAID') {
    return (
      <CheckoutFrame>
        <h1>Modification déjà réglée</h1>
        <p>
          Ce supplément a déjà été réglé. La modification est en cours d'application ou a déjà été
          confirmée.
        </p>
      </CheckoutFrame>
    );
  }

  if (summary.kind === 'PROCESSING') {
    return (
      <CheckoutFrame>
        <h1>Paiement en cours de traitement</h1>
        <p>
          Votre paiement est en cours de validation bancaire. Vous serez notifié dès sa
          confirmation.
        </p>
      </CheckoutFrame>
    );
  }

  if (summary.kind === 'INVALID_STATE') {
    return (
      <CheckoutFrame>
        <h1>Paiement indisponible</h1>
        <p>
          Ce paiement ne peut pas être effectué dans l'état actuel. Veuillez contacter votre loueur.
        </p>
      </CheckoutFrame>
    );
  }

  return (
    <CheckoutFrame>
      <h1>Règlement du supplément</h1>
      <SupplementCheckoutClient
        amendmentId={amendmentId}
        amountMinor={summary.amountMinor}
        currency={summary.currency}
        holdDeadline={summary.holdDeadline}
        timeZone={summary.timeZone}
      />
    </CheckoutFrame>
  );
}

function CheckoutFrame({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <ClientShell>
      <main style={containerStyle}>{children}</main>
    </ClientShell>
  );
}

const containerStyle: React.CSSProperties = {
  maxWidth: '32.5rem',
  margin: '2rem auto',
  padding: 'var(--ut-space-6) var(--ut-space-4)',
  color: 'var(--ut-color-ink)',
};
