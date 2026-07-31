import { createHash } from 'node:crypto';
import { PAYMENT_PROTOCOL_VERSION } from './types';

/**
 * Calcule l'empreinte SHA-256 canonique de l'intention de paiement stable du
 * client (ADR-010).
 *
 * Le JSON canonique est construit avec :
 * - `v: "v1"` (version du protocole d'initiation de paiement)
 * - les champs `organization_id`, `customer_user_id` (strings, serveur)
 * - `draft_id` (string)
 * - `environment` (string, serveur)
 * - `terms_version` (string, depuis TermsAcceptanceProof)
 * - ordre des champs trié alphabétiquement (ordre d'insertion préservé par JS)
 * - encodage UTF-8, JSON compact (pas d'espaces, pas de retours)
 *
 * Sont EXCLUS : montants, taxe, commission, compte Stripe connecté,
 * clé d'idempotence fournisseur, clientSecret, timestamps serveur.
 *
 * @returns empreinte SHA-256 en hexadécimal (64 caractères)
 */
export function computePaymentFingerprint(input: {
  organizationId: string;
  customerUserId: string;
  draftId: string;
  environment: string;
  termsVersion: string;
}): string {
  const canonical = {
    customer_user_id: input.customerUserId,
    draft_id: input.draftId,
    environment: input.environment,
    organization_id: input.organizationId,
    terms_version: input.termsVersion,
    v: PAYMENT_PROTOCOL_VERSION,
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
