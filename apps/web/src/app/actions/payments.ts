'use server';

import { and, eq } from 'drizzle-orm';
import { bookingDrafts, organizationPaymentAccounts } from '@uttily/database';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getStripeAdapter } from '@/lib/stripe';
import { loadFinancialTermsConfig, resolveStripeEnvironment } from '@/lib/payment-config';
import { initiatePayment, type InitiatePaymentResult } from '@uttily/core';

/**
 * Initie un paiement Stripe pour un brouillon de réservation.
 * Autorisation : l'utilisateur doit être le customer du brouillon.
 * organizationId et customerUserId viennent du contexte serveur, jamais du client.
 * Le clientSecret est retourné au client mais JAMAIS persisté.
 *
 * NOTE : cette action est appelée par la page de checkout côté client.
 * L'organizationId est résolu depuis le brouillon côté serveur, pas trusté.
 */
export async function initiatePaymentAction(input: {
  draftId: string;
  idempotencyKey: string;
  termsVersion: string;
}): Promise<InitiatePaymentResult> {
  const user = await getAuthenticatedUser();
  if (!user) {
    return {
      kind: 'FAILURE',
      statusCode: 401,
      error: 'UNAUTHENTICATED',
      message: 'Non authentifié.',
    };
  }
  const db = getDb();
  const environment = resolveStripeEnvironment();
  const provider = getStripeAdapter();

  // Résoudre l'organizationId depuis le brouillon côté serveur.
  // Le brouillon est lu HORS transaction — le use case initiatePayment
  // fera ses propres verrous.
  const draftRows = await db
    .select({
      organizationId: bookingDrafts.organizationId,
      customerUserId: bookingDrafts.customerUserId,
      totalAmountMinor: bookingDrafts.totalAmountMinor,
    })
    .from(bookingDrafts)
    .where(eq(bookingDrafts.id, input.draftId))
    .limit(1);
  const draft = draftRows[0];
  if (!draft) {
    return {
      kind: 'FAILURE',
      statusCode: 404,
      error: 'NOT_FOUND',
      message: 'Brouillon introuvable.',
    };
  }

  // Valider que l'utilisateur authentifié est le customer du brouillon.
  if (draft.customerUserId !== user.id) {
    return {
      kind: 'FAILURE',
      statusCode: 403,
      error: 'FORBIDDEN',
      message: 'Ce brouillon ne vous appartient pas.',
    };
  }

  // Récupérer le compte connecté Stripe de l'organisation pour cet environment.
  // resolveFinancialTerms exige un connectedAccount non null ; on l'enrichit
  // depuis la DB avant l'appel au use case.
  const accountRows = await db
    .select({
      providerAccountId: organizationPaymentAccounts.providerAccountId,
      chargesEnabled: organizationPaymentAccounts.chargesEnabled,
      transfersCapabilityStatus: organizationPaymentAccounts.transfersCapabilityStatus,
      settlementMerchantMode: organizationPaymentAccounts.settlementMerchantMode,
    })
    .from(organizationPaymentAccounts)
    .where(
      and(
        eq(organizationPaymentAccounts.organizationId, draft.organizationId),
        eq(organizationPaymentAccounts.environment, environment),
      ),
    )
    .limit(1);

  const account = accountRows[0];
  if (!account) {
    return {
      kind: 'FAILURE',
      statusCode: 409,
      error: 'FINANCIAL_TERMS_UNRESOLVED',
      message: 'Aucun compte de paiement configuré pour cette organisation.',
    };
  }

  const financialTermsConfig = loadFinancialTermsConfig(draft.totalAmountMinor);
  financialTermsConfig.connectedAccount = {
    accountId: account.providerAccountId,
    chargesEnabled: account.chargesEnabled,
    transfersCapabilityStatus: account.transfersCapabilityStatus,
    settlementMerchantMode: account.settlementMerchantMode,
    onBehalfOfAccountId: null,
  };

  return initiatePayment(
    { db, provider },
    {
      draftId: input.draftId,
      idempotencyKey: input.idempotencyKey,
      organizationId: draft.organizationId,
      customerUserId: user.id,
      environment,
      financialTermsConfig,
      termsAcceptance: {
        termsVersion: input.termsVersion,
        userId: user.id,
        acceptedAt: new Date().toISOString(),
      },
    },
  );
}
