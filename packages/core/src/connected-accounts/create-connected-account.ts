/**
 * @uttily/core — Use case createConnectedAccount (Lot 5, ADR-010 §3.3, §16 étape 4).
 *
 * Crée un compte connecté Stripe ET l'enregistre localement dans
 * `organization_payment_accounts`.
 *
 * Contraintes critiques (ADR-010 §1, §3.2, §3.3) :
 * - Aucun appel provider à l'intérieur d'une transaction PostgreSQL. L'appel
 *   Stripe est HORS transaction ; l'insertion DB est dans une transaction
 *   séparée.
 * - `organizationId` et `environment` proviennent du contexte serveur.
 * - Si l'insertion DB échoue après la création Stripe, le compte Stripe existe
 *   mais n'est pas enregistré — c'est acceptable (le webhook `account.updated`
 *   le rattrapera, ou l'opérateur peut le récupérer manuellement). On logge un
 *   warning.
 * - `settlementMerchantMode` = 'PLATFORM' pour le MVP.
 * - `accountApiGeneration` = 'ACCOUNTS_V1_CONTROLLER_PROPERTIES'.
 * - `onboardingStatus` initial = 'PENDING'.
 * - `chargesEnabled` et `payoutsEnabled` = false initialement.
 * - `transfersCapabilityStatus` = 'PENDING' initialement.
 */

import { and, eq } from 'drizzle-orm';
import { organizationPaymentAccounts } from '@uttily/database';
import { validateControllerConfiguration } from '../payments/controller-config';
import { PaymentProviderError } from '../payments/errors';
import type { ConnectedAccountResult } from '../payments/types';
import { ConnectedAccountError } from './errors';
import {
  DEFAULT_CONTROLLER_CONFIG,
  type ConnectedAccountDependencies,
  type CreateConnectedAccountInput,
  type CreateConnectedAccountResult,
} from './types';

/** Valide le format canonique d'un UUID (8-4-4-4-12 hex). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateInput(input: CreateConnectedAccountInput): void {
  if (!UUID_RE.test(input.organizationId)) {
    throw new ConnectedAccountError('VALIDATION', 'organizationId doit être un UUID valide.');
  }
  if (input.environment !== 'TEST' && input.environment !== 'LIVE') {
    throw new ConnectedAccountError(
      'VALIDATION',
      `Environnement invalide (reçu : ${input.environment}).`,
    );
  }
  if (typeof input.country !== 'string' || input.country.trim().length === 0) {
    throw new ConnectedAccountError('VALIDATION', 'Pays manquant ou vide.');
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim().length === 0) {
    throw new ConnectedAccountError('VALIDATION', "Clé d'idempotence manquante ou vide.");
  }
}

/**
 * Crée un compte connecté Stripe et l'enregistre localement.
 *
 * Orchestration :
 * 1. Valider l'entrée.
 * 2. Vérifier qu'aucun compte n'existe déjà pour (organizationId, 'STRIPE', environment).
 * 3. Valider le controller config.
 * 4. Appeler `provider.createConnectedAccount(...)` HORS transaction.
 * 5. Insérer la ligne dans `organization_payment_accounts` dans une transaction.
 * 6. Retourner le résultat.
 */
export async function createConnectedAccount(
  deps: ConnectedAccountDependencies,
  input: CreateConnectedAccountInput,
): Promise<CreateConnectedAccountResult> {
  // 1. Valider l'entrée avant toute interaction.
  validateInput(input);

  const controller = input.controller ?? DEFAULT_CONTROLLER_CONFIG;

  // 2. Valider le controller config (matrice d'exclusion Stripe v1).
  try {
    validateControllerConfiguration(controller);
  } catch (error) {
    if (error instanceof PaymentProviderError) {
      throw new ConnectedAccountError('VALIDATION', error.message, { statusCode: 400 });
    }
    throw error;
  }

  const { db, provider } = deps;

  // 3. Vérifier qu'aucun compte n'existe déjà pour (organizationId, 'STRIPE', environment).
  const existing = await db
    .select({ id: organizationPaymentAccounts.id })
    .from(organizationPaymentAccounts)
    .where(
      and(
        eq(organizationPaymentAccounts.organizationId, input.organizationId),
        eq(organizationPaymentAccounts.provider, 'STRIPE'),
        eq(organizationPaymentAccounts.environment, input.environment),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    throw new ConnectedAccountError(
      'ACCOUNT_ALREADY_EXISTS',
      'Un compte de paiement existe déjà pour cette organisation et cet environnement.',
      { statusCode: 409 },
    );
  }

  // 4. Appel provider HORS transaction (ADR-010 §1).
  let account: ConnectedAccountResult;
  try {
    account = await provider.createConnectedAccount({
      organizationId: input.organizationId,
      environment: input.environment,
      country: input.country,
      controller,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    if (error instanceof PaymentProviderError) {
      throw new ConnectedAccountError(
        'PROVIDER_CALL_FAILED',
        `Échec de la création du compte connecté : ${error.message}`,
        { statusCode: 502 },
      );
    }
    throw error;
  }

  // 5. Insertion DB dans une transaction séparée (ADR-010 §1).
  let insertedId: string | null = null;
  try {
    const [row] = await db
      .insert(organizationPaymentAccounts)
      .values({
        organizationId: input.organizationId,
        provider: 'STRIPE',
        environment: input.environment,
        providerAccountId: account.id,
        accountApiGeneration: 'ACCOUNTS_V1_CONTROLLER_PROPERTIES',
        onboardingStatus: 'PENDING',
        chargesEnabled: false,
        payoutsEnabled: false,
        transfersCapabilityStatus: 'PENDING',
        settlementMerchantMode: 'PLATFORM',
        controllerConfigurationSnapshot: controller,
        requirementsSnapshot: account.requirements,
      })
      .returning({ id: organizationPaymentAccounts.id });
    insertedId = row?.id ?? null;
  } catch (error) {
    // L'insertion DB a échoué après la création Stripe : le compte Stripe existe
    // mais n'est pas enregistré. C'est acceptable — le webhook `account.updated`
    // le rattrapera si Stripe envoie un événement, ou l'opérateur peut le
    // récupérer manuellement. On logge un warning.
    console.warn(
      JSON.stringify({
        event: 'connected_account.create.db_insert_failed',
        organizationId: input.organizationId,
        environment: input.environment,
        providerAccountId: account.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw new ConnectedAccountError(
      'UNKNOWN',
      "Échec de l'enregistrement local du compte connecté.",
      { statusCode: 500 },
    );
  }

  if (insertedId === null) {
    throw new ConnectedAccountError(
      'UNKNOWN',
      "Échec de l'enregistrement local du compte connecté.",
      { statusCode: 500 },
    );
  }

  // 6. Retourner le résultat.
  return {
    organizationPaymentAccountId: insertedId,
    providerAccountId: account.id,
    onboardingStatus: 'PENDING',
    chargesEnabled: false,
    payoutsEnabled: false,
  };
}
