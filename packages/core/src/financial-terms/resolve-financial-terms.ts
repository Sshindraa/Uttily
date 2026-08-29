import { FinancialTermsError } from './errors';
import { parseMarketplaceFeeSnapshot } from '../marketplace-fees';
import type {
  CommissionRuleSnapshot,
  FinancialTermsConfig,
  FinancialTermsInput,
  FinancialTermsSnapshot,
  TaxRuleSnapshot,
  TermsAcceptanceProof,
} from './types';

/**
 * Version courante du format de snapshot.
 * Incrémentée à chaque évolution du format.
 */
const SNAPSHOT_VERSION = 'v1';

/**
 * Valide qu'une valeur est une chaîne ISO 8601 analysable.
 * N'accepte pas les chaînes vides.
 */
function isIso8601(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed);
}

/**
 * Résout les termes financiers d'un brouillon avant l'initiation du paiement
 * (ADR-010 §6).
 *
 * Fonction pure : aucune dépendance base de données, aucun appel Stripe, aucun
 * effet de bord. Les montants sont des entiers en unités mineures avec devise
 * EUR. Le brouillon Lot 4 n'est jamais muté — le résolveur ne lit que
 * `draftTotalAmountMinor`, `draftCurrency` et son snapshot split éventuel.
 *
 * Règles de validation (dans l'ordre) :
 *  1. Devise du brouillon doit être 'EUR'.
 *  2. Le total du brouillon doit être un safe integer >= 0.
 *  3. La configuration fiscale doit être présente (jamais de substitution par 0).
 *  4. Le statut fiscal ne doit pas être UNDETERMINED.
 *  5. Cohérence du montant et du taux de taxe selon le statut.
 *  6. Pour le legacy, la configuration de commission doit être présente ; un
 *     split utilise exclusivement son snapshot persistant.
 *  7. Le montant de commission legacy doit être un safe integer >= 0, <= total.
 *  8. La configuration du compte connecté doit être présente.
 *  9. Le compte connecté doit accepter les charges (chargesEnabled).
 * 10. La capacité de transfert doit être ACTIVE.
 * 11. Le modèle de charge est toujours DESTINATION au MVP (constante).
 * 12. Le mode de settlement merchant est propagé depuis la configuration.
 * 13. on_behalf_of_account_id, s'il est non null, doit être une chaîne non vide.
 * 14. La version des termes juridiques doit être une chaîne non vide.
 * 15. La preuve d'acceptation doit correspondre à la version courante et être valide.
 * 16. Pour le split, le total du snapshot est le total client ; pour le legacy,
 *     il est égal au total immuable du brouillon.
 * 17. La version du snapshot est 'v1'.
 *
 * @throws FinancialTermsError(VALIDATION) pour les erreurs de validation.
 * @throws FinancialTermsError(FINANCIAL_TERMS_UNRESOLVED) pour les configurations manquantes.
 * @throws FinancialTermsError(PAYMENT_ACCOUNT_NOT_READY) pour les comptes connectés non prêts.
 */
export function resolveFinancialTerms(
  input: FinancialTermsInput,
  config: FinancialTermsConfig,
  acceptance: TermsAcceptanceProof,
): FinancialTermsSnapshot {
  // 1. Devise du brouillon doit être 'EUR'.
  if (input.draftCurrency !== 'EUR') {
    throw new FinancialTermsError(
      'VALIDATION',
      `devise non supportée (reçu : ${input.draftCurrency}, attendu : EUR)`,
    );
  }

  // 2. Le total du brouillon doit être un safe integer >= 0.
  if (!Number.isSafeInteger(input.draftTotalAmountMinor) || input.draftTotalAmountMinor < 0) {
    throw new FinancialTermsError(
      'VALIDATION',
      `total du brouillon invalide (reçu : ${input.draftTotalAmountMinor})`,
    );
  }

  // 3. La configuration fiscale doit être présente.
  if (config.tax === null) {
    throw new FinancialTermsError(
      'FINANCIAL_TERMS_UNRESOLVED',
      "Configuration fiscale manquante pour l'organisation",
    );
  }

  // 4. Le statut fiscal ne doit pas être UNDETERMINED.
  if (config.tax.status !== 'NOT_APPLICABLE' && config.tax.status !== 'APPLIED') {
    throw new FinancialTermsError(
      'FINANCIAL_TERMS_UNRESOLVED',
      `statut fiscal invalide (reçu : ${config.tax.status as string})`,
    );
  }

  // 5. Cohérence du montant et du taux de taxe selon le statut.
  let taxAmountMinor: number;
  let taxRateBps: number | null;
  if (config.tax.status === 'NOT_APPLICABLE') {
    // Si NOT_APPLICABLE : taxAmountMinor doit être 0 (ou null → traité comme 0).
    // taxRateBps doit être null.
    const amount = config.tax.amountMinor ?? 0;
    if (amount !== 0) {
      throw new FinancialTermsError(
        'VALIDATION',
        `montant de taxe non nul pour un statut NOT_APPLICABLE (reçu : ${amount})`,
      );
    }
    if (config.tax.rateBps !== null) {
      throw new FinancialTermsError(
        'VALIDATION',
        `taux de taxe non null pour un statut NOT_APPLICABLE (reçu : ${config.tax.rateBps})`,
      );
    }
    taxAmountMinor = 0;
    taxRateBps = null;
  } else {
    // Si APPLIED : taxAmountMinor doit être non null, safe integer, >= 0, <= MAX_SAFE_INTEGER.
    if (config.tax.amountMinor === null) {
      throw new FinancialTermsError(
        'VALIDATION',
        'montant de taxe manquant pour un statut APPLIED',
      );
    }
    if (!Number.isSafeInteger(config.tax.amountMinor) || config.tax.amountMinor < 0) {
      throw new FinancialTermsError(
        'VALIDATION',
        `montant de taxe invalide pour un statut APPLIED (reçu : ${config.tax.amountMinor})`,
      );
    }
    // taxRateBps peut être null ou un safe integer >= 0.
    if (config.tax.rateBps !== null) {
      if (!Number.isSafeInteger(config.tax.rateBps) || config.tax.rateBps < 0) {
        throw new FinancialTermsError(
          'VALIDATION',
          `taux de taxe invalide pour un statut APPLIED (reçu : ${config.tax.rateBps})`,
        );
      }
    }
    taxAmountMinor = config.tax.amountMinor;
    taxRateBps = config.tax.rateBps;
  }

  // 6-7. Un draft split apporte son snapshot économique déjà calculé côté
  // serveur. La config courante ne peut ni le remplacer ni le recalculer.
  // Sans snapshot, conserver strictement le chemin legacy.
  let marketplaceFeeSnapshot;
  let commissionAmountMinor: number;
  let commissionRuleSnapshot: CommissionRuleSnapshot;
  if (input.draftMarketplaceFeeSnapshot !== undefined) {
    try {
      marketplaceFeeSnapshot = parseMarketplaceFeeSnapshot(input.draftMarketplaceFeeSnapshot);
    } catch (error) {
      throw new FinancialTermsError(
        'VALIDATION',
        `Snapshot marketplace invalide : ${error instanceof Error ? error.message : 'erreur inconnue'}`,
      );
    }
    if (marketplaceFeeSnapshot.marketplaceFeeBaseAmountMinor !== input.draftTotalAmountMinor) {
      throw new FinancialTermsError(
        'VALIDATION',
        'La base marketplace ne correspond pas au total marchand immuable du brouillon.',
      );
    }
    commissionAmountMinor = marketplaceFeeSnapshot.merchantFeeAmountMinor;
    commissionRuleSnapshot = {
      version: marketplaceFeeSnapshot.ruleVersion,
      basis: 'merchant_fee_compatibility_projection',
    };
  } else {
    if (config.commission === null) {
      throw new FinancialTermsError(
        'FINANCIAL_TERMS_UNRESOLVED',
        "Configuration de commission manquante pour l'organisation",
      );
    }
    if (!Number.isSafeInteger(config.commission.amountMinor) || config.commission.amountMinor < 0) {
      throw new FinancialTermsError(
        'VALIDATION',
        `montant de commission invalide (reçu : ${config.commission.amountMinor})`,
      );
    }
    if (config.commission.amountMinor > input.draftTotalAmountMinor) {
      throw new FinancialTermsError(
        'VALIDATION',
        `commission supérieure au total (commission : ${config.commission.amountMinor}, total : ${input.draftTotalAmountMinor})`,
      );
    }
    commissionAmountMinor = config.commission.amountMinor;
    commissionRuleSnapshot = {
      version: config.commission.version,
      basis: config.commission.basis,
    };
  }

  // 8. La configuration du compte connecté doit être présente.
  if (config.connectedAccount === null) {
    throw new FinancialTermsError(
      'FINANCIAL_TERMS_UNRESOLVED',
      "Compte connecté non configuré pour l'organisation",
    );
  }

  // 9. Le compte connecté doit accepter les charges.
  if (!config.connectedAccount.chargesEnabled) {
    throw new FinancialTermsError(
      'PAYMENT_ACCOUNT_NOT_READY',
      "Le compte connecté n'est pas autorisé à encaisser",
    );
  }

  // 10. La capacité de transfert doit être ACTIVE.
  if (config.connectedAccount.transfersCapabilityStatus !== 'ACTIVE') {
    throw new FinancialTermsError(
      'PAYMENT_ACCOUNT_NOT_READY',
      `Le compte connecté n'a pas une capacité de transfert active (reçu : ${config.connectedAccount.transfersCapabilityStatus})`,
    );
  }

  // 13. on_behalf_of_account_id, s'il est non null, doit être une chaîne non vide.
  if (
    config.connectedAccount.onBehalfOfAccountId !== null &&
    config.connectedAccount.onBehalfOfAccountId.trim().length === 0
  ) {
    throw new FinancialTermsError(
      'VALIDATION',
      'on_behalf_of_account_id ne doit pas être une chaîne vide',
    );
  }

  // 14. La version des termes juridiques doit être une chaîne non vide.
  if (
    typeof config.legalTermsVersion !== 'string' ||
    config.legalTermsVersion.trim().length === 0
  ) {
    throw new FinancialTermsError(
      'FINANCIAL_TERMS_UNRESOLVED',
      'Version des termes juridiques manquante ou vide',
    );
  }

  // 15. La preuve d'acceptation doit correspondre à la version courante et être valide.
  if (acceptance.termsVersion !== config.legalTermsVersion) {
    throw new FinancialTermsError(
      'VALIDATION',
      'La version des termes acceptés ne correspond pas à la version courante',
    );
  }
  if (typeof acceptance.userId !== 'string' || acceptance.userId.trim().length === 0) {
    throw new FinancialTermsError(
      'VALIDATION',
      "L'identifiant utilisateur de la preuve d'acceptation est vide",
    );
  }
  if (!isIso8601(acceptance.acceptedAt)) {
    throw new FinancialTermsError(
      'VALIDATION',
      `La date d'acceptation n'est pas une chaîne ISO 8601 valide (reçu : ${acceptance.acceptedAt})`,
    );
  }

  // Construction des snapshots de règles (recopie, pas référence).
  const taxRuleSnapshot: TaxRuleSnapshot = {
    version: config.tax.version,
    invoiceIssuer: config.tax.invoiceIssuer,
  };

  // 16. Le total split est le total client ; le total legacy est celui du
  // brouillon (par construction).
  // 17. La version du snapshot est 'v1'.
  return {
    version: SNAPSHOT_VERSION,
    currency: 'EUR',
    totalAmountMinor:
      marketplaceFeeSnapshot?.customerTotalAmountMinor ?? input.draftTotalAmountMinor,
    taxStatus: config.tax.status,
    taxAmountMinor,
    taxRateBps,
    taxRuleSnapshot,
    commissionAmountMinor,
    commissionRuleSnapshot,
    ...(marketplaceFeeSnapshot ? { marketplaceFeeSnapshot } : {}),
    connectedAccountId: config.connectedAccount.accountId,
    chargeModel: 'DESTINATION',
    settlementMerchantMode: config.connectedAccount.settlementMerchantMode,
    onBehalfOfAccountId: config.connectedAccount.onBehalfOfAccountId,
    legalTermsVersion: config.legalTermsVersion,
  };
}
