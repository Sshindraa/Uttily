/**
 * @uttily/core — Module Pricing Plans (G7P-B1).
 *
 * Use case : quoteFlexiblePricing(db, input).
 * Charge le contexte depuis la base, calcule le devis (pur), retourne le résultat.
 * Les erreurs PostgreSQL brutes ne s'échappent jamais — elles sont converties
 * en FlexiblePricingError avec un message générique (pas de leak du message brut).
 * L'erreur originale est préservée via `cause` pour le logging/debug.
 */

import type { DbExecutor } from '@uttily/database';
import type { QuoteFlexiblePricingInput, QuoteFlexiblePricingResult } from './types';
import { FlexiblePricingError } from './errors';
import { loadPricingContext } from './load-pricing-context';
import { computeQuote } from './quote-engine';

/**
 * Message générique pour les erreurs d'infrastructure (DB indisponible, etc.).
 * Le message brut de l'erreur originale n'est jamais exposé à l'appelant.
 */
const PRICING_CONTEXT_UNAVAILABLE_MESSAGE =
  'Le contexte de pricing est temporairement indisponible';

/**
 * Vérifie si une erreur est une erreur PostgreSQL (possède une propriété `code`
 * typique des erreurs pg, ex : '23505', '08006', 'ECONNREFUSED', etc.).
 */
function isPostgresLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Les erreurs PostgreSQL (pg, postgres-js, drizzle) exposent un `code` string.
  return typeof (err as { code?: unknown }).code === 'string';
}

/**
 * Convertit une erreur d'infrastructure (DB ou autre) en
 * FlexiblePricingError('PRICING_CONTEXT_UNAVAILABLE') avec un message générique.
 * L'erreur originale est préservée via `cause` (pas dans le message).
 */
function wrapInfrastructureError(err: unknown): FlexiblePricingError {
  return new FlexiblePricingError(
    'PRICING_CONTEXT_UNAVAILABLE',
    PRICING_CONTEXT_UNAVAILABLE_MESSAGE,
    {
      cause: err,
    },
  );
}

/**
 * Calcule un devis de tarification flexible (read-only, aucun effet de bord).
 *
 * 1. Valide l'entrée (lignes non vides, quantités > 0, locale non vide).
 * 2. Charge le contexte depuis la base (loadPricingContext — batched, no N+1).
 * 3. Calcule le devis (computeQuote — pur, déterministe).
 * 4. Retourne le résultat.
 *
 * @throws FlexiblePricingError pour toute erreur métier ou de base de données.
 *   - Les erreurs métier (VALIDATION, LOCATION_NOT_FOUND, etc.) sont re-lancées
 *     telles quelles (codes 4xx explicites).
 *   - Les erreurs d'infrastructure (DB indisponible, etc.) sont converties en
 *     PRICING_CONTEXT_UNAVAILABLE avec un message générique (pas de leak).
 */
export async function quoteFlexiblePricing(
  db: DbExecutor,
  input: QuoteFlexiblePricingInput,
): Promise<QuoteFlexiblePricingResult> {
  // 1. Validation de base.
  validateInput(input);

  // 2. Charger le contexte.
  let context;
  try {
    context = await loadPricingContext(db, input);
  } catch (err) {
    // Les FlexiblePricingError explicites (LOCATION_NOT_FOUND, etc.) sont
    // re-lancées telles quelles — ce sont des erreurs métier 4xx.
    if (err instanceof FlexiblePricingError) throw err;
    // Les erreurs PostgreSQL et autres erreurs d'infrastructure → message générique.
    // L'erreur originale est préservée via `cause` (pas dans le message).
    void isPostgresLikeError; // détection conservée pour documentation/telemetry
    throw wrapInfrastructureError(err);
  }

  // 3. Calculer le devis (pur).
  try {
    return computeQuote(context);
  } catch (err) {
    // Les FlexiblePricingError explicites sont re-lancées telles quelles.
    if (err instanceof FlexiblePricingError) throw err;
    // Toute autre erreur inattendue du moteur pur → message générique.
    throw wrapInfrastructureError(err);
  }
}

/**
 * Validation de base de l'entrée (avant tout accès base de données).
 */
function validateInput(input: QuoteFlexiblePricingInput): void {
  if (!input.organizationId || typeof input.organizationId !== 'string') {
    throw new FlexiblePricingError('VALIDATION', 'organizationId est requis');
  }
  if (!input.locationId || typeof input.locationId !== 'string') {
    throw new FlexiblePricingError('VALIDATION', 'locationId est requis');
  }
  if (!input.locale || typeof input.locale !== 'string' || input.locale.trim().length === 0) {
    throw new FlexiblePricingError('VALIDATION', 'locale est requis');
  }
  if (!input.intent || (input.intent.kind !== 'TIME_RANGE' && input.intent.kind !== 'DAY_RANGE')) {
    throw new FlexiblePricingError('VALIDATION', 'intent invalide');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new FlexiblePricingError('VALIDATION', 'Au moins une ligne est requise');
  }
  for (const line of input.lines) {
    if (!line.variantId || typeof line.variantId !== 'string') {
      throw new FlexiblePricingError('VALIDATION', 'variantId est requis sur chaque ligne');
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new FlexiblePricingError(
        'VALIDATION',
        `quantité invalide pour la variante ${line.variantId} (reçu: ${line.quantity})`,
      );
    }
  }
}
