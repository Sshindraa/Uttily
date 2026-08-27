/**
 * @uttily/core — Use case createAccountSession (Lot 5 / Chantier 5).
 *
 * Crée une Account Session Stripe Connect Embedded pour afficher les composants
 * d'onboarding bancaire et de gestion financière directement dans Uttily.
 *
 * Contraintes critiques :
 * - Aucun appel provider à l'intérieur d'une transaction PostgreSQL.
 * - `organizationId` et `environment` proviennent du contexte serveur.
 */

import { and, eq } from 'drizzle-orm';
import { organizationPaymentAccounts } from '@uttily/database';
import { PaymentProviderError } from '../payments/errors';
import type { AccountSessionResult } from '../payments/types';
import { ConnectedAccountError } from './errors';
import type { ConnectedAccountDependencies, CreateAccountSessionInput } from './types';

/** Valide le format canonique d'un UUID (8-4-4-4-12 hex). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateInput(input: CreateAccountSessionInput): void {
  if (!UUID_RE.test(input.organizationId)) {
    throw new ConnectedAccountError('VALIDATION', 'organizationId doit être un UUID valide.');
  }
  if (input.environment !== 'TEST' && input.environment !== 'LIVE') {
    throw new ConnectedAccountError(
      'VALIDATION',
      `Environnement invalide (reçu : ${input.environment}).`,
    );
  }
}

/**
 * Crée une Account Session Stripe Connect Embedded pour un compte connecté existant.
 */
export async function createAccountSession(
  deps: ConnectedAccountDependencies,
  input: CreateAccountSessionInput,
): Promise<AccountSessionResult> {
  // 1. Valider l'entrée.
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

  // 4. Appel provider HORS transaction.
  try {
    return await provider.createAccountSession({
      accountId: account.providerAccountId,
    });
  } catch (error) {
    if (error instanceof PaymentProviderError) {
      throw new ConnectedAccountError(
        'PROVIDER_CALL_FAILED',
        `Échec de la création de l'Account Session : ${error.message}`,
        { statusCode: 502 },
      );
    }
    throw error;
  }
}
