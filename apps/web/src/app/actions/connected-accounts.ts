'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getStripeAdapter } from '@/lib/stripe';
import { resolveStripeEnvironment } from '@/lib/payment-config';
import {
  createConnectedAccount,
  createOnboardingLink,
  getConnectedAccountReadiness,
  getMembership,
  requireMembership,
  ROLE_MANAGERS,
  type CreateConnectedAccountInput,
  type CreateOnboardingLinkInput,
} from '@uttily/core';

/**
 * Retourne l'état de readiness du compte connecté Stripe pour l'organisation.
 * Autorisation : MANAGER+ (OWNER, ADMIN).
 */
export async function getConnectedAccountReadinessAction(organizationId: string) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireMembership(membership, ROLE_MANAGERS);
  const environment = resolveStripeEnvironment();
  return getConnectedAccountReadiness({ db }, organizationId, environment);
}

/**
 * Crée un compte connecté Stripe pour l'organisation.
 * Autorisation : MANAGER+ uniquement.
 * organizationId vient du contexte serveur (membership), jamais du client.
 */
export async function createConnectedAccountAction(
  organizationId: string,
  input: { country: string; idempotencyKey: string },
) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireMembership(membership, ROLE_MANAGERS);
  const environment = resolveStripeEnvironment();
  // P3 : Valider le country code contre une allow-list configurable.
  // La validation côté client (SUPPORTED_COUNTRIES dans payments-settings-client.tsx)
  // est contournable ; on valide aussi côté serveur.
  const supportedCountriesRaw = process.env.SUPPORTED_STRIPE_COUNTRIES ?? '';
  const supportedCountries = supportedCountriesRaw
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c.length > 0);
  if (supportedCountries.length > 0 && !supportedCountries.includes(input.country.toUpperCase())) {
    throw new Error(
      `Pays non supporté : "${input.country}". Pays supportés : ${supportedCountries.join(', ')}.`,
    );
  }
  const provider = getStripeAdapter();
  const result = await createConnectedAccount({ db, provider }, {
    organizationId,
    environment,
    country: input.country,
    idempotencyKey: input.idempotencyKey,
  } satisfies CreateConnectedAccountInput);
  revalidatePath(`/dashboard/${organizationId}/settings/payments`);
  return result;
}

/**
 * Génère un lien d'onboarding Stripe-hosted pour le compte connecté.
 * Autorisation : MANAGER+ uniquement.
 * Les URLs returnUrl et refreshUrl sont construites côté serveur à partir de
 * l'origin de la requête, jamais trustées depuis le client.
 */
export async function createOnboardingLinkAction(
  organizationId: string,
  input: { idempotencyKey: string; origin: string },
) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireMembership(membership, ROLE_MANAGERS);
  const environment = resolveStripeEnvironment();

  // Construire les URLs côté serveur — jamais trustées depuis le client.
  // P2 : Valider l'origin contre une allow-list pour éviter qu'un client malveillant
  // ne redirige vers un domaine contrôlé (phishing). On accepte :
  // - l'origin passée par le client SI elle correspond au host de la requête
  //   (via headers().get('host')) ou à une allow-list explicite.
  const allowedOriginsRaw = process.env.ALLOWED_ORIGINS ?? '';
  const allowedOrigins = allowedOriginsRaw
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter((o) => o.length > 0);
  const requestHost = (await headers()).get('host');
  const candidateOrigin = input.origin.replace(/\/$/, '');
  // Construire l'origin attendue depuis le host de la requête.
  const expectedOrigin = requestHost
    ? `${requestHost.startsWith('localhost') ? 'http' : 'https'}://${requestHost}`
    : null;

  const isAllowed =
    (expectedOrigin !== null && candidateOrigin === expectedOrigin) ||
    allowedOrigins.includes(candidateOrigin);
  if (!isAllowed) {
    throw new Error(
      "Origin non autorisée pour la génération du lien d'onboarding. " +
        "Configurez ALLOWED_ORIGINS ou vérifiez que l'origin correspond au host de la requête.",
    );
  }
  const baseUrl = candidateOrigin;
  const returnUrl = `${baseUrl}/dashboard/${organizationId}/settings/payments?onboarding=complete`;
  const refreshUrl = `${baseUrl}/dashboard/${organizationId}/settings/payments?onboarding=refresh`;

  const provider = getStripeAdapter();
  const result = await createOnboardingLink({ db, provider }, {
    organizationId,
    environment,
    returnUrl,
    refreshUrl,
    idempotencyKey: input.idempotencyKey,
  } satisfies CreateOnboardingLinkInput);
  revalidatePath(`/dashboard/${organizationId}/settings/payments`);
  return result;
}
