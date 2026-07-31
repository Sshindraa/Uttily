/**
 * @uttily/core — Module Webhook Handler (Lot 5, ADR-010 §9, §10, §11, §13, §14).
 *
 * Types publics du use case de traitement des webhooks Stripe. Le webhook
 * signé est l'autorité de l'état externe du paiement ; PostgreSQL reste
 * l'autorité de l'état métier et de la confirmation de réservation.
 *
 * Contraintes critiques (ADR-010 §1, §9, §14) :
 * - La vérification de signature se fait HORS transaction, avant toute écriture.
 * - Aucun appel Stripe à l'intérieur d'une transaction PostgreSQL ou sous un
 *   verrou FOR UPDATE.
 * - Le corps brut et les données de carte ne sont JAMAIS persistés.
 * - Le `client_secret` n'est JAMAIS persisté, loggé ou inclus dans une réponse.
 */

import type { DatabaseClient } from '@uttily/database';
import type {
  PaymentProviderAdapter,
  StripeEnvironment,
  WebhookEndpoint,
  VerifiedWebhookEvent,
} from '../payments/types';
import type { WebhookHandlerError } from './errors';

/** Dépendances injectées pour le use case handleWebhook. */
export interface WebhookHandlerDeps {
  db: DatabaseClient;
  provider: PaymentProviderAdapter;
}

/** Entrée du use case handleWebhook. */
export interface WebhookHandlerInput {
  /** Corps brut de la requête HTTP (pour vérification de signature). */
  rawBody: string;
  /** En-tête Stripe-Signature. */
  signature: string;
  /** Endpoint webhook (platform ou connect). */
  endpoint: WebhookEndpoint;
  /** Environnement Stripe (TEST ou LIVE). */
  environment: StripeEnvironment;
}

/** Résultat de succès — 2xx à retourner à Stripe. */
export interface WebhookHandlerSuccess {
  kind: 'SUCCESS';
  statusCode: 200;
}

/** Résultat d'échec — code d'erreur fermé et statut HTTP. */
export interface WebhookHandlerFailure {
  kind: 'FAILURE';
  statusCode: number;
  error: string;
  message: string;
}

/** Résultat union du use case handleWebhook. */
export type WebhookHandlerResult = WebhookHandlerSuccess | WebhookHandlerFailure;

/**
 * Résultat interne d'un handler métier (confirmBooking, handlePaymentFailed, etc.).
 * - `void` : le handler a traité l'événement normalement (PROCESSED/IGNORED).
 * - `WebhookHandlerError` : une validation d'invariant a échoué, l'événement a été
 *   marqué FAILED dans la transaction, et l'erreur doit être retournée à Stripe
 *   (pas re-lancée, pour que la transaction commit avec le statut FAILED).
 */
export type HandlerOutcome = void | WebhookHandlerError;

/** Types d'événements Stripe que nous traitons (ADR-010 §9). */
export type HandledEventType =
  | 'payment_intent.succeeded'
  | 'payment_intent.processing'
  | 'payment_intent.payment_failed'
  | 'payment_intent.canceled';

/** Statuts terminaux d'une tentative de paiement (monotone — pas de régression). */
export const TERMINAL_ATTEMPT_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;

/** Statuts terminaux d'un brouillon (impossible de convertir ensuite). */
export const TERMINAL_DRAFT_STATUSES = ['EXPIRED', 'CANCELLED', 'CONVERTED'] as const;

/**
 * Données normalisées d'un PaymentIntent extraites de l'événement webhook.
 * Allow-list stricte — aucun champ de carte ou secret.
 */
export interface PaymentIntentEventData {
  id: string;
  status: string;
  amount: number;
  currency: string;
  metadata?: {
    payment_id?: string;
    payment_attempt_id?: string;
    draft_id?: string;
    organization_id?: string;
    protocol_version?: string;
  };
  /** transfer_data.destination (connected account ID). */
  destination?: string;
  /** application_fee_amount (commission en unités mineures, null si 0). */
  applicationFeeAmount?: number | null;
  /** on_behalf_of (compte connecté, null si non requis). */
  onBehalfOfAccountId?: string | null;
}

/**
 * Tentative résolue après lookup par provider_payment_intent_id ou metadata.
 * Utilisé en interne pour passer les identifiants entre les étapes.
 */
export interface ResolvedAttempt {
  attemptId: string;
  paymentId: string;
  draftId: string;
  organizationId: string;
  attemptNumber: number;
  attemptStatus: string;
  paymentStatus: string;
  draftStatus: string;
  providerPaymentIntentId: string | null;
}

/**
 * Ligne d'événement webhook après insertion/déduplication.
 */
export interface WebhookEventRow {
  id: string;
  status: string;
  isDuplicate: boolean;
}

/** Type réexporté pour commodité. */
export type { VerifiedWebhookEvent };
