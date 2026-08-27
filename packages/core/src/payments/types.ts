/**
 * @uttily/core — Module Payments (Lot 5, ADR-010 §3, §5, §14).
 *
 * Contrat du provider de paiement (port). Aucun import du SDK Stripe :
 * l'implémentation est injectable. Les montants sont des entiers en unités
 * mineures avec devise EUR. Aucune méthode ne doit être appelée pendant une
 * transaction PostgreSQL ou sous un verrou FOR UPDATE (ADR-010 §1, §8).
 */

/**
 * Environnement Stripe (ADR-010).
 * Séparation explicite TEST/LIVE dans toutes les références fournisseur.
 */
export type StripeEnvironment = 'TEST' | 'LIVE';

/**
 * Modèle de charge (ADR-010 §3.1).
 * DESTINATION uniquement au MVP.
 */
export type ChargeModel = 'DESTINATION';

/**
 * Statuts PaymentIntent mappés depuis Stripe.
 * Mapping monotone : SUCCEEDED ne régresse jamais.
 */
export type PaymentIntentStatus =
  'requires_payment_method' | 'requires_action' | 'processing' | 'succeeded' | 'canceled';

/**
 * Résultat de la création/récupération d'un PaymentIntent.
 * Le client_secret est transmis au client autorisé mais JAMAIS persisté.
 */
export interface PaymentIntentResult {
  id: string;
  status: PaymentIntentStatus;
  clientSecret: string | null;
  latestChargeId: string | null;
  amountMinor: number;
  currency: string;
  /** Environnement Stripe (TEST/LIVE) — pour validation Transaction B. */
  environment: StripeEnvironment;
  /** Identifiant du compte connecté (destination) — pour validation. Null si non disponible (ex: retrieve sans transfer_data). */
  connectedAccountId: string | null;
  /** Commission en unités mineures (null si non applicable). */
  applicationFeeAmountMinor: number | null;
  /** Compte on_behalf_of (null si non requis). */
  onBehalfOfAccountId: string | null;
}

/** Metadata du paiement initial, conservées inchangées pour le flux Lot 5. */
export interface InitialPaymentMetadata {
  payment_id: string;
  payment_attempt_id: string;
  draft_id: string;
  organization_id: string;
  protocol_version: string;
}

/** Metadata strictes et fermées du PaymentIntent d'un amendement financier. */
export interface AmendmentPaymentMetadata {
  /** Champs historiques interdits pour cette variante, gardés optionnels pour
   * préserver l'accès typé aux metadata legacy dans les adapters/tests. */
  payment_id?: never;
  payment_attempt_id?: never;
  draft_id?: never;
  payment_type: 'AMENDMENT';
  amendment_payment_attempt_id: string;
  amendment_id: string;
  organization_id: string;
  environment: StripeEnvironment;
  protocol_version: 'booking-amendment-payment-v1';
}

/** Union fermée des metadata PaymentIntent Uttily. */
export type PaymentMetadata = InitialPaymentMetadata | AmendmentPaymentMetadata;

/**
 * Paramètres pour créer un PaymentIntent (ADR-010 §5, §8).
 * Reconstruits exclusivement depuis le snapshot persistant.
 */
export interface CreatePaymentIntentParams {
  /** Montant total en unités mineures (centimes EUR). */
  amountMinor: number;
  /** Devise ISO 4217. Toujours 'EUR'. */
  currency: 'EUR';
  /** Identifiant Stripe du compte connecté (destination). */
  connectedAccountId: string;
  /** Commission en unités mineures (omis si 0). */
  applicationFeeAmountMinor: number | null;
  /** Compte on_behalf_of (null si non requis). */
  onBehalfOfAccountId: string | null;
  /** Clé d'idempotence Stripe stable (propre à la tentative). */
  idempotencyKey: string;
  /** Metadata internes versionnées (payment_id, payment_attempt_id, draft_id, organization_id, protocol_version). */
  metadata: PaymentMetadata;
}

/**
 * Statuts de refund mappés depuis Stripe.
 */
export type RefundStatus = 'pending' | 'succeeded' | 'failed' | 'requires_action' | 'canceled';

/**
 * Résultat de la création/récupération d'un refund.
 */
export interface RefundResult {
  id: string;
  status: RefundStatus;
  amountMinor: number;
  currency: string;
}

/** Metadata minimale et fermée attachée aux refunds Uttily. */
export interface RefundMetadata {
  refund_id: string;
  organization_id: string;
  protocol_version: 'refund-requested-v1';
}

/**
 * Paramètres pour annuler un PaymentIntent (ADR-010 §8).
 */
export interface CancelPaymentIntentParams {
  /** Identifiant du PaymentIntent à annuler. */
  id: string;
  /** Clé d'idempotence Stripe stable. */
  idempotencyKey: string;
}

/**
 * Paramètres pour créer un refund (ADR-010 §13).
 */
export interface CreateRefundParams {
  /** Identifiant du PaymentIntent à rembourser. */
  paymentIntentId: string;
  /** Montant en unités mineures. */
  amountMinor: number;
  /** Clé d'idempotence Stripe stable. */
  idempotencyKey: string;
  /** Inverser le transfert vers le compte connecté. */
  reverseTransfer: boolean;
  /** Rembourser la commission de plateforme. */
  refundApplicationFee: boolean;
  /** Metadata Uttily du refund, omise pour les flux historiques non tagués. */
  metadata?: RefundMetadata;
}

/**
 * Type d'endpoint webhook (ADR-010 §9).
 */
export type WebhookEndpoint = 'platform' | 'connect';

/**
 * Événement webhook vérifié et normalisé.
 */
export interface VerifiedWebhookEvent {
  id: string;
  type: string;
  created: number; // Unix timestamp
  apiVersion: string;
  objectId: string;
  accountId: string | null;
  /** Données normalisées (allow-list des champs utiles). */
  data: Record<string, unknown>;
}

/**
 * Résultat de la vérification d'un webhook signé.
 */
export interface WebhookVerificationResult {
  valid: true;
  event: VerifiedWebhookEvent;
}

/**
 * Échec de la vérification d'un webhook signé.
 */
export interface WebhookVerificationFailure {
  valid: false;
  reason: 'INVALID_SIGNATURE' | 'INVALID_TIMESTAMP' | 'INVALID_PAYLOAD';
}

/**
 * Résultat union de la vérification d'un webhook.
 */
export type WebhookVerification = WebhookVerificationResult | WebhookVerificationFailure;

/**
 * Paramètres pour vérifier un webhook.
 */
export interface VerifyWebhookParams {
  rawBody: string;
  signature: string;
  endpoint: WebhookEndpoint;
  environment: StripeEnvironment;
}

/**
 * Statut de capacité de transfert Stripe.
 */
export type TransfersCapabilityStatus = 'ACTIVE' | 'INACTIVE' | 'PENDING' | 'UNREQUESTED';

/**
 * Génération d'API du compte connecté (ADR-010 §3.2).
 */
export type AccountApiGeneration = 'ACCOUNTS_V2' | 'ACCOUNTS_V1_CONTROLLER_PROPERTIES';

/**
 * Compte connecté Stripe (ADR-010 §3.2).
 */
export interface ConnectedAccountResult {
  id: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  transfersCapabilityStatus: TransfersCapabilityStatus;
  onboardingStatus: string;
  requirements: Record<string, unknown>;
  controllerConfiguration: Record<string, unknown>;
  apiGeneration: AccountApiGeneration;
}

/**
 * Configuration explicite du controller du compte connecté (ADR-010 §3.2).
 * Aucune valeur par défaut : tout doit être fourni explicitement.
 */
export interface ConnectedAccountControllerConfig {
  /** Responsable des frais Stripe. PLATFORM = la plateforme paie, CONNECTED_ACCOUNT = le compte connecté paie. */
  feesPayer: 'PLATFORM' | 'CONNECTED_ACCOUNT';
  /** Responsable des pertes. PLATFORM = la plateforme, STRIPE = Stripe. */
  lossesCollector: 'PLATFORM' | 'STRIPE';
  /** Accès au Dashboard Stripe. */
  stripeDashboard: 'NONE' | 'EXPRESS' | 'FULL';
  /** Responsable de la collecte des exigences. PLATFORM = la plateforme, STRIPE = Stripe. */
  requirementCollection: 'PLATFORM' | 'STRIPE';
}

/**
 * Paramètres pour créer un compte connecté.
 */
export interface CreateConnectedAccountParams {
  organizationId: string;
  environment: StripeEnvironment;
  /** Pays du compte (ISO 3166-1 alpha-2). */
  country: string;
  /** Configuration explicite du controller (requise, aucun défaut). */
  controller: ConnectedAccountControllerConfig;
  /** Clé d'idempotence Stripe stable. */
  idempotencyKey: string;
}

/**
 * Résultat d'un lien d'onboarding Stripe-hosted (ADR-010 §3.3).
 */
export interface OnboardingLinkResult {
  url: string;
  expiresAt: number; // Unix timestamp
}

/**
 * Paramètres pour créer un lien d'onboarding Stripe-hosted.
 */
export interface CreateOnboardingLinkParams {
  accountId: string;
  returnUrl: string;
  refreshUrl: string;
  idempotencyKey: string;
}

/**
 * Paramètres pour créer une Account Session Stripe Connect Embedded.
 */
export interface CreateAccountSessionParams {
  accountId: string;
}

/**
 * Résultat de la création d'une Account Session Stripe Connect Embedded.
 */
export interface AccountSessionResult {
  clientSecret: string;
  expiresAt: number; // Unix timestamp
}

/**
 * Capacités Stripe du compte (projection).
 */
export interface AccountCapabilities {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  transfersCapabilityStatus: TransfersCapabilityStatus;
}

/**
 * Union fermée des codes d'erreur Stripe mappés.
 * Ne divulgue jamais de détails internes arbitraires.
 */
export type StripeErrorCode =
  | 'card_declined'
  | 'rate_limit'
  | 'authentication_error'
  | 'invalid_request_error'
  | 'api_connection_error'
  | 'permission_error'
  | 'idempotency_error'
  | 'api_error'
  | 'resource_missing'
  | 'invalid_status_transition'
  | 'unknown';

/**
 * Interface du provider de paiement (port).
 * Aucun import Stripe dans le domaine ; l'implémentation est injectable.
 * Aucune méthode ne doit être appelée pendant une transaction PostgreSQL
 * ou sous un verrou FOR UPDATE (ADR-010 §1, §8).
 */
export interface PaymentProviderAdapter {
  /** Environnement Stripe de cet adapter (TEST ou LIVE). */
  readonly environment: StripeEnvironment;

  /** Crée un PaymentIntent (destination charge, carte, capture automatique). */
  createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentResult>;

  /** Récupère un PaymentIntent existant par son identifiant. */
  retrievePaymentIntent(id: string): Promise<PaymentIntentResult>;

  /** Annule un PaymentIntent. */
  cancelPaymentIntent(params: CancelPaymentIntentParams): Promise<PaymentIntentResult>;

  /** Crée un refund. */
  createRefund(params: CreateRefundParams): Promise<RefundResult>;

  /** Récupère un refund existant. */
  retrieveRefund(id: string): Promise<RefundResult>;

  /** Vérifie la signature d'un webhook et retourne l'événement normalisé. */
  verifyWebhook(params: VerifyWebhookParams): Promise<WebhookVerification>;

  /** Crée un compte connecté (API v1 avec controller properties, ADR-010 §3.2 amendement Lot 5). */
  createConnectedAccount(params: CreateConnectedAccountParams): Promise<ConnectedAccountResult>;

  /** Récupère un compte connecté existant. */
  retrieveConnectedAccount(id: string): Promise<ConnectedAccountResult>;

  /** Crée un lien d'onboarding Stripe-hosted. */
  createOnboardingLink(params: CreateOnboardingLinkParams): Promise<OnboardingLinkResult>;

  /** Crée une Account Session Stripe Connect Embedded. */
  createAccountSession(params: CreateAccountSessionParams): Promise<AccountSessionResult>;

  /** Projette les capacités du compte. */
  projectCapabilities(accountId: string): Promise<AccountCapabilities>;
}
