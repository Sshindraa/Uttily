/**
 * @uttily/core — Validation d'autorité webhook partagée (Lot 5, ADR-010 §10 étape 6).
 *
 * Extrait les validations webhook vs données locales (montant, devise,
 * PaymentIntent ID, organisation, destination, commission, on_behalf_of,
 * environnement) dans une fonction réutilisable par tous les handlers
 * (confirmBooking, handlePaymentFailed, handleCanceled, handleProcessing).
 *
 * Les lignes payment et attempt doivent déjà être verrouillées (FOR UPDATE)
 * par l'appelant avant d'appeler cette fonction.
 */

import { and, eq } from 'drizzle-orm';
import { organizationPaymentAccounts, type DatabaseTransaction } from '@uttily/database';
import type { PaymentIntentEventData, ResolvedAttempt } from './types';
import { WebhookHandlerError } from './errors';
import { parseMarketplaceFeeSnapshot } from '../marketplace-fees';

/** Type local pour les lignes payment/attempt verrouillées par l'appelant. */
interface AuthorityRows {
  payment: {
    id: string;
    organizationId: string;
    draftId: string;
    amountMinor: number;
    currency: string;
    connectedAccountId: string;
    commissionAmountMinor: number;
    marketplaceFeeSnapshot?: unknown;
    onBehalfOfAccountId: string | null;
    status: string;
  };
  attempt: {
    id: string;
    organizationId: string;
    paymentId: string;
    providerPaymentIntentId: string | null;
    status: string;
  };
}

/**
 * Valide l'autorité et la cohérence d'un webhook vs les données locales.
 *
 * Vérifications (ADR-010 §10 étape 6) :
 * - Cohérence bidirectionnelle payment ↔ attempt (draftId, organizationId, paymentId).
 * - Montant : piData.amount === payment.amountMinor.
 * - Devise : piData.currency.toUpperCase() === payment.currency.
 * - PaymentIntent ID : attempt.providerPaymentIntentId === piData.id (si non null).
 * - Organisation : piData.metadata.organization_id === orgId (obligatoire).
 * - Destination : piData.destination === payment.connectedAccountId.
 * - Commission : piData.applicationFeeAmount cohérent avec payment.commissionAmountMinor.
 * - on_behalf_of : piData.onBehalfOfAccountId cohérent avec payment.onBehalfOfAccountId.
 * - Environnement : organization_payment_accounts existe pour connectedAccountId + environment.
 *
 * @param tx Transaction active.
 * @param attempt Tentative résolue.
 * @param piData Données du PaymentIntent extraites du webhook.
 * @param rows Lignes payment et attempt déjà verrouillées par l'appelant.
 * @param environment Environnement Stripe (TEST/LIVE).
 * @throws WebhookHandlerError si une validation échoue.
 */
export async function validateWebhookAuthority(
  tx: DatabaseTransaction,
  attempt: ResolvedAttempt,
  piData: PaymentIntentEventData,
  rows: AuthorityRows,
  environment: 'TEST' | 'LIVE',
): Promise<void> {
  const orgId = attempt.organizationId;
  const { payment, attempt: attemptRow } = rows;

  // ── Cohérence bidirectionnelle payment ↔ attempt ──────────────────────────

  // Le payment est lié au bon draft (la tentative n'a pas de draftId direct,
  // mais le payment en a un — on vérifie via le resolved attempt).
  if (payment.draftId !== attempt.draftId) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      `Le paiement (${payment.id}) est lié au draft ${payment.draftId} mais la tentative résolue référence le draft ${attempt.draftId}.`,
      { statusCode: 500 },
    );
  }

  // Le payment et la tentative appartiennent à la même organisation.
  if (payment.organizationId !== attemptRow.organizationId) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      `L'organisation du paiement (${payment.organizationId}) ne correspond pas à celle de la tentative (${attemptRow.organizationId}).`,
      { statusCode: 500 },
    );
  }

  // La tentative est liée au bon payment.
  if (attemptRow.paymentId !== payment.id) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      `La tentative (${attemptRow.id}) référence le payment ${attemptRow.paymentId} mais le payment verrouillé est ${payment.id}.`,
      { statusCode: 500 },
    );
  }

  // L'organisation de la tentative correspond à celle résolue.
  if (attemptRow.organizationId !== orgId) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      `L'organisation de la tentative (${attemptRow.organizationId}) ne correspond pas à l'organisation résolue (${orgId}).`,
      { statusCode: 500 },
    );
  }

  // ── Vérifications webhook vs données locales ──────────────────────────────

  // Montant : piData.amount (centimes) == payment.amountMinor.
  if (piData.amount !== payment.amountMinor) {
    throw new WebhookHandlerError(
      'WEBHOOK_AMOUNT_MISMATCH',
      `Le montant du PaymentIntent (${piData.amount}) ne correspond pas au paiement local (${payment.amountMinor}).`,
      { statusCode: 500 },
    );
  }

  // Devise : piData.currency (lowercase depuis Stripe) == payment.currency (uppercase).
  if (piData.currency.toUpperCase() !== payment.currency) {
    throw new WebhookHandlerError(
      'WEBHOOK_CURRENCY_MISMATCH',
      `La devise du PaymentIntent (${piData.currency}) ne correspond pas au paiement local (${payment.currency}).`,
      { statusCode: 500 },
    );
  }

  // PaymentIntent ID : si la tentative a déjà un provider_payment_intent_id, doit correspondre.
  if (
    attemptRow.providerPaymentIntentId !== null &&
    attemptRow.providerPaymentIntentId !== piData.id
  ) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      `L'ID du PaymentIntent du webhook (${piData.id}) ne correspond pas à la tentative (${attemptRow.providerPaymentIntentId}).`,
      { statusCode: 500 },
    );
  }

  // P1-1 : Les 5 champs metadata sont OBLIGATOIRES (pas seulement « si présents »).
  // Un PaymentIntent sans payment_id, payment_attempt_id, draft_id, organization_id
  // ou protocol_version est rejeté (WEBHOOK_AGGREGATE_INCONSISTENT si absent).

  // organization_id : obligatoire. Vérifier la présence, puis la correspondance.
  if (!piData.metadata?.organization_id) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      'Le metadata organization_id est absent du PaymentIntent (champ obligatoire).',
      { statusCode: 500 },
    );
  }
  if (piData.metadata.organization_id !== orgId) {
    throw new WebhookHandlerError(
      'WEBHOOK_ORGANIZATION_MISMATCH',
      "L'organisation des metadata du PaymentIntent ne correspond pas à la tentative.",
      { statusCode: 403 },
    );
  }

  // payment_id : obligatoire. Vérifier la présence, puis la correspondance.
  if (!piData.metadata?.payment_id) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      'Le metadata payment_id est absent du PaymentIntent (champ obligatoire).',
      { statusCode: 500 },
    );
  }
  if (piData.metadata.payment_id !== payment.id) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      `Le payment_id des metadata (${piData.metadata.payment_id}) ne correspond pas au paiement local (${payment.id}).`,
      { statusCode: 500 },
    );
  }

  // payment_attempt_id : obligatoire. Vérifier la présence, puis la correspondance.
  if (!piData.metadata?.payment_attempt_id) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      'Le metadata payment_attempt_id est absent du PaymentIntent (champ obligatoire).',
      { statusCode: 500 },
    );
  }
  if (piData.metadata.payment_attempt_id !== attemptRow.id) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      `Le payment_attempt_id des metadata (${piData.metadata.payment_attempt_id}) ne correspond pas à la tentative locale (${attemptRow.id}).`,
      { statusCode: 500 },
    );
  }

  // draft_id : obligatoire. Vérifier la présence, puis la correspondance.
  if (!piData.metadata?.draft_id) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      'Le metadata draft_id est absent du PaymentIntent (champ obligatoire).',
      { statusCode: 500 },
    );
  }
  if (piData.metadata.draft_id !== payment.draftId) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      `Le draft_id des metadata (${piData.metadata.draft_id}) ne correspond pas au brouillon du paiement (${payment.draftId}).`,
      { statusCode: 500 },
    );
  }

  // protocol_version : obligatoire. Vérifier la présence, puis la valeur 'v1'.
  if (!piData.metadata?.protocol_version) {
    throw new WebhookHandlerError(
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      'Le metadata protocol_version est absent du PaymentIntent (champ obligatoire).',
      { statusCode: 500 },
    );
  }
  if (piData.metadata.protocol_version !== 'v1') {
    throw new WebhookHandlerError(
      'WEBHOOK_INVARIANT_BROKEN',
      `Le protocol_version des metadata (${piData.metadata.protocol_version}) n'est pas supporté (attendu : v1).`,
      { statusCode: 500 },
    );
  }

  // Destination : piData.destination (transfer_data.destination) doit être non null
  // et correspondre au connectedAccountId du paiement.
  if (piData.destination === undefined || piData.destination === null) {
    throw new WebhookHandlerError(
      'WEBHOOK_DESTINATION_MISMATCH',
      "Le PaymentIntent n'a pas de transfer_data.destination (destination charge invalide).",
      { statusCode: 500 },
    );
  }
  if (piData.destination !== payment.connectedAccountId) {
    throw new WebhookHandlerError(
      'WEBHOOK_DESTINATION_MISMATCH',
      `La destination du PaymentIntent (${piData.destination}) ne correspond pas au compte connecté du paiement (${payment.connectedAccountId}).`,
      { statusCode: 500 },
    );
  }

  // Pour split, application_fee est la somme des deux composants. La colonne
  // commissionAmountMinor reste uniquement la projection merchant legacy.
  let expectedFeeAmountMinor = payment.commissionAmountMinor;
  if (payment.marketplaceFeeSnapshot !== null && payment.marketplaceFeeSnapshot !== undefined) {
    try {
      const snapshot = parseMarketplaceFeeSnapshot(payment.marketplaceFeeSnapshot);
      if (snapshot.customerTotalAmountMinor !== payment.amountMinor) {
        throw new Error('customerTotalAmountMinor ne correspond pas au montant du payment');
      }
      expectedFeeAmountMinor = snapshot.platformApplicationFeeAmountMinor;
    } catch (error) {
      throw new WebhookHandlerError(
        'WEBHOOK_INVARIANT_BROKEN',
        `Snapshot marketplace invalide : ${error instanceof Error ? error.message : 'erreur inconnue'}`,
        { statusCode: 500 },
      );
    }
  }
  const expectedFee = expectedFeeAmountMinor === 0 ? null : expectedFeeAmountMinor;
  if (
    piData.applicationFeeAmount !== expectedFee &&
    !(expectedFee === null && piData.applicationFeeAmount === 0)
  ) {
    throw new WebhookHandlerError(
      'WEBHOOK_INVARIANT_BROKEN',
      `L'application fee du PaymentIntent (${piData.applicationFeeAmount}) ne correspond pas au snapshot financier local (${expectedFeeAmountMinor}).`,
      { statusCode: 500 },
    );
  }

  // on_behalf_of : si le paiement a un onBehalfOfAccountId, le webhook doit correspondre.
  // Si le paiement n'en a pas, le webhook doit être null/undefined.
  if (payment.onBehalfOfAccountId !== null) {
    if (piData.onBehalfOfAccountId !== payment.onBehalfOfAccountId) {
      throw new WebhookHandlerError(
        'WEBHOOK_INVARIANT_BROKEN',
        `Le on_behalf_of du PaymentIntent (${piData.onBehalfOfAccountId}) ne correspond pas au paiement local (${payment.onBehalfOfAccountId}).`,
        { statusCode: 500 },
      );
    }
  } else {
    if (piData.onBehalfOfAccountId !== null && piData.onBehalfOfAccountId !== undefined) {
      throw new WebhookHandlerError(
        'WEBHOOK_INVARIANT_BROKEN',
        `Le on_behalf_of du PaymentIntent (${piData.onBehalfOfAccountId}) est non null alors que le paiement local n'en a pas.`,
        { statusCode: 500 },
      );
    }
  }

  // ── Cohérence terminale payment ↔ attempt ─────────────────────────────────
  // P1-3 : détecter toute asymétrie terminal/non-terminal et toute incohérence
  // terminale. Si un est terminal et l'autre non, l'agrégat est dans un état
  // impossible. Si les deux sont terminaux, leurs statuts doivent être cohérents.
  const TERMINAL_PAYMENT_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
  const TERMINAL_ATTEMPT_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

  const paymentTerminal = TERMINAL_PAYMENT_STATUSES.has(payment.status);
  const attemptTerminal = TERMINAL_ATTEMPT_STATUSES.has(attemptRow.status);

  // Asymétrie terminal/non-terminal : invariant brisé.
  if (paymentTerminal !== attemptTerminal) {
    throw new WebhookHandlerError(
      'WEBHOOK_INVARIANT_BROKEN',
      `Asymétrie terminale : payment=${payment.status} (${paymentTerminal ? 'terminal' : 'non-terminal'}) mais attempt=${attemptRow.status} (${attemptTerminal ? 'terminal' : 'non-terminal'}). L'agrégat est dans un état impossible.`,
      { statusCode: 500 },
    );
  }

  // Les deux sont terminaux : leurs statuts doivent être cohérents.
  if (paymentTerminal && attemptTerminal && payment.status !== attemptRow.status) {
    throw new WebhookHandlerError(
      'WEBHOOK_INVARIANT_BROKEN',
      `Incohérence terminale : payment=${payment.status} mais attempt=${attemptRow.status}. L'agrégat est dans un état impossible.`,
      { statusCode: 500 },
    );
  }

  // Environnement : vérifier via organization_payment_accounts que le compte connecté
  // du paiement existe pour l'environnement du contexte.
  const accountRows = await tx
    .select({ id: organizationPaymentAccounts.id })
    .from(organizationPaymentAccounts)
    .where(
      and(
        eq(organizationPaymentAccounts.providerAccountId, payment.connectedAccountId),
        eq(organizationPaymentAccounts.environment, environment),
        eq(organizationPaymentAccounts.provider, 'STRIPE'),
      ),
    )
    .limit(1);

  if (accountRows.length === 0) {
    throw new WebhookHandlerError(
      'WEBHOOK_ENVIRONMENT_MISMATCH',
      `Le compte connecté ${payment.connectedAccountId} n'existe pas pour l'environnement ${environment}.`,
      { statusCode: 500 },
    );
  }
}
