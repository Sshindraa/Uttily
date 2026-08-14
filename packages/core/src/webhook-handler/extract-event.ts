/**
 * @uttily/core — Extraction des données d'un PaymentIntent depuis un webhook
 * (Lot 5, ADR-010 §9, §14).
 *
 * Extrait `PaymentIntentEventData` depuis `VerifiedWebhookEvent.data` avec une
 * allow-list stricte : id, status, amount, currency, metadata, destination,
 * application_fee_amount, on_behalf_of. Aucune donnée de carte ou secret n'est
 * extraite. Le corps brut n'est JAMAIS manipulé ici.
 */

import type { PaymentIntentEventData } from './types';
import type { VerifiedWebhookEvent } from '../payments/types';

/**
 * Extrait `PaymentIntentEventData` depuis les données normalisées d'un webhook
 * vérifié. Valide le format et lève une erreur si un champ requis est absent ou
 * de type incorrect.
 *
 * @param data Données normalisées (allow-list déjà appliquée par l'adapter).
 * @returns PaymentIntentEventData validée.
 * @throws Error si le format est invalide (champ requis absent ou type incorrect).
 */
export function extractPaymentIntentEventData(event: VerifiedWebhookEvent): PaymentIntentEventData {
  const data = event.data;
  if (!data || typeof data !== 'object') {
    throw new Error('Données webhook manquantes ou invalides');
  }

  const id = data.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('PaymentIntent ID manquant ou invalide dans les données webhook');
  }

  const status = data.status;
  if (typeof status !== 'string' || status.length === 0) {
    throw new Error('Statut PaymentIntent manquant ou invalide dans les données webhook');
  }

  const amount = data.amount;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) {
    throw new Error('Montant PaymentIntent manquant ou invalide dans les données webhook');
  }

  const currency = data.currency;
  if (typeof currency !== 'string' || currency.length === 0) {
    throw new Error('Devise PaymentIntent manquante ou invalide dans les données webhook');
  }

  // Metadata : allow-list stricte des clés internes (déjà filtrées par l'adapter).
  const rawMetadata = data.metadata;
  const metadata: PaymentIntentEventData['metadata'] = {};
  if (rawMetadata !== undefined && typeof rawMetadata === 'object' && rawMetadata !== null) {
    const md = rawMetadata as Record<string, unknown>;
    if (md.payment_type === 'AMENDMENT') {
      metadata.payment_type = 'AMENDMENT';
    }
    if (typeof md.payment_id === 'string') {
      metadata.payment_id = md.payment_id;
    }
    if (typeof md.payment_attempt_id === 'string') {
      metadata.payment_attempt_id = md.payment_attempt_id;
    }
    if (typeof md.draft_id === 'string') {
      metadata.draft_id = md.draft_id;
    }
    if (typeof md.amendment_payment_attempt_id === 'string') {
      metadata.amendment_payment_attempt_id = md.amendment_payment_attempt_id;
    }
    if (typeof md.amendment_id === 'string') {
      metadata.amendment_id = md.amendment_id;
    }
    if (typeof md.organization_id === 'string') {
      metadata.organization_id = md.organization_id;
    }
    if (md.environment === 'TEST' || md.environment === 'LIVE') {
      metadata.environment = md.environment;
    }
    if (typeof md.protocol_version === 'string') {
      metadata.protocol_version = md.protocol_version;
    }
  }

  // Destination : transfer_data.destination (connected account ID).
  const transferData = data.transfer_data as Record<string, unknown> | undefined;
  let destination: string | undefined;
  if (transferData !== null && typeof transferData === 'object' && transferData !== undefined) {
    const dest = transferData.destination;
    if (typeof dest === 'string') {
      destination = dest;
    }
  }

  // application_fee_amount (commission en unités mineures, null si 0).
  let applicationFeeAmount: number | null | undefined;
  if (data.application_fee_amount === null) {
    applicationFeeAmount = null;
  } else if (
    typeof data.application_fee_amount === 'number' &&
    Number.isSafeInteger(data.application_fee_amount)
  ) {
    applicationFeeAmount = data.application_fee_amount;
  }

  // on_behalf_of (compte connecté, null si non requis).
  let onBehalfOfAccountId: string | null | undefined;
  if (data.on_behalf_of === null) {
    onBehalfOfAccountId = null;
  } else if (typeof data.on_behalf_of === 'string') {
    onBehalfOfAccountId = data.on_behalf_of;
  }

  const result: PaymentIntentEventData = { id, status, amount, currency, metadata };
  if (destination !== undefined) {
    result.destination = destination;
  }
  if (applicationFeeAmount !== undefined) {
    result.applicationFeeAmount = applicationFeeAmount;
  }
  if (onBehalfOfAccountId !== undefined) {
    result.onBehalfOfAccountId = onBehalfOfAccountId;
  }
  return result;
}
