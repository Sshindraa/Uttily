/**
 * Snapshot figé de la variante au moment du calcul du prix.
 * Doit être fourni par l'appelant (use case) à partir des données chargées
 * côté serveur. Recopié tel quel dans le résultat, jamais calculé ici.
 */
export interface VariantPricingSnapshot {
  productName: string;
  variantName: string;
  skuSuffix: string | null;
  attributes: Record<string, unknown>;
}

/**
 * Ligne d'entrée pour le calcul de prix.
 * Les données sont déjà chargées côté serveur (variant, prix journalier, quantité).
 */
export interface PricingLineInput {
  /** Identifiant de la variante (pour référence, pas utilisé dans le calcul). */
  variantId: string;
  /** Prix journalier en unités mineures (centimes). Doit être > 0 et safe integer. */
  unitPriceAmountMinor: number;
  /** Quantité d'exemplaires. Doit être > 0 et entier. */
  quantity: number;
  /** Devise ISO 4217. Doit être 'EUR' au MVP. */
  currency: string;
  /** Snapshot figé de la variante, fourni par l'appelant (ADR-009). */
  variantSnapshot: VariantPricingSnapshot;
}

/**
 * Ligne de résultat avec le snapshot figé pour booking_draft_lines.
 */
export interface PricingLineResult {
  variantId: string;
  unitPriceAmountMinor: number;
  quantity: number;
  billableUnitCount: number;
  lineTotalAmountMinor: number;
  currency: 'EUR';
  variantSnapshot: VariantPricingSnapshot;
}

/**
 * Résultat complet du calcul de prix pour un brouillon.
 * Fournit les futurs champs de snapshot du brouillon, sans écrire en base.
 */
export interface PricingResult {
  lines: PricingLineResult[];
  billableUnit: 'DAY';
  billableUnitCount: number;
  currency: 'EUR';
  subtotalAmountMinor: number;
  mandatoryFeesAmountMinor: number;
  totalAmountMinor: number;
  taxStatus: 'UNDETERMINED';
  taxAmountMinor: null;
  taxRateBps: null;
  commissionAmountMinor: null;
}
