/**
 * Snapshot figé des termes financiers avant initiation du paiement (ADR-010 §6).
 * Produit par le résolveur serveur, jamais par le navigateur.
 * Aucune valeur UNDETERMINED ou null pour la taxe et la commission.
 */
export interface FinancialTermsSnapshot {
  /** Version du snapshot (incrémentée à chaque évolution du format). */
  version: string;
  /** Devise ISO 4217. Toujours 'EUR' au MVP. */
  currency: 'EUR';
  /** Total en unités mineures. Doit être égal au total immuable du brouillon. */
  totalAmountMinor: number;
  /** Statut fiscal : jamais UNDETERMINED. */
  taxStatus: 'NOT_APPLICABLE' | 'APPLIED';
  /** Montant de taxe en unités mineures. Non null (0 si NOT_APPLICABLE). */
  taxAmountMinor: number;
  /** Taux de taxe en points de base (null si non pertinent, ex: NOT_APPLICABLE). */
  taxRateBps: number | null;
  /** Snapshot de la règle fiscale (version, émetteur, etc.). */
  taxRuleSnapshot: TaxRuleSnapshot;
  /** Commission en unités mineures. Non null. */
  commissionAmountMinor: number;
  /** Snapshot de la règle de commission. */
  commissionRuleSnapshot: CommissionRuleSnapshot;
  /** Identifiant Stripe du compte connecté de l'organisation. */
  connectedAccountId: string;
  /** Modèle de charge. Toujours DESTINATION au MVP. */
  chargeModel: 'DESTINATION';
  /** Mode du settlement merchant. */
  settlementMerchantMode: 'PLATFORM' | 'CONNECTED_ACCOUNT';
  /** Compte on_behalf_of (null si non requis par le snapshot). */
  onBehalfOfAccountId: string | null;
  /** Version des termes juridiques acceptés. */
  legalTermsVersion: string;
}

export interface TaxRuleSnapshot {
  /** Version de la règle fiscale. */
  version: string;
  /** Émetteur de facture (à valider juridiquement avant LIVE). */
  invoiceIssuer: string;
  /** Autres métadonnées fiscales. */
  [key: string]: unknown;
}

export interface CommissionRuleSnapshot {
  /** Version de la règle de commission. */
  version: string;
  /** Base de calcul. */
  basis: string;
  /** Autres métadonnées de commission. */
  [key: string]: unknown;
}

/**
 * Configuration finance/juridique fournie par l'opérateur de la plateforme.
 * En production, chargée depuis une source de configuration sécurisée.
 * En l'absence de configuration réelle, le résolveur répond FINANCIAL_TERMS_UNRESOLVED.
 */
export interface FinancialTermsConfig {
  /** Configuration fiscale par organisation, ou null si non configurée. */
  tax: TaxConfig | null;
  /** Configuration de commission par organisation, ou null si non configurée. */
  commission: CommissionConfig | null;
  /** Configuration du compte connecté, ou null si non configuré. */
  connectedAccount: ConnectedAccountConfig | null;
  /** Version des termes juridiques. */
  legalTermsVersion: string;
}

export interface TaxConfig {
  version: string;
  status: 'NOT_APPLICABLE' | 'APPLIED';
  /** Montant en unités mineures (si APPLIED). Null si NOT_APPLICABLE. */
  amountMinor: number | null;
  /** Taux en points de base (si APPLIED). Null si non pertinent. */
  rateBps: number | null;
  invoiceIssuer: string;
}

export interface CommissionConfig {
  version: string;
  basis: string;
  /** Montant en unités mineures. */
  amountMinor: number;
}

export interface ConnectedAccountConfig {
  /** Identifiant Stripe du compte connecté. */
  accountId: string;
  /** Le compte accepte les destination charges. */
  chargesEnabled: boolean;
  /** Le compte accepte les transferts. */
  transfersCapabilityStatus: 'ACTIVE' | 'INACTIVE' | 'PENDING' | 'UNREQUESTED';
  /** Mode du settlement merchant. */
  settlementMerchantMode: 'PLATFORM' | 'CONNECTED_ACCOUNT';
  /** Compte on_behalf_of (null si non requis). */
  onBehalfOfAccountId: string | null;
}

/**
 * Entrée du résolveur : le brouillon tel que chargé côté serveur.
 * Le brouillon Lot 4 n'est jamais muté par le résolveur.
 */
export interface FinancialTermsInput {
  /** Identifiant de l'organisation du brouillon. */
  organizationId: string;
  /** Total immuable du brouillon en unités mineures. */
  draftTotalAmountMinor: number;
  /** Devise du brouillon. Doit être 'EUR'. */
  draftCurrency: string;
}

/**
 * Preuve d'acceptation des termes par le client.
 */
export interface TermsAcceptanceProof {
  /** Version des termes présentés et acceptés. */
  termsVersion: string;
  /** Identifiant de l'utilisateur qui a accepté. */
  userId: string;
  /** Instant serveur de l'acceptation (ISO 8601 UTC). */
  acceptedAt: string;
}
