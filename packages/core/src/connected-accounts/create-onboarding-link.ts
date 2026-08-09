/**
 * @uttily/core — Use case createOnboardingLink (Lot 5, ADR-010 §3.3, §16 étape 4).
 *
 * Génère un lien d'onboarding Stripe-hosted pour un compte connecté existant.
 *
 * Contraintes critiques (ADR-010 §1, §3.3) :
 * - Aucun appel provider à l'intérieur d'une transaction PostgreSQL. L'appel
 *   Stripe est HORS transaction ; la mise à jour DB est dans une transaction
 *   séparée.
 * - `organizationId` et `environment` proviennent du contexte serveur.
 * - Si le compte est déjà ENABLED, on lève une erreur VALIDATION (pas besoin de
 *   lien d'onboarding).
 * - Après génération du lien, `onboardingStatus` passe à 'SUBMITTED'.
 */

import { and, eq } from 'drizzle-orm';
import { organizationPaymentAccounts } from '@uttily/database';
import { PaymentProviderError } from '../payments/errors';
import type { OnboardingLinkResult } from '../payments/types';
import { ConnectedAccountError } from './errors';
import type {
  ConnectedAccountDependencies,
  CreateOnboardingLinkInput,
  CreateOnboardingLinkResult,
} from './types';

/** Valide le format canonique d'un UUID (8-4-4-4-12 hex). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateInput(input: CreateOnboardingLinkInput): void {
  if (!UUID_RE.test(input.organizationId)) {
    throw new ConnectedAccountError('VALIDATION', 'organizationId doit être un UUID valide.');
  }
  if (input.environment !== 'TEST' && input.environment !== 'LIVE') {
    throw new ConnectedAccountError(
      'VALIDATION',
      `Environnement invalide (reçu : ${input.environment}).`,
    );
  }
  if (typeof input.returnUrl !== 'string' || input.returnUrl.trim().length === 0) {
    throw new ConnectedAccountError('VALIDATION', 'returnUrl manquant ou vide.');
  }
  if (typeof input.refreshUrl !== 'string' || input.refreshUrl.trim().length === 0) {
    throw new ConnectedAccountError('VALIDATION', 'refreshUrl manquant ou vide.');
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim().length === 0) {
    throw new ConnectedAccountError('VALIDATION', "Clé d'idempotence manquante ou vide.");
  }
}

/**
 * Génère un lien d'onboarding Stripe-hosted pour un compte existant.
 *
 * Orchestration :
 * 1. Valider l'entrée.
 * 2. Lire le compte connecté depuis `organization_payment_accounts` par
 *    (organizationId, 'STRIPE', environment).
 * 3. Si non trouvé, lever `ACCOUNT_NOT_FOUND`.
 * 4. Si `onboardingStatus` = 'ENABLED', lever `VALIDATION` (onboarding déjà complété).
 * 5. Appeler `provider.createOnboardingLink(...)` HORS transaction.
 * 6. Mettre à jour `onboardingStatus` = 'SUBMITTED' dans une transaction.
 * 7. Retourner l'URL.
 */
export async function createOnboardingLink(
  deps: ConnectedAccountDependencies,
  input: CreateOnboardingLinkInput,
): Promise<CreateOnboardingLinkResult> {
  // 1. Valider l'entrée avant toute interaction.
  validateInput(input);

  const { db, provider } = deps;

  // 2. Lire le compte connecté.
  const rows = await db
    .select()
    .from(organizationPaymentAccounts)
    .where(
      and(
        eq(organizationPaymentAccounts.organizationId, input.organizationId),
        eq(organizationPaymentAccounts.provider, 'STRIPE'),
        eq(organizationPaymentAccounts.environment, input.environment),
      ),
    )
    .limit(1);

  // 3. Compte non trouvé.
  if (rows.length === 0) {
    throw new ConnectedAccountError(
      'ACCOUNT_NOT_FOUND',
      'Compte de paiement connecté introuvable pour cette organisation et cet environnement.',
      { statusCode: 404 },
    );
  }

  const account = rows[0]!;

  // 4. Onboarding déjà complété.
  if (account.onboardingStatus === 'ENABLED') {
    throw new ConnectedAccountError(
      'VALIDATION',
      "L'onboarding est déjà complété pour ce compte connecté.",
      { statusCode: 400 },
    );
  }

  // 5. Appel provider HORS transaction (ADR-010 §1).
  let link: OnboardingLinkResult;
  try {
    link = await provider.createOnboardingLink({
      accountId: account.providerAccountId,
      returnUrl: input.returnUrl,
      refreshUrl: input.refreshUrl,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    if (error instanceof PaymentProviderError) {
      throw new ConnectedAccountError(
        'PROVIDER_CALL_FAILED',
        `Échec de la création du lien d'onboarding : ${error.message}`,
        { statusCode: 502 },
      );
    }
    throw error;
  }

  // 6. Mettre à jour `onboardingStatus` = 'SUBMITTED' dans une transaction.
  try {
    await db
      .update(organizationPaymentAccounts)
      .set({ onboardingStatus: 'SUBMITTED', updatedAt: new Date() })
      .where(eq(organizationPaymentAccounts.id, account.id));
  } catch (error) {
    // La mise à jour DB a échoué après la création du lien Stripe : le lien
    // existe mais le statut local n'est pas mis à jour. C'est acceptable — le
    // webhook `account.updated` corrigera le statut. On logge un warning.
    console.warn(
      JSON.stringify({
        event: 'connected_account.onboarding_link.db_update_failed',
        organizationId: input.organizationId,
        environment: input.environment,
        providerAccountId: account.providerAccountId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw new ConnectedAccountError('UNKNOWN', "Échec de la mise à jour du statut d'onboarding.", {
      statusCode: 500,
    });
  }

  // 7. Retourner l'URL.
  return {
    url: link.url,
    expiresAt: link.expiresAt,
  };
}
