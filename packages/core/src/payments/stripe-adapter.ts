/**
 * @uttily/core — Adapter Stripe réel (Lot 5, ADR-010 §3, §5, §14).
 *
 * SEUL fichier du domaine qui importe le SDK Stripe. Implémente
 * PaymentProviderAdapter. La configuration est injectée ; aucune clé secrète
 * n'est codée en dur. L'API version est épinglée explicitement.
 *
 * Aucune méthode ne doit être appelée pendant une transaction PostgreSQL ou
 * sous un verrou FOR UPDATE (ADR-010 §1, §8). Le client_secret n'est jamais
 * loggé ni persisté — il n'apparaît que dans la valeur de retour.
 */

import Stripe from 'stripe';
import { PaymentProviderError } from './errors';
import { validateControllerConfiguration } from './controller-config';
import type {
  AccountCapabilities,
  AccountApiGeneration,
  CancelPaymentIntentParams,
  ConnectedAccountControllerConfig,
  ConnectedAccountResult,
  CreateConnectedAccountParams,
  CreateOnboardingLinkParams,
  CreatePaymentIntentParams,
  CreateRefundParams,
  OnboardingLinkResult,
  PaymentIntentResult,
  PaymentIntentStatus,
  PaymentMetadata,
  PaymentProviderAdapter,
  RefundMetadata,
  RefundResult,
  RefundStatus,
  StripeErrorCode,
  StripeEnvironment,
  TransfersCapabilityStatus,
  VerifiedWebhookEvent,
  VerifyWebhookParams,
  WebhookEndpoint,
  WebhookVerification,
} from './types';

/**
 * Version d'API Stripe épinglée pour stripe@22.3.2.
 * Toute évolution nécessite une décision documentée et un test de régression.
 */
export const PINNED_STRIPE_API_VERSION = '2026-06-24.dahlia' as const;

/** Tolérance de timestamp webhook en secondes (ADR-010 §14). Non nulle. */
const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Extrait un identifiant de chaîne depuis une valeur Stripe qui peut être
 * soit un ID (string) soit un objet expansé (Account, etc.).
 */
function extractId(value: string | { id: string } | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  return value.id;
}

/**
 * Configuration injectable de l'adapter Stripe.
 * Les secrets sont passés via config, jamais codés en dur.
 */
export interface StripeAdapterConfig {
  /** Clé secrète (sk_test_... ou sk_live_...). JAMAIS loggée ou exposée. */
  secretKey: string;
  /** Secret webhook pour l'endpoint plateforme. */
  platformWebhookSecret: string;
  /** Secret webhook pour l'endpoint Connect. */
  connectWebhookSecret: string;
  /** Environnement (TEST ou LIVE). */
  environment: StripeEnvironment;
  /** Version d'API (épinglée). */
  apiVersion: '2026-06-24.dahlia';
}

/**
 * Mappe le statut PaymentIntent de Stripe vers notre union fermée.
 * Les statuts Stripe non gérés (requires_capture, requires_confirmation)
 * ne sont pas exposés au MVP (capture automatique uniquement).
 */
function mapPaymentIntentStatus(stripeStatus: string): PaymentIntentStatus {
  switch (stripeStatus) {
    case 'requires_payment_method':
      return 'requires_payment_method';
    case 'requires_action':
      return 'requires_action';
    case 'processing':
      return 'processing';
    case 'succeeded':
      return 'succeeded';
    case 'canceled':
      return 'canceled';
    default:
      throw new PaymentProviderError(
        'UNSUPPORTED_PROVIDER_STATE',
        'État fournisseur non supporté',
        'unsupported_state',
      );
  }
}

/**
 * Mappe le statut de refund de Stripe vers notre union fermée.
 */
function mapRefundStatus(stripeStatus: string): RefundStatus {
  switch (stripeStatus) {
    case 'pending':
      return 'pending';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'requires_action':
      return 'requires_action';
    case 'canceled':
      return 'canceled';
    default:
      throw new PaymentProviderError(
        'UNSUPPORTED_PROVIDER_STATE',
        'État fournisseur non supporté',
        'unsupported_state',
      );
  }
}

/**
 * Mappe le statut de capacité de transfert de Stripe vers notre union fermée.
 * Stripe utilise 'active' | 'inactive' | 'pending'.
 * L'absence de la capability est mappée vers 'UNREQUESTED'.
 */
function mapTransfersCapability(
  capabilities: Stripe.Account.Capabilities | undefined,
): TransfersCapabilityStatus {
  const transfers = capabilities?.transfers;
  if (transfers === undefined) {
    return 'UNREQUESTED';
  }
  switch (transfers) {
    case 'active':
      return 'ACTIVE';
    case 'inactive':
      return 'INACTIVE';
    case 'pending':
      return 'PENDING';
    default:
      return 'UNREQUESTED';
  }
}

/**
 * Détermine le statut d'onboarding depuis le compte Stripe.
 */
function deriveOnboardingStatus(account: Stripe.Account): string {
  if (account.details_submitted && account.charges_enabled && account.payouts_enabled) {
    return 'COMPLETE';
  }
  if (account.details_submitted) {
    return 'DETAILS_SUBMITTED';
  }
  return 'PENDING';
}

/**
 * Projette un compte Stripe vers ConnectedAccountResult.
 * On utilise toujours l'API v1 (ACCOUNTS_V1_CONTROLLER_PROPERTIES).
 */
function mapConnectedAccount(account: Stripe.Account): ConnectedAccountResult {
  return {
    id: account.id,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    transfersCapabilityStatus: mapTransfersCapability(account.capabilities),
    onboardingStatus: deriveOnboardingStatus(account),
    requirements: (account.requirements ?? {}) as Record<string, unknown>,
    controllerConfiguration: (account.controller ?? {}) as Record<string, unknown>,
    apiGeneration: 'ACCOUNTS_V1_CONTROLLER_PROPERTIES' as AccountApiGeneration,
  };
}

/**
 * Mappe la configuration du controller locale (sémantique provider-agnostic)
 * vers les valeurs attendues par l'API v1 de Stripe.
 * PLATFORM → 'application', CONNECTED_ACCOUNT → 'account', STRIPE → 'stripe'.
 */
function mapControllerConfigToV1(
  controller: ConnectedAccountControllerConfig,
): Stripe.AccountCreateParams.Controller {
  return {
    fees: {
      payer: controller.feesPayer === 'PLATFORM' ? 'application' : 'account',
    },
    losses: {
      payments: controller.lossesCollector === 'PLATFORM' ? 'application' : 'stripe',
    },
    stripe_dashboard: {
      type:
        controller.stripeDashboard === 'NONE'
          ? 'none'
          : controller.stripeDashboard === 'EXPRESS'
            ? 'express'
            : 'full',
    },
    requirement_collection:
      controller.requirementCollection === 'PLATFORM' ? 'application' : 'stripe',
  };
}

/**
 * Mappe une erreur Stripe vers PaymentProviderError avec un code fermé.
 * Ne divulgue jamais les détails internes de Stripe (carte, client_secret, etc.).
 */
function mapStripeError(error: unknown): PaymentProviderError {
  // Si c'est déjà une PaymentProviderError (ex: UNSUPPORTED_PROVIDER_STATE),
  // la propager telle quelle sans la re-mapper.
  if (error instanceof PaymentProviderError) {
    return error;
  }
  if (error instanceof Stripe.errors.StripeError) {
    const stripeError = error as Stripe.errors.StripeError;

    // Carte refusée → VALIDATION avec code fermé card_declined.
    if (stripeError instanceof Stripe.errors.StripeCardError) {
      const providerCode: StripeErrorCode =
        stripeError.code === 'card_declined' ? 'card_declined' : 'unknown';
      return new PaymentProviderError(
        'VALIDATION',
        'Paiement refusé par le fournisseur',
        providerCode,
      );
    }

    // Rate limit → UNKNOWN (transitoire).
    if (stripeError instanceof Stripe.errors.StripeRateLimitError) {
      return new PaymentProviderError(
        'UNKNOWN',
        'Limite de débit du fournisseur atteinte',
        'rate_limit' as StripeErrorCode,
      );
    }

    // Authentification → UNAUTHENTICATED.
    if (stripeError instanceof Stripe.errors.StripeAuthenticationError) {
      return new PaymentProviderError(
        'UNAUTHENTICATED',
        'Authentification fournisseur échouée',
        'authentication_error' as StripeErrorCode,
      );
    }

    // Requête invalide → VALIDATION.
    if (stripeError instanceof Stripe.errors.StripeInvalidRequestError) {
      const providerCode: StripeErrorCode =
        stripeError.code === 'resource_missing' ? 'resource_missing' : 'invalid_request_error';
      return new PaymentProviderError('VALIDATION', 'Requête fournisseur invalide', providerCode);
    }

    // Connexion → UNKNOWN (transitoire).
    if (stripeError instanceof Stripe.errors.StripeConnectionError) {
      return new PaymentProviderError(
        'UNKNOWN',
        'Connexion au fournisseur échouée',
        'api_connection_error' as StripeErrorCode,
      );
    }

    // Permission → FORBIDDEN.
    if (stripeError instanceof Stripe.errors.StripePermissionError) {
      return new PaymentProviderError(
        'FORBIDDEN',
        'Permission refusée par le fournisseur',
        'permission_error' as StripeErrorCode,
      );
    }

    // Idempotence → CONFLICT_IDEMPOTENCY.
    if (stripeError instanceof Stripe.errors.StripeIdempotencyError) {
      return new PaymentProviderError(
        'CONFLICT_IDEMPOTENCY',
        "Conflit d'idempotence fournisseur",
        'idempotency_error' as StripeErrorCode,
      );
    }

    // Erreur API générique → UNKNOWN.
    if (stripeError instanceof Stripe.errors.StripeAPIError) {
      return new PaymentProviderError(
        'UNKNOWN',
        'Erreur API du fournisseur',
        'api_error' as StripeErrorCode,
      );
    }

    // Par défaut → UNKNOWN.
    return new PaymentProviderError(
      'UNKNOWN',
      'Erreur fournisseur inattendue',
      'unknown' as StripeErrorCode,
    );
  }

  // Erreur non-Stripe (réseau, programmation, etc.) → UNKNOWN.
  if (error instanceof Error) {
    return new PaymentProviderError('UNKNOWN', 'Erreur inattendue', null);
  }
  return new PaymentProviderError('UNKNOWN', 'Erreur inattendue', null);
}

/**
 * Extrait l'objectId depuis les données d'un événement Stripe.
 */
function extractObjectId(event: Stripe.Event): string {
  const obj = event.data.object as { id?: unknown };
  if (typeof obj?.id === 'string') {
    return obj.id;
  }
  return '';
}

/**
 * Normalise les données d'un événement Stripe vers une allow-list de champs.
 * Le corps brut et les données de carte ne sont jamais persistés (ADR-010 §14).
 */
function normalizeEventData(event: Stripe.Event): Record<string, unknown> {
  const obj = event.data.object as unknown as Record<string, unknown>;
  const isRefundEvent = event.type.startsWith('refund.');
  // Allow-list : on ne conserve que les champs non sensibles et utiles.
  const allowed: Record<string, unknown> = {};
  if (typeof obj?.id === 'string') {
    allowed.id = obj.id;
  }
  if (typeof obj?.object === 'string') {
    allowed.object = obj.object;
  }
  if (typeof obj?.status === 'string') {
    allowed.status = obj.status;
  }
  if (typeof obj?.amount === 'number') {
    allowed.amount = obj.amount;
  }
  if (typeof obj?.currency === 'string') {
    allowed.currency = obj.currency;
  }
  if (obj?.metadata !== undefined && typeof obj.metadata === 'object') {
    const rawMetadata = obj.metadata as Record<string, unknown>;
    const filteredMetadata: Record<string, string> = {};
    const allowedKeys: (keyof PaymentMetadata | keyof RefundMetadata)[] = isRefundEvent
      ? ['refund_id', 'organization_id', 'protocol_version']
      : ['payment_id', 'payment_attempt_id', 'draft_id', 'organization_id', 'protocol_version'];
    for (const key of allowedKeys) {
      if (typeof rawMetadata[key] === 'string') {
        filteredMetadata[key] = rawMetadata[key] as string;
      }
    }
    allowed.metadata = filteredMetadata;
  }
  // transfer_data.destination (connected account ID) — nécessaire pour le recoupement.
  const transferData = obj?.transfer_data as Record<string, unknown> | undefined;
  if (transferData !== null && typeof transferData === 'object') {
    const dest = transferData.destination;
    if (typeof dest === 'string') {
      allowed.transfer_data = { destination: dest };
    }
  }
  // application_fee_amount (commission) — nécessaire pour le recoupement.
  if (obj?.application_fee_amount === null || typeof obj?.application_fee_amount === 'number') {
    allowed.application_fee_amount = obj.application_fee_amount;
  }
  // on_behalf_of (compte connecté) — nécessaire pour le recoupement.
  if (obj?.on_behalf_of === null || typeof obj?.on_behalf_of === 'string') {
    allowed.on_behalf_of = obj.on_behalf_of;
  }
  // payment_intent (pour les événements charge.refunded / refund.*).
  if (typeof obj?.payment_intent === 'string') {
    allowed.payment_intent = obj.payment_intent;
  }
  // refunds (pour charge.refunded — ApiList<Refund> avec data = Refund[]).
  // P2-2 : Ne copier que les champs métier nécessaires de chaque refund.
  // P1-3 : Ne pas filtrer les éléments non-objets — la validation se fait dans
  // le savepoint de projectRefundStatus pour garantir l'atomicité « tout ou
  // rien ». Un élément non-objet déclenchera REFUND_OBJECT_INVALID.
  if (obj?.refunds !== undefined && typeof obj?.refunds === 'object' && obj.refunds !== null) {
    const refundsList = obj.refunds as Record<string, unknown>;
    const rawData = refundsList.data;
    if (Array.isArray(rawData)) {
      const filteredData = rawData.map((r) => {
        if (r === null || typeof r !== 'object') {
          return r; // Garder tels quels — validés dans le savepoint (P1-3)
        }
        const refund = r as Record<string, unknown>;
        return {
          id: refund.id,
          status: refund.status,
          amount: refund.amount,
          payment_intent: refund.payment_intent,
          currency: refund.currency,
          metadata: normalizeRefundMetadata(refund.metadata),
        };
      });
      allowed.refunds = { object: 'list', data: filteredData };
    }
  }
  // Champs account.updated (projection organization_payment_accounts).
  if (typeof obj?.charges_enabled === 'boolean') {
    allowed.charges_enabled = obj.charges_enabled;
  }
  if (typeof obj?.payouts_enabled === 'boolean') {
    allowed.payouts_enabled = obj.payouts_enabled;
  }
  // capabilities (objet avec transfers, card_payments, etc.) — P1-6.
  // P2-2 : Ne copier que le champ transfers.
  if (obj?.capabilities !== undefined && typeof obj?.capabilities === 'object') {
    const rawCapabilities = obj.capabilities as Record<string, unknown>;
    const filteredCapabilities: Record<string, unknown> = {};
    if (typeof rawCapabilities.transfers === 'string') {
      filteredCapabilities.transfers = rawCapabilities.transfers;
    }
    if (Object.keys(filteredCapabilities).length > 0) {
      allowed.capabilities = filteredCapabilities;
    }
  }
  // P2-2 : requirements — ne copier que currently_due et past_due.
  if (obj?.requirements !== undefined && typeof obj?.requirements === 'object') {
    const rawRequirements = obj.requirements as Record<string, unknown>;
    const filteredRequirements: Record<string, unknown> = {};
    if (Array.isArray(rawRequirements.currently_due)) {
      filteredRequirements.currently_due = rawRequirements.currently_due;
    }
    if (Array.isArray(rawRequirements.past_due)) {
      filteredRequirements.past_due = rawRequirements.past_due;
    }
    if (Object.keys(filteredRequirements).length > 0) {
      allowed.requirements = filteredRequirements;
    }
  }
  // P2-2 : controller — ne copier que fees_collector et is_controller.
  if (obj?.controller !== undefined && typeof obj?.controller === 'object') {
    const rawController = obj.controller as Record<string, unknown>;
    const filteredController: Record<string, unknown> = {};
    if (typeof rawController.fees_collector === 'string') {
      filteredController.fees_collector = rawController.fees_collector;
    }
    if (typeof rawController.is_controller === 'boolean') {
      filteredController.is_controller = rawController.is_controller;
    }
    if (Object.keys(filteredController).length > 0) {
      allowed.controller = filteredController;
    }
  }
  return allowed;
}

function normalizeRefundMetadata(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const metadata: Record<string, string> = {};
  for (const key of ['refund_id', 'organization_id', 'protocol_version'] as const) {
    if (typeof raw[key] === 'string') metadata[key] = raw[key];
  }
  return metadata;
}

/**
 * Valide les paramètres de création d'un PaymentIntent.
 * Lève PaymentProviderError(VALIDATION) en cas d'entrée invalide.
 */
function validateCreatePaymentIntentParams(params: CreatePaymentIntentParams): void {
  if (!Number.isSafeInteger(params.amountMinor) || params.amountMinor <= 0) {
    throw new PaymentProviderError(
      'VALIDATION',
      `Montant invalide (reçu : ${params.amountMinor})`,
      'invalid_amount',
    );
  }
  if (params.currency !== 'EUR') {
    throw new PaymentProviderError(
      'VALIDATION',
      `Devise non supportée (reçu : ${params.currency}, attendu : EUR)`,
      'invalid_currency',
    );
  }
  if (
    typeof params.connectedAccountId !== 'string' ||
    params.connectedAccountId.trim().length === 0
  ) {
    throw new PaymentProviderError(
      'VALIDATION',
      'Identifiant de compte connecté manquant ou vide',
      'invalid_connected_account_id',
    );
  }
  if (typeof params.idempotencyKey !== 'string' || params.idempotencyKey.trim().length === 0) {
    throw new PaymentProviderError(
      'VALIDATION',
      "Clé d'idempotence manquante ou vide",
      'invalid_idempotency_key',
    );
  }
  if (
    params.applicationFeeAmountMinor !== null &&
    (!Number.isSafeInteger(params.applicationFeeAmountMinor) ||
      params.applicationFeeAmountMinor < 0)
  ) {
    throw new PaymentProviderError(
      'VALIDATION',
      `Commission invalide (reçu : ${params.applicationFeeAmountMinor})`,
      'invalid_application_fee',
    );
  }
  if (
    params.applicationFeeAmountMinor !== null &&
    params.applicationFeeAmountMinor > params.amountMinor
  ) {
    throw new PaymentProviderError(
      'VALIDATION',
      'Commission supérieure au montant total',
      'invalid_application_fee',
    );
  }
  if (
    params.onBehalfOfAccountId !== null &&
    (typeof params.onBehalfOfAccountId !== 'string' ||
      params.onBehalfOfAccountId.trim().length === 0)
  ) {
    throw new PaymentProviderError(
      'VALIDATION',
      'on_behalf_of_account_id ne doit pas être une chaîne vide',
      'invalid_on_behalf_of',
    );
  }
  // Valider les 5 clés exactes de metadata (ADR-010 §6).
  const requiredMetadataKeys: (keyof PaymentMetadata)[] = [
    'payment_id',
    'payment_attempt_id',
    'draft_id',
    'organization_id',
    'protocol_version',
  ];
  for (const key of requiredMetadataKeys) {
    if (typeof params.metadata[key] !== 'string' || params.metadata[key].length === 0) {
      throw new PaymentProviderError(
        'VALIDATION',
        `Metadata manquante ou invalide pour la clé : ${key}`,
        'invalid_metadata',
      );
    }
  }
}

/**
 * Valide les paramètres de création d'un compte connecté.
 */
function validateCreateConnectedAccountParams(params: CreateConnectedAccountParams): void {
  if (typeof params.organizationId !== 'string' || params.organizationId.trim().length === 0) {
    throw new PaymentProviderError(
      'VALIDATION',
      "Identifiant d'organisation manquant ou vide",
      'invalid_organization_id',
    );
  }
  if (params.environment !== 'TEST' && params.environment !== 'LIVE') {
    throw new PaymentProviderError(
      'VALIDATION',
      `Environnement invalide (reçu : ${params.environment})`,
      'invalid_environment',
    );
  }
  if (typeof params.country !== 'string' || params.country.trim().length === 0) {
    throw new PaymentProviderError('VALIDATION', 'Pays manquant ou vide', 'invalid_country');
  }
  if (typeof params.idempotencyKey !== 'string' || params.idempotencyKey.trim().length === 0) {
    throw new PaymentProviderError(
      'VALIDATION',
      "Clé d'idempotence manquante ou vide",
      'invalid_idempotency_key',
    );
  }
}

/**
 * Valide la configuration du controller d'un compte connecté.
 */
function validateControllerConfig(controller: CreateConnectedAccountParams['controller']): void {
  if (!controller || typeof controller !== 'object') {
    throw new PaymentProviderError(
      'CONNECTED_ACCOUNT_CONFIGURATION_UNRESOLVED',
      'Configuration du compte connecté non résolue',
      'configuration_unresolved',
    );
  }
  const validFeesPayer = ['PLATFORM', 'CONNECTED_ACCOUNT'];
  const validLossesCollector = ['PLATFORM', 'STRIPE'];
  const validStripeDashboard = ['NONE', 'EXPRESS', 'FULL'];
  const validRequirementCollection = ['PLATFORM', 'STRIPE'];

  if (!validFeesPayer.includes(controller.feesPayer)) {
    throw new PaymentProviderError(
      'CONNECTED_ACCOUNT_CONFIGURATION_UNRESOLVED',
      'Configuration du compte connecté non résolue',
      'configuration_unresolved',
    );
  }
  if (!validLossesCollector.includes(controller.lossesCollector)) {
    throw new PaymentProviderError(
      'CONNECTED_ACCOUNT_CONFIGURATION_UNRESOLVED',
      'Configuration du compte connecté non résolue',
      'configuration_unresolved',
    );
  }
  if (!validStripeDashboard.includes(controller.stripeDashboard)) {
    throw new PaymentProviderError(
      'CONNECTED_ACCOUNT_CONFIGURATION_UNRESOLVED',
      'Configuration du compte connecté non résolue',
      'configuration_unresolved',
    );
  }
  if (!validRequirementCollection.includes(controller.requirementCollection)) {
    throw new PaymentProviderError(
      'CONNECTED_ACCOUNT_CONFIGURATION_UNRESOLVED',
      'Configuration du compte connecté non résolue',
      'configuration_unresolved',
    );
  }

  // Valider que la combinaison correspond à un preset Stripe v1 valide.
  validateControllerConfiguration(controller);
}

/**
 * Adapter Stripe réel implémentant PaymentProviderAdapter.
 * Le SDK Stripe est instancié une fois dans le constructeur avec la version
 * d'API épinglée. Aucune clé secrète n'est loggée.
 */
export class StripeAdapter implements PaymentProviderAdapter {
  private readonly stripe: Stripe;
  private readonly config: StripeAdapterConfig;
  readonly environment: StripeEnvironment;

  constructor(config: StripeAdapterConfig) {
    this.config = config;
    this.environment = config.environment;
    // Validation : la clé secrète doit correspondre à l'environnement déclaré (ADR-010 §14).
    if (config.environment === 'TEST' && !config.secretKey.startsWith('sk_test_')) {
      throw new Error("L'environnement TEST nécessite une clé sk_test_");
    }
    if (config.environment === 'LIVE' && !config.secretKey.startsWith('sk_live_')) {
      throw new Error("L'environnement LIVE nécessite une clé sk_live_");
    }
    // LIVE fail-closed : PAYMENTS_LIVE_ENABLED doit être explicitement true.
    if (config.environment === 'LIVE' && process.env.PAYMENTS_LIVE_ENABLED !== 'true') {
      throw new Error('LIVE non activé : PAYMENTS_LIVE_ENABLED doit être true');
    }
    this.stripe = new Stripe(config.secretKey, {
      apiVersion: config.apiVersion,
      typescript: true,
    });
  }

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentResult> {
    validateCreatePaymentIntentParams(params);
    try {
      const createParams: Stripe.PaymentIntentCreateParams = {
        amount: params.amountMinor,
        currency: params.currency.toLowerCase(),
        capture_method: 'automatic',
        payment_method_types: ['card'],
        transfer_data: { destination: params.connectedAccountId },
        metadata: params.metadata as unknown as Record<string, string>,
      };

      // application_fee_amount est omis lorsqu'il vaut 0 ou null (ADR-010 §3.1).
      if (params.applicationFeeAmountMinor !== null && params.applicationFeeAmountMinor > 0) {
        createParams.application_fee_amount = params.applicationFeeAmountMinor;
      }

      // on_behalf_of est omis si null (ADR-010 §5).
      if (params.onBehalfOfAccountId !== null) {
        createParams.on_behalf_of = params.onBehalfOfAccountId;
      }

      const intent = await this.stripe.paymentIntents.create(createParams, {
        idempotencyKey: params.idempotencyKey,
      });

      return {
        id: intent.id,
        status: mapPaymentIntentStatus(intent.status),
        clientSecret: intent.client_secret ?? null,
        latestChargeId:
          typeof intent.latest_charge === 'string'
            ? intent.latest_charge
            : (intent.latest_charge?.id ?? null),
        amountMinor: intent.amount,
        currency: intent.currency.toUpperCase(),
        environment: this.config.environment,
        connectedAccountId: extractId(intent.transfer_data?.destination),
        applicationFeeAmountMinor: intent.application_fee_amount ?? null,
        onBehalfOfAccountId: extractId(intent.on_behalf_of),
      };
    } catch (error) {
      throw mapStripeError(error);
    }
  }

  async retrievePaymentIntent(id: string): Promise<PaymentIntentResult> {
    try {
      const intent = await this.stripe.paymentIntents.retrieve(id);

      return {
        id: intent.id,
        status: mapPaymentIntentStatus(intent.status),
        clientSecret: intent.client_secret ?? null,
        latestChargeId:
          typeof intent.latest_charge === 'string'
            ? intent.latest_charge
            : (intent.latest_charge?.id ?? null),
        amountMinor: intent.amount,
        currency: intent.currency.toUpperCase(),
        environment: this.config.environment,
        connectedAccountId: extractId(intent.transfer_data?.destination),
        applicationFeeAmountMinor: intent.application_fee_amount ?? null,
        onBehalfOfAccountId: extractId(intent.on_behalf_of),
      };
    } catch (error) {
      throw mapStripeError(error);
    }
  }

  async cancelPaymentIntent(params: CancelPaymentIntentParams): Promise<PaymentIntentResult> {
    if (typeof params.id !== 'string' || params.id.trim().length === 0) {
      throw new PaymentProviderError('VALIDATION', 'Identifiant manquant ou vide', 'invalid_id');
    }
    if (typeof params.idempotencyKey !== 'string' || params.idempotencyKey.trim().length === 0) {
      throw new PaymentProviderError(
        'VALIDATION',
        "Clé d'idempotence manquante ou vide",
        'invalid_idempotency_key',
      );
    }
    try {
      const intent = await this.stripe.paymentIntents.cancel(params.id, undefined, {
        idempotencyKey: params.idempotencyKey,
      });

      return {
        id: intent.id,
        status: mapPaymentIntentStatus(intent.status),
        clientSecret: intent.client_secret ?? null,
        latestChargeId:
          typeof intent.latest_charge === 'string'
            ? intent.latest_charge
            : (intent.latest_charge?.id ?? null),
        amountMinor: intent.amount,
        currency: intent.currency.toUpperCase(),
        environment: this.config.environment,
        connectedAccountId: extractId(intent.transfer_data?.destination),
        applicationFeeAmountMinor: intent.application_fee_amount ?? null,
        onBehalfOfAccountId: extractId(intent.on_behalf_of),
      };
    } catch (error) {
      throw mapStripeError(error);
    }
  }

  async createRefund(params: CreateRefundParams): Promise<RefundResult> {
    if (params.metadata !== undefined) {
      const keys = Object.keys(params.metadata).sort();
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (
        keys.join(',') !== 'organization_id,protocol_version,refund_id' ||
        !uuidRegex.test(params.metadata.refund_id) ||
        !uuidRegex.test(params.metadata.organization_id) ||
        params.metadata.protocol_version !== 'refund-requested-v1'
      ) {
        throw new PaymentProviderError(
          'VALIDATION',
          'Metadata refund invalide',
          'invalid_metadata',
        );
      }
    }
    try {
      const refundParams: Stripe.RefundCreateParams = {
        payment_intent: params.paymentIntentId,
        amount: params.amountMinor,
        reverse_transfer: params.reverseTransfer,
        refund_application_fee: params.refundApplicationFee,
      };
      if (params.metadata !== undefined) {
        refundParams.metadata = { ...params.metadata };
      }

      const refund = await this.stripe.refunds.create(refundParams, {
        idempotencyKey: params.idempotencyKey,
      });

      if (refund.status === null || refund.status === undefined) {
        throw new PaymentProviderError(
          'UNSUPPORTED_PROVIDER_STATE',
          'Statut de refund absent',
          'unsupported_state',
        );
      }

      return {
        id: refund.id,
        status: mapRefundStatus(refund.status),
        amountMinor: refund.amount,
        currency: refund.currency.toUpperCase(),
      };
    } catch (error) {
      throw mapStripeError(error);
    }
  }

  async retrieveRefund(id: string): Promise<RefundResult> {
    try {
      const refund = await this.stripe.refunds.retrieve(id);

      if (refund.status === null || refund.status === undefined) {
        throw new PaymentProviderError(
          'UNSUPPORTED_PROVIDER_STATE',
          'Statut de refund absent',
          'unsupported_state',
        );
      }

      return {
        id: refund.id,
        status: mapRefundStatus(refund.status),
        amountMinor: refund.amount,
        currency: refund.currency.toUpperCase(),
      };
    } catch (error) {
      throw mapStripeError(error);
    }
  }

  async verifyWebhook(params: VerifyWebhookParams): Promise<WebhookVerification> {
    if (params.environment !== this.config.environment) {
      throw new PaymentProviderError(
        'PAYMENT_ENVIRONMENT_MISMATCH',
        "Environnement webhook différent de l'adapter",
        'environment_mismatch',
      );
    }

    const secret = this.resolveWebhookSecret(params.endpoint);
    if (secret === null) {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }

    try {
      const event = this.stripe.webhooks.constructEvent(
        params.rawBody,
        params.signature,
        secret,
        WEBHOOK_TOLERANCE_SECONDS, // Tolérance explicite de 5 minutes (ADR-010 §14)
      );

      const verified: VerifiedWebhookEvent = {
        id: event.id,
        type: event.type,
        created: event.created,
        apiVersion: event.api_version ?? this.config.apiVersion,
        objectId: extractObjectId(event),
        accountId: event.account ?? null,
        data: normalizeEventData(event),
      };

      return { valid: true, event: verified };
    } catch (error) {
      if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
        // Distinguer les raisons : timestamp expiré vs signature invalide.
        const message = error.message.toLowerCase();
        if (message.includes('timestamp')) {
          return { valid: false, reason: 'INVALID_TIMESTAMP' };
        }
        return { valid: false, reason: 'INVALID_SIGNATURE' };
      }
      // Autre erreur de parsing → payload invalide.
      return { valid: false, reason: 'INVALID_PAYLOAD' };
    }
  }

  async createConnectedAccount(
    params: CreateConnectedAccountParams,
  ): Promise<ConnectedAccountResult> {
    validateCreateConnectedAccountParams(params);
    validateControllerConfig(params.controller);

    if (params.environment !== this.config.environment) {
      throw new PaymentProviderError(
        'PAYMENT_ENVIRONMENT_MISMATCH',
        "Environnement webhook différent de l'adapter",
        'environment_mismatch',
      );
    }

    try {
      // Controller properties, pas type: 'express' ou 'custom' (ADR-010 §3.2).
      // On utilise toujours l'API v1 (ACCOUNTS_V1_CONTROLLER_PROPERTIES).
      const createParams: Stripe.AccountCreateParams = {
        country: params.country,
        controller: mapControllerConfigToV1(params.controller),
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: {
          organization_id: params.organizationId,
          environment: params.environment,
        },
      };

      const account = await this.stripe.accounts.create(createParams, {
        idempotencyKey: params.idempotencyKey,
      });

      return mapConnectedAccount(account);
    } catch (error) {
      throw mapStripeError(error);
    }
  }

  async retrieveConnectedAccount(id: string): Promise<ConnectedAccountResult> {
    try {
      const account = await this.stripe.accounts.retrieve(id);
      return mapConnectedAccount(account);
    } catch (error) {
      throw mapStripeError(error);
    }
  }

  async createOnboardingLink(params: CreateOnboardingLinkParams): Promise<OnboardingLinkResult> {
    if (typeof params.accountId !== 'string' || params.accountId.trim().length === 0) {
      throw new PaymentProviderError(
        'VALIDATION',
        'Identifiant de compte manquant ou vide',
        'invalid_account_id',
      );
    }
    if (typeof params.returnUrl !== 'string' || params.returnUrl.trim().length === 0) {
      throw new PaymentProviderError(
        'VALIDATION',
        'URL de retour manquante ou vide',
        'invalid_return_url',
      );
    }
    if (typeof params.refreshUrl !== 'string' || params.refreshUrl.trim().length === 0) {
      throw new PaymentProviderError(
        'VALIDATION',
        'URL de rafraîchissement manquante ou vide',
        'invalid_refresh_url',
      );
    }
    if (typeof params.idempotencyKey !== 'string' || params.idempotencyKey.trim().length === 0) {
      throw new PaymentProviderError(
        'VALIDATION',
        "Clé d'idempotence manquante ou vide",
        'invalid_idempotency_key',
      );
    }
    try {
      const link = await this.stripe.accountLinks.create(
        {
          account: params.accountId,
          type: 'account_onboarding',
          return_url: params.returnUrl,
          refresh_url: params.refreshUrl,
        },
        { idempotencyKey: params.idempotencyKey },
      );

      return {
        url: link.url,
        expiresAt: link.expires_at,
      };
    } catch (error) {
      throw mapStripeError(error);
    }
  }

  async projectCapabilities(accountId: string): Promise<AccountCapabilities> {
    try {
      const account = await this.stripe.accounts.retrieve(accountId);

      return {
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        transfersCapabilityStatus: mapTransfersCapability(account.capabilities),
      };
    } catch (error) {
      throw mapStripeError(error);
    }
  }

  /**
   * Résout le secret webhook selon l'endpoint.
   * Retourne null si l'endpoint est inconnu (ne lève pas).
   */
  private resolveWebhookSecret(endpoint: WebhookEndpoint): string | null {
    switch (endpoint) {
      case 'platform':
        return this.config.platformWebhookSecret;
      case 'connect':
        return this.config.connectWebhookSecret;
      default:
        return null;
    }
  }
}
