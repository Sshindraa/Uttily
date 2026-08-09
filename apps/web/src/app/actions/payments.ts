'use server';

import { eq } from 'drizzle-orm';
import { bookingDrafts } from '@uttily/database';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getStripeAdapter } from '@/lib/stripe';
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
  const environment = (process.env.STRIPE_ENVIRONMENT ?? 'TEST') as 'TEST' | 'LIVE';
  const provider = getStripeAdapter();

  // Résoudre l'organizationId depuis le brouillon côté serveur.
  // Le brouillon est lu HORS transaction — le use case initiatePayment
  // fera ses propres verrous.
  const draftRows = await db
    .select({
      organizationId: bookingDrafts.organizationId,
      customerUserId: bookingDrafts.customerUserId,
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

  const financialTermsConfig = loadFinancialTermsConfig();

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

/**
 * Charge la configuration financière depuis les variables d'environnement.
 * En l'absence de configuration réelle, retourne une config vide qui fera
 * répondre FINANCIAL_TERMS_UNRESOLVED par le résolveur.
 * En production LIVE, cette config sera chargée depuis une source sécurisée.
 */
function loadFinancialTermsConfig() {
  return {
    tax: null,
    commission: null,
    connectedAccount: null,
    legalTermsVersion: 'v1',
  };
}
