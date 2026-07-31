/**
 * @uttily/core — Fake strict du provider Stripe (Lot 5, ADR-010).
 *
 * Fake déterministe pour tests unitaires. N'appelle JAMAIS l'API Stripe réelle.
 * Les IDs sont générés de façon stable depuis les clés d'idempotence.
 * Le client_secret n'est JAMAIS stocké dans un champ persistant — il n'apparaît
 * que dans la valeur de retour.
 *
 * Ce fake n'est pas importable comme fixture de production : il vit dans le
 * module payments mais n'est utilisé que dans les tests.
 */

import { createHash } from 'node:crypto';
import { PaymentProviderError } from './errors';
import { validateControllerConfiguration } from './controller-config';
import type {
  AccountCapabilities,
  CancelPaymentIntentParams,
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
  RefundResult,
  RefundStatus,
  StripeEnvironment,
  TransfersCapabilityStatus,
  VerifiedWebhookEvent,
  VerifyWebhookParams,
  WebhookEndpoint,
  WebhookVerification,
} from './types';

/**
 * État interne d'un PaymentIntent fake.
 * Le client_secret n'est PAS stocké ici — il est régénéré à la volée.
 */
interface FakePaymentIntent {
  id: string;
  status: PaymentIntentStatus;
  latestChargeId: string | null;
  amountMinor: number;
  currency: string;
  connectedAccountId: string;
  applicationFeeAmountMinor: number | null;
  onBehalfOfAccountId: string | null;
  environment: StripeEnvironment;
  metadata: PaymentMetadata;
  /** Clé d'idempotence qui a créé cet intent (pour le replay). */
  idempotencyKey: string;
}

/**
 * État interne d'un refund fake.
 */
interface FakeRefund {
  id: string;
  status: RefundStatus;
  amountMinor: number;
  currency: string;
  paymentIntentId: string;
  reverseTransfer: boolean;
  refundApplicationFee: boolean;
  idempotencyKey: string;
}

/**
 * État interne d'un compte connecté fake.
 */
interface FakeConnectedAccount {
  id: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  transfersCapabilityStatus: TransfersCapabilityStatus;
  onboardingStatus: string;
  requirements: Record<string, unknown>;
  controllerConfiguration: Record<string, unknown>;
  apiGeneration: 'ACCOUNTS_V1_CONTROLLER_PROPERTIES';
  organizationId: string;
  environment: StripeEnvironment;
}

/**
 * Configuration du fake pour simuler des échecs, délais ou statuts spécifiques.
 */
export interface FakeStripeConfig {
  /** Si non-null, createPaymentIntent lève cette erreur. */
  forceCreatePaymentIntentError?: PaymentProviderError | null;
  /** Si non-null, createRefund lève cette erreur. */
  forceCreateRefundError?: PaymentProviderError | null;
  /** Si non-null, createConnectedAccount lève cette erreur. */
  forceCreateConnectedAccountError?: PaymentProviderError | null;
  /** Délai artificiel en ms pour toutes les méthodes (simule la latence). */
  artificialDelayMs?: number;
  /** Secret webhook fake pour l'endpoint plateforme. */
  platformWebhookSecret?: string;
  /** Secret webhook fake pour l'endpoint Connect. */
  connectWebhookSecret?: string;
  /** Environnement simulé (défaut : TEST). */
  environment?: StripeEnvironment;
}

/**
 * Allow-list de normalisation des données webhook (ADR-010 §14).
 * Le corps brut et les données de carte ne sont jamais persistés.
 * Cette logique reflète celle du StripeAdapter réel.
 */
function normalizeWebhookData(obj: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') {
    return {};
  }
  const allowed: Record<string, unknown> = {};
  if (typeof obj.id === 'string') {
    allowed.id = obj.id;
  }
  if (typeof obj.object === 'string') {
    allowed.object = obj.object;
  }
  if (typeof obj.status === 'string') {
    allowed.status = obj.status;
  }
  if (typeof obj.amount === 'number') {
    allowed.amount = obj.amount;
  }
  if (typeof obj.currency === 'string') {
    allowed.currency = obj.currency;
  }
  if (obj.metadata !== undefined && typeof obj.metadata === 'object') {
    const rawMetadata = obj.metadata as Record<string, unknown>;
    const filteredMetadata: Record<string, string> = {};
    const allowedKeys: (keyof PaymentMetadata)[] = [
      'payment_id',
      'payment_attempt_id',
      'draft_id',
      'organization_id',
      'protocol_version',
    ];
    for (const key of allowedKeys) {
      if (typeof rawMetadata[key] === 'string') {
        filteredMetadata[key] = rawMetadata[key] as string;
      }
    }
    allowed.metadata = filteredMetadata;
  }
  // transfer_data.destination (connected account ID) — nécessaire pour le recoupement.
  const transferData = obj.transfer_data as Record<string, unknown> | undefined;
  if (transferData !== null && typeof transferData === 'object') {
    const dest = transferData.destination;
    if (typeof dest === 'string') {
      allowed.transfer_data = { destination: dest };
    }
  }
  // application_fee_amount (commission) — nécessaire pour le recoupement.
  if (obj.application_fee_amount === null || typeof obj.application_fee_amount === 'number') {
    allowed.application_fee_amount = obj.application_fee_amount;
  }
  // on_behalf_of (compte connecté) — nécessaire pour le recoupement.
  if (obj.on_behalf_of === null || typeof obj.on_behalf_of === 'string') {
    allowed.on_behalf_of = obj.on_behalf_of;
  }
  // payment_intent (pour les événements charge.refunded / refund.*).
  if (typeof obj.payment_intent === 'string') {
    allowed.payment_intent = obj.payment_intent;
  }
  // refunds (pour charge.refunded — ApiList<Refund> avec data = Refund[]).
  // P2-2 : Ne copier que les champs métier nécessaires de chaque refund.
  // P1-3 : Ne pas filtrer les éléments non-objets — la validation se fait dans
  // le savepoint de projectRefundStatus pour garantir l'atomicité « tout ou
  // rien ». Un élément non-objet déclenchera REFUND_OBJECT_INVALID.
  if (obj.refunds !== undefined && typeof obj.refunds === 'object' && obj.refunds !== null) {
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
        };
      });
      allowed.refunds = { object: 'list', data: filteredData };
    }
  }
  // Champs account.updated (projection organization_payment_accounts).
  if (typeof obj.charges_enabled === 'boolean') {
    allowed.charges_enabled = obj.charges_enabled;
  }
  if (typeof obj.payouts_enabled === 'boolean') {
    allowed.payouts_enabled = obj.payouts_enabled;
  }
  // capabilities (objet avec transfers, card_payments, etc.) — P1-6.
  // P2-2 : Ne copier que le champ transfers.
  if (obj.capabilities !== undefined && typeof obj.capabilities === 'object') {
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
  if (obj.requirements !== undefined && typeof obj.requirements === 'object') {
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
  if (obj.controller !== undefined && typeof obj.controller === 'object') {
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

/**
 * Génère un hash déterministe court depuis une chaîne.
 * Utilisé pour produire des IDs stables depuis les clés d'idempotence.
 * Simplification test-only : SHA-256 tronqué à 24 hex (vs HMAC-SHA256 de Stripe).
 */
function stableHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 24);
}

/**
 * Calcule une empreinte déterministe des paramètres (clés triées récursivement).
 * Utilisé pour détecter les conflits d'idempotence : même clé + params différents.
 */
function computeFingerprint(params: unknown): string {
  const sorted = JSON.stringify(params, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value)
        .sort()
        .reduce((obj: Record<string, unknown>, k) => {
          obj[k] = (value as Record<string, unknown>)[k];
          return obj;
        }, {});
    }
    return value;
  });
  return stableHash(sorted);
}

/**
 * Génère un client_secret fake déterministe depuis l'ID du PaymentIntent.
 * Ce secret n'est JAMAIS stocké dans l'état interne — il est régénéré à la volée.
 */
function generateClientSecret(intentId: string): string {
  return `${intentId}_secret_${stableHash(intentId + '_secret')}`;
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
  // Valider les 5 clés exactes de metadata.
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
 * Valide les paramètres de création d'un refund.
 */
function validateCreateRefundParams(params: CreateRefundParams): void {
  if (typeof params.paymentIntentId !== 'string' || params.paymentIntentId.trim().length === 0) {
    throw new PaymentProviderError(
      'VALIDATION',
      'Identifiant de PaymentIntent manquant ou vide',
      'invalid_payment_intent_id',
    );
  }
  if (!Number.isSafeInteger(params.amountMinor) || params.amountMinor <= 0) {
    throw new PaymentProviderError(
      'VALIDATION',
      `Montant de refund invalide (reçu : ${params.amountMinor})`,
      'invalid_refund_amount',
    );
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
 * Fake strict du provider Stripe pour tests unitaires.
 *
 * Déterministe : mêmes entrées → mêmes sorties. Les IDs sont stables et
 * dérivés des clés d'idempotence. Le replay avec la même clé retourne le
 * même PaymentIntent sans en créer un nouveau.
 *
 * Le client_secret n'est JAMAIS stocké dans l'état interne — il est régénéré
 * à la volée à chaque appel.
 *
 * **ATTENTION : test uniquement.** Ne jamais utiliser en production.
 * Un guard runtime lève si NODE_ENV === 'production'.
 *
 * @test-only
 */
export class FakeStripeAdapter implements PaymentProviderAdapter {
  private readonly paymentIntents = new Map<string, FakePaymentIntent>();
  private readonly refunds = new Map<string, FakeRefund>();
  private readonly accounts = new Map<string, FakeConnectedAccount>();
  private readonly intentsByIdempotencyKey = new Map<string, string>();
  private readonly refundsByIdempotencyKey = new Map<string, string>();
  private readonly accountsByIdempotencyKey = new Map<string, string>();
  private readonly fingerprintsByKey = new Map<string, string>();
  private readonly onboardingLinksByIdempotencyKey = new Map<
    string,
    { url: string; expiresAt: number }
  >();
  private readonly cancelResultsByIdempotencyKey = new Map<string, PaymentIntentResult>();
  private readonly config: FakeStripeConfig;
  private readonly environment: StripeEnvironment;

  constructor(config: FakeStripeConfig = {}) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FakeStripeAdapter ne doit jamais être utilisé en production');
    }
    this.config = config;
    this.environment = config.environment ?? 'TEST';
  }

  /**
   * Simule un délai artificiel si configuré.
   */
  private async maybeDelay(): Promise<void> {
    if (this.config.artificialDelayMs && this.config.artificialDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.artificialDelayMs));
    }
  }

  /**
   * Projette un FakePaymentIntent vers PaymentIntentResult.
   * Le client_secret est régénéré à la volée, jamais lu depuis l'état.
   */
  private projectIntent(intent: FakePaymentIntent): PaymentIntentResult {
    return {
      id: intent.id,
      status: intent.status,
      clientSecret: generateClientSecret(intent.id),
      latestChargeId: intent.latestChargeId,
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      environment: intent.environment,
      connectedAccountId: intent.connectedAccountId,
      applicationFeeAmountMinor: intent.applicationFeeAmountMinor,
      onBehalfOfAccountId: intent.onBehalfOfAccountId,
    };
  }

  /**
   * Projette un FakeRefund vers RefundResult.
   */
  private projectRefund(refund: FakeRefund): RefundResult {
    return {
      id: refund.id,
      status: refund.status,
      amountMinor: refund.amountMinor,
      currency: refund.currency,
    };
  }

  /**
   * Projette un FakeConnectedAccount vers ConnectedAccountResult.
   */
  private projectAccount(account: FakeConnectedAccount): ConnectedAccountResult {
    return {
      id: account.id,
      chargesEnabled: account.chargesEnabled,
      payoutsEnabled: account.payoutsEnabled,
      transfersCapabilityStatus: account.transfersCapabilityStatus,
      onboardingStatus: account.onboardingStatus,
      requirements: account.requirements,
      controllerConfiguration: account.controllerConfiguration,
      apiGeneration: account.apiGeneration,
    };
  }

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentResult> {
    await this.maybeDelay();
    validateCreatePaymentIntentParams(params);

    if (this.config.forceCreatePaymentIntentError) {
      throw this.config.forceCreatePaymentIntentError;
    }

    // Vérification d'idempotence : même clé + params différents → conflit.
    const fingerprint = computeFingerprint(params);
    const existingFingerprint = this.fingerprintsByKey.get(params.idempotencyKey);
    if (existingFingerprint !== undefined) {
      if (existingFingerprint !== fingerprint) {
        throw new PaymentProviderError(
          'CONFLICT_IDEMPOTENCY',
          "Conflit d'idempotence : mêmes clés, paramètres différents",
          'idempotency_conflict',
        );
      }
      // Replay : même clé + mêmes params → même résultat.
      const existingId = this.intentsByIdempotencyKey.get(params.idempotencyKey);
      if (existingId !== undefined) {
        const existing = this.paymentIntents.get(existingId);
        if (existing !== undefined) {
          return this.projectIntent(existing);
        }
      }
    }

    // Stocker l'empreinte pour les futures vérifications.
    this.fingerprintsByKey.set(params.idempotencyKey, fingerprint);

    const id = `pi_${stableHash(params.idempotencyKey)}`;
    const intent: FakePaymentIntent = {
      id,
      status: 'requires_payment_method',
      latestChargeId: null,
      amountMinor: params.amountMinor,
      currency: params.currency,
      connectedAccountId: params.connectedAccountId,
      applicationFeeAmountMinor: params.applicationFeeAmountMinor,
      onBehalfOfAccountId: params.onBehalfOfAccountId,
      environment: this.environment,
      metadata: { ...params.metadata },
      idempotencyKey: params.idempotencyKey,
    };

    this.paymentIntents.set(id, intent);
    this.intentsByIdempotencyKey.set(params.idempotencyKey, id);

    return this.projectIntent(intent);
  }

  async retrievePaymentIntent(id: string): Promise<PaymentIntentResult> {
    await this.maybeDelay();

    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new PaymentProviderError('VALIDATION', 'Identifiant manquant ou vide', 'invalid_id');
    }

    const intent = this.paymentIntents.get(id);
    if (intent === undefined) {
      throw new PaymentProviderError('NOT_FOUND', 'PaymentIntent introuvable', 'resource_missing');
    }

    return this.projectIntent(intent);
  }

  async cancelPaymentIntent(params: CancelPaymentIntentParams): Promise<PaymentIntentResult> {
    await this.maybeDelay();

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

    // Vérification d'idempotence : même clé + params différents → conflit.
    const fingerprint = computeFingerprint(params);
    const existingFingerprint = this.fingerprintsByKey.get(params.idempotencyKey);
    if (existingFingerprint !== undefined) {
      if (existingFingerprint !== fingerprint) {
        throw new PaymentProviderError(
          'CONFLICT_IDEMPOTENCY',
          "Conflit d'idempotence : mêmes clés, paramètres différents",
          'idempotency_conflict',
        );
      }
      // Replay : même clé + mêmes params → même résultat.
      const existingResult = this.cancelResultsByIdempotencyKey.get(params.idempotencyKey);
      if (existingResult !== undefined) {
        return existingResult;
      }
    }

    const intent = this.paymentIntents.get(params.id);
    if (intent === undefined) {
      throw new PaymentProviderError('NOT_FOUND', 'PaymentIntent introuvable', 'resource_missing');
    }

    // SUCCEEDED ne régresse jamais (mapping monotone).
    if (intent.status === 'succeeded') {
      throw new PaymentProviderError(
        'VALIDATION',
        'PaymentIntent déjà réussi, annulation impossible',
        'invalid_status_transition',
      );
    }

    intent.status = 'canceled';
    this.paymentIntents.set(params.id, intent);

    const result = this.projectIntent(intent);
    this.fingerprintsByKey.set(params.idempotencyKey, fingerprint);
    this.cancelResultsByIdempotencyKey.set(params.idempotencyKey, result);
    return result;
  }

  async createRefund(params: CreateRefundParams): Promise<RefundResult> {
    await this.maybeDelay();
    validateCreateRefundParams(params);

    if (this.config.forceCreateRefundError) {
      throw this.config.forceCreateRefundError;
    }

    // Vérification d'idempotence : même clé + params différents → conflit.
    const fingerprint = computeFingerprint(params);
    const existingFingerprint = this.fingerprintsByKey.get(params.idempotencyKey);
    if (existingFingerprint !== undefined) {
      if (existingFingerprint !== fingerprint) {
        throw new PaymentProviderError(
          'CONFLICT_IDEMPOTENCY',
          "Conflit d'idempotence : mêmes clés, paramètres différents",
          'idempotency_conflict',
        );
      }
      // Replay : même clé + mêmes params → même résultat.
      const existingId = this.refundsByIdempotencyKey.get(params.idempotencyKey);
      if (existingId !== undefined) {
        const existing = this.refunds.get(existingId);
        if (existing !== undefined) {
          return this.projectRefund(existing);
        }
      }
    }

    // Vérifier que le PaymentIntent existe et est succeeded.
    const intent = this.paymentIntents.get(params.paymentIntentId);
    if (intent === undefined) {
      throw new PaymentProviderError('NOT_FOUND', 'PaymentIntent introuvable', 'resource_missing');
    }
    if (intent.status !== 'succeeded') {
      throw new PaymentProviderError(
        'VALIDATION',
        `PaymentIntent n'est pas réussi (statut : ${intent.status})`,
        'invalid_status_transition',
      );
    }

    const id = `re_${stableHash(params.idempotencyKey)}`;
    const refund: FakeRefund = {
      id,
      status: 'succeeded',
      amountMinor: params.amountMinor,
      currency: intent.currency,
      paymentIntentId: params.paymentIntentId,
      reverseTransfer: params.reverseTransfer,
      refundApplicationFee: params.refundApplicationFee,
      idempotencyKey: params.idempotencyKey,
    };

    this.refunds.set(id, refund);
    this.refundsByIdempotencyKey.set(params.idempotencyKey, id);
    this.fingerprintsByKey.set(params.idempotencyKey, fingerprint);

    return this.projectRefund(refund);
  }

  async retrieveRefund(id: string): Promise<RefundResult> {
    await this.maybeDelay();

    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new PaymentProviderError('VALIDATION', 'Identifiant manquant ou vide', 'invalid_id');
    }

    const refund = this.refunds.get(id);
    if (refund === undefined) {
      throw new PaymentProviderError('NOT_FOUND', 'Refund introuvable', 'resource_missing');
    }

    return this.projectRefund(refund);
  }

  async verifyWebhook(params: VerifyWebhookParams): Promise<WebhookVerification> {
    await this.maybeDelay();

    if (params.environment !== this.environment) {
      throw new PaymentProviderError(
        'PAYMENT_ENVIRONMENT_MISMATCH',
        "Environnement webhook différent de l'adapter",
        'environment_mismatch',
      );
    }

    if (typeof params.rawBody !== 'string' || params.rawBody.length === 0) {
      return { valid: false, reason: 'INVALID_PAYLOAD' };
    }
    if (typeof params.signature !== 'string' || params.signature.length === 0) {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }

    const secret = this.resolveWebhookSecret(params.endpoint);
    if (secret === null) {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }

    // Schéma de signature fake : "t=<timestamp>,v1=<hmac(rawBody, secret)>".
    // Pour les tests, on accepte une signature construite avec le même secret
    // (pour permettre aux tests de générer des signatures valides sans connaître
    // le timestamp exact).
    //
    // Ordre de vérification (conforme à Stripe) :
    // 1. Extraire le timestamp — s'il est présent et trop ancien (>300s),
    //    retourner INVALID_TIMESTAMP immédiatement.
    // 2. Extraire v1 — s'il ne correspond pas au hash attendu, retourner
    //    INVALID_SIGNATURE.
    // 3. Si v1 correspond → parser le payload et retourner l'événement valide.

    // 1. Vérifier le timestamp en premier.
    const providedTimestamp = this.extractTimestampFromSignature(params.signature);
    if (providedTimestamp !== null) {
      const now = Math.floor(Date.now() / 1000);
      const age = Math.abs(now - providedTimestamp);
      // Tolérance de 5 minutes (300s) — au-delà, c'est un timestamp invalide.
      if (age > 300) {
        return { valid: false, reason: 'INVALID_TIMESTAMP' };
      }
    }

    // 2. Vérifier la signature v1.
    const providedV1 = this.extractV1FromSignature(params.signature);
    const expectedV1 = stableHash(params.rawBody + secret);

    if (providedV1 !== null && providedV1 === expectedV1) {
      // 3. Parser le payload pour extraire l'événement.
      try {
        const parsed = JSON.parse(params.rawBody) as {
          id?: string;
          type?: string;
          created?: number;
          api_version?: string;
          account?: string;
          data?: { object?: { id?: string; [key: string]: unknown } };
        };

        const event: VerifiedWebhookEvent = {
          id: parsed.id ?? `evt_${stableHash(params.rawBody)}`,
          type: parsed.type ?? 'unknown',
          created: parsed.created ?? Math.floor(Date.now() / 1000),
          apiVersion: parsed.api_version ?? 'fake-api-version',
          objectId: parsed.data?.object?.id ?? '',
          accountId: parsed.account ?? null,
          data: normalizeWebhookData(parsed.data?.object as Record<string, unknown> | undefined),
        };

        return { valid: true, event };
      } catch {
        return { valid: false, reason: 'INVALID_PAYLOAD' };
      }
    }

    return { valid: false, reason: 'INVALID_SIGNATURE' };
  }

  async createConnectedAccount(
    params: CreateConnectedAccountParams,
  ): Promise<ConnectedAccountResult> {
    await this.maybeDelay();
    validateCreateConnectedAccountParams(params);

    // Valider la configuration du controller.
    if (!params.controller || typeof params.controller !== 'object') {
      throw new PaymentProviderError(
        'CONNECTED_ACCOUNT_CONFIGURATION_UNRESOLVED',
        'Configuration du compte connecté non résolue',
        'configuration_unresolved',
      );
    }

    // Valider que la combinaison correspond à un preset Stripe v1 valide.
    validateControllerConfiguration(params.controller);

    if (params.environment !== this.environment) {
      throw new PaymentProviderError(
        'PAYMENT_ENVIRONMENT_MISMATCH',
        "Environnement webhook différent de l'adapter",
        'environment_mismatch',
      );
    }

    if (this.config.forceCreateConnectedAccountError) {
      throw this.config.forceCreateConnectedAccountError;
    }

    // Vérification d'idempotence : même clé + params différents → conflit.
    const fingerprint = computeFingerprint(params);
    const existingFingerprint = this.fingerprintsByKey.get(params.idempotencyKey);
    if (existingFingerprint !== undefined) {
      if (existingFingerprint !== fingerprint) {
        throw new PaymentProviderError(
          'CONFLICT_IDEMPOTENCY',
          "Conflit d'idempotence : mêmes clés, paramètres différents",
          'idempotency_conflict',
        );
      }
      // Replay : même clé + mêmes params → même résultat.
      const existingId = this.accountsByIdempotencyKey.get(params.idempotencyKey);
      if (existingId !== undefined) {
        const existing = this.accounts.get(existingId);
        if (existing !== undefined) {
          return this.projectAccount(existing);
        }
      }
    }

    // Stocker l'empreinte pour les futures vérifications.
    this.fingerprintsByKey.set(params.idempotencyKey, fingerprint);

    // ID déterministe depuis organizationId + environment.
    const id = `acct_${stableHash(`${params.organizationId}_${params.environment}`)}`;

    // Replay : si le compte existe déjà, on le retourne.
    const existing = this.accounts.get(id);
    if (existing !== undefined) {
      this.accountsByIdempotencyKey.set(params.idempotencyKey, id);
      return this.projectAccount(existing);
    }

    const account: FakeConnectedAccount = {
      id,
      chargesEnabled: false,
      payoutsEnabled: false,
      transfersCapabilityStatus: 'PENDING',
      onboardingStatus: 'PENDING',
      requirements: {},
      controllerConfiguration: {
        feesPayer: params.controller.feesPayer,
        lossesCollector: params.controller.lossesCollector,
        stripeDashboard: params.controller.stripeDashboard,
        requirementCollection: params.controller.requirementCollection,
      },
      apiGeneration: 'ACCOUNTS_V1_CONTROLLER_PROPERTIES',
      organizationId: params.organizationId,
      environment: params.environment,
    };

    this.accounts.set(id, account);
    this.accountsByIdempotencyKey.set(params.idempotencyKey, id);

    return this.projectAccount(account);
  }

  async retrieveConnectedAccount(id: string): Promise<ConnectedAccountResult> {
    await this.maybeDelay();

    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new PaymentProviderError('VALIDATION', 'Identifiant manquant ou vide', 'invalid_id');
    }

    const account = this.accounts.get(id);
    if (account === undefined) {
      throw new PaymentProviderError(
        'NOT_FOUND',
        'Compte connecté introuvable',
        'resource_missing',
      );
    }

    return this.projectAccount(account);
  }

  async createOnboardingLink(params: CreateOnboardingLinkParams): Promise<OnboardingLinkResult> {
    await this.maybeDelay();

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

    // Vérification d'idempotence : même clé + params différents → conflit.
    const fingerprint = computeFingerprint(params);
    const existingFingerprint = this.fingerprintsByKey.get(params.idempotencyKey);
    if (existingFingerprint !== undefined) {
      if (existingFingerprint !== fingerprint) {
        throw new PaymentProviderError(
          'CONFLICT_IDEMPOTENCY',
          "Conflit d'idempotence : mêmes clés, paramètres différents",
          'idempotency_conflict',
        );
      }
      // Replay : même clé + mêmes params → même lien.
      const existingLink = this.onboardingLinksByIdempotencyKey.get(params.idempotencyKey);
      if (existingLink !== undefined) {
        return existingLink;
      }
    }

    // Stocker l'empreinte pour les futures vérifications.
    this.fingerprintsByKey.set(params.idempotencyKey, fingerprint);

    // Vérifier que le compte existe.
    const account = this.accounts.get(params.accountId);
    if (account === undefined) {
      throw new PaymentProviderError(
        'NOT_FOUND',
        'Compte connecté introuvable',
        'resource_missing',
      );
    }

    // URL déterministe depuis la clé d'idempotence (pas Date.now()).
    const token = stableHash(`${params.accountId}_onboarding_${params.idempotencyKey}`);
    const expiresAt = Math.floor(Date.now() / 1000) + 86400;
    const url = `https://fake-stripe.example.com/onboarding/${params.accountId}?token=${token}&return_url=${encodeURIComponent(params.returnUrl)}&refresh_url=${encodeURIComponent(params.refreshUrl)}`;

    const result: OnboardingLinkResult = { url, expiresAt };
    this.onboardingLinksByIdempotencyKey.set(params.idempotencyKey, result);

    return result;
  }

  async projectCapabilities(accountId: string): Promise<AccountCapabilities> {
    await this.maybeDelay();

    if (typeof accountId !== 'string' || accountId.trim().length === 0) {
      throw new PaymentProviderError(
        'VALIDATION',
        'Identifiant de compte manquant ou vide',
        'invalid_account_id',
      );
    }

    const account = this.accounts.get(accountId);
    if (account === undefined) {
      throw new PaymentProviderError(
        'NOT_FOUND',
        'Compte connecté introuvable',
        'resource_missing',
      );
    }

    return {
      chargesEnabled: account.chargesEnabled,
      payoutsEnabled: account.payoutsEnabled,
      transfersCapabilityStatus: account.transfersCapabilityStatus,
    };
  }

  // ===== Méthodes de test (pas dans l'interface) =====

  /**
   * Simule la transition d'un PaymentIntent vers un statut donné.
   * Utile pour les tests de webhook et de réconciliation.
   * SUCCEEDED ne régresse jamais.
   */
  simulatePaymentIntentStatus(id: string, status: PaymentIntentStatus): void {
    const intent = this.paymentIntents.get(id);
    if (intent === undefined) {
      throw new Error(`PaymentIntent ${id} introuvable dans le fake`);
    }
    if (intent.status === 'succeeded' && status !== 'succeeded') {
      // Monotone : pas de régression.
      return;
    }
    intent.status = status;
    if (status === 'succeeded') {
      intent.latestChargeId = `ch_${stableHash(id)}`;
    }
    this.paymentIntents.set(id, intent);
  }

  /**
   * Simule la transition d'un refund vers un statut donné.
   */
  simulateRefundStatus(id: string, status: RefundStatus): void {
    const refund = this.refunds.get(id);
    if (refund === undefined) {
      throw new Error(`Refund ${id} introuvable dans le fake`);
    }
    refund.status = status;
    this.refunds.set(id, refund);
  }

  /**
   * Simule la completion de l'onboarding d'un compte connecté.
   */
  simulateAccountOnboardingComplete(id: string): void {
    const account = this.accounts.get(id);
    if (account === undefined) {
      throw new Error(`Compte ${id} introuvable dans le fake`);
    }
    account.chargesEnabled = true;
    account.payoutsEnabled = true;
    account.transfersCapabilityStatus = 'ACTIVE';
    account.onboardingStatus = 'COMPLETE';
    this.accounts.set(id, account);
  }

  /**
   * Pré-charge un PaymentIntent dans le fake (pour les tests de retrieve/cancel).
   */
  preloadPaymentIntent(intent: FakePaymentIntent): void {
    this.paymentIntents.set(intent.id, intent);
    this.intentsByIdempotencyKey.set(intent.idempotencyKey, intent.id);
  }

  /**
   * Pré-charge un compte connecté dans le fake.
   */
  preloadConnectedAccount(account: FakeConnectedAccount): void {
    this.accounts.set(account.id, account);
  }

  /**
   * Génère une signature fake valide pour un corps et un endpoint donnés.
   * Utile pour les tests de webhook.
   */
  generateValidSignature(rawBody: string, endpoint: WebhookEndpoint): string {
    const secret = this.resolveWebhookSecret(endpoint);
    if (secret === null) {
      throw new Error(`Endpoint ${endpoint} non configuré dans le fake`);
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const v1 = stableHash(rawBody + secret);
    return `t=${timestamp},v1=${v1}`;
  }

  /**
   * Extrait la valeur v1 d'une signature fake.
   */
  private extractV1FromSignature(signature: string): string | null {
    const match = /v1=([a-f0-9]+)/.exec(signature);
    return match?.[1] ?? null;
  }

  /**
   * Extrait le timestamp d'une signature fake.
   */
  private extractTimestampFromSignature(signature: string): number | null {
    const match = /t=(\d+)/.exec(signature);
    if (match?.[1] !== undefined) {
      const ts = Number.parseInt(match[1], 10);
      if (!Number.isNaN(ts)) {
        return ts;
      }
    }
    return null;
  }

  /**
   * Résout le secret webhook selon l'endpoint.
   */
  private resolveWebhookSecret(endpoint: WebhookEndpoint): string | null {
    switch (endpoint) {
      case 'platform':
        return this.config.platformWebhookSecret ?? 'whsec_fake_platform';
      case 'connect':
        return this.config.connectWebhookSecret ?? 'whsec_fake_connect';
      default:
        return null;
    }
  }
}
