import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { parseMarketplaceFeeSnapshot } from '@uttily/core';
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
import { getCheckoutCopy } from '@/lib/checkout-copy';

/**
 * Page de checkout — récapitulatif du panier de réservation puis paiement sécurisé Stripe.
 */
export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ draftId: string }>;
  searchParams: Promise<{ locale?: string | string[] }>;
}): Promise<React.ReactElement> {
  const { draftId } = await params;
  const rawLocale = (await searchParams).locale;
  const locale = (Array.isArray(rawLocale) ? rawLocale[0] : rawLocale) === 'en' ? 'en' : 'fr';
  const copy = getCheckoutCopy(locale);
  const user = await getAuthenticatedUser();
  if (!user) {
    redirect(
      `/sign-in?redirect_url=${encodeURIComponent(`/checkout/${draftId}?locale=${locale}`)}`,
    );
  }
  const db = getDb();

  // Lire le brouillon côté serveur.
  const draft = await db
    .select({
      id: bookingDrafts.id,
      organizationId: bookingDrafts.organizationId,
      customerUserId: bookingDrafts.customerUserId,
      subtotalAmountMinor: bookingDrafts.subtotalAmountMinor,
      mandatoryFeesAmountMinor: bookingDrafts.mandatoryFeesAmountMinor,
      totalAmountMinor: bookingDrafts.totalAmountMinor,
      customerTotalAmountMinor: bookingDrafts.customerTotalAmountMinor,
      marketplaceFeeSnapshot: bookingDrafts.marketplaceFeeSnapshot,
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
      <ClientShell localeOverride={locale}>
        <main style={{ maxWidth: 640, margin: '4rem auto', padding: '1rem', textAlign: 'center' }}>
          <h1>{copy.summary.missingBookingTitle}</h1>
          <p style={{ color: 'var(--ut-color-ink-muted)' }}>
            {copy.summary.missingBookingDescription}
          </p>
        </main>
      </ClientShell>
    );
  }

  const d = draft[0]!;
  if (d.customerUserId !== user.id) {
    return (
      <ClientShell localeOverride={locale}>
        <main style={{ maxWidth: 640, margin: '4rem auto', padding: '1rem', textAlign: 'center' }}>
          <h1>{copy.summary.accessDeniedTitle}</h1>
          <p style={{ color: 'var(--ut-color-ink-muted)' }}>
            {copy.summary.accessDeniedDescription}
          </p>
        </main>
      </ClientShell>
    );
  }

  const publicAppUrl = getPublicAppUrl();
  const marketplaceFeeSnapshot = d.marketplaceFeeSnapshot
    ? parseMarketplaceFeeSnapshot(d.marketplaceFeeSnapshot)
    : null;
  const customerTotalAmountMinor =
    marketplaceFeeSnapshot?.customerTotalAmountMinor ??
    d.customerTotalAmountMinor ??
    d.totalAmountMinor;
  const marketplaceFeeBaseAmountMinor =
    marketplaceFeeSnapshot?.marketplaceFeeBaseAmountMinor ??
    d.subtotalAmountMinor + d.mandatoryFeesAmountMinor;
  const customerServiceFeeAmountMinor = marketplaceFeeSnapshot?.customerServiceFeeAmountMinor ?? 0;

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
      : copy.summary.fallbackEquipment,
  }));

  const renterName = d.orgPublicDisplayName || d.orgLegalName || copy.summary.fallbackRenter;

  return (
    <ClientShell localeOverride={locale}>
      <main style={{ maxWidth: 540, margin: '2rem auto', padding: '1rem' }}>
        <CheckoutClient
          draftId={draftId}
          returnUrl={`${publicAppUrl}/checkout/${draftId}?locale=${locale}`}
          baseAmountMinor={marketplaceFeeBaseAmountMinor}
          customerServiceFeeAmountMinor={customerServiceFeeAmountMinor}
          customerTotalAmountMinor={customerTotalAmountMinor}
          hasMarketplaceFeeSnapshot={marketplaceFeeSnapshot !== null}
          currency={d.currency}
          lines={formattedLines}
          renterName={renterName}
          expiresAt={d.expiresAt ? d.expiresAt.toISOString() : null}
          locale={locale}
        />
      </main>
    </ClientShell>
  );
}
