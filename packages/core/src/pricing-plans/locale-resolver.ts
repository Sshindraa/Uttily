/**
 * @uttily/core — Module Pricing Plans (G7P-B1).
 *
 * Résolution de locale FR/EN.
 * Règle : jamais utiliser fr comme fallback pour en ou vice versa.
 */

import type { ResolvedTranslation } from './types';
import { FlexiblePricingError } from './errors';

/** Locales de base supportées au lancement. */
const SUPPORTED_BASES = ['fr', 'en'] as const;

/**
 * Résout la locale demandée parmi les locales disponibles.
 *
 * - Si match exact existe, retourne la locale exacte.
 * - Si la langue de base match (ex: fr-FR → fr), retourne la langue de base.
 * - Si en-GB → en, retourne en.
 * - Si ni fr ni en ne peut être trouvé → UNSUPPORTED_LOCALE.
 * - JAMAIS utiliser fr comme fallback pour en ou vice versa.
 *
 * @param requestedLocale    Locale demandée (ex: "fr", "fr-FR", "en-GB", "de")
 * @param availableLocales   Locales disponibles pour le plan
 * @returns                   La locale résolue
 * @throws FlexiblePricingError(UNSUPPORTED_LOCALE) si aucune locale supportée.
 */
export function resolveLocale(requestedLocale: string, availableLocales: string[]): string {
  const normalized = requestedLocale.trim().toLowerCase();

  // 1. Match exact (case-insensitive).
  for (const avail of availableLocales) {
    if (avail.toLowerCase() === normalized) {
      return avail;
    }
  }

  // 2. Extraire la langue de base (ex: fr-FR → fr, en-GB → en).
  const baseLang = normalized.split('-')[0]!;

  // Vérifier que la langue de base est supportée.
  if (!SUPPORTED_BASES.includes(baseLang as (typeof SUPPORTED_BASES)[number])) {
    throw new FlexiblePricingError(
      'UNSUPPORTED_LOCALE',
      `Locale non supportée : ${requestedLocale} (langue de base "${baseLang}" non supportée, supportées : fr, en)`,
    );
  }

  // 3. Chercher la langue de base parmi les disponibles.
  for (const avail of availableLocales) {
    if (avail.toLowerCase() === baseLang) {
      return avail;
    }
  }

  // 4. La langue de base est supportée mais n'est pas disponible.
  // On ne fallback JAMAIS vers l'autre langue supportée.
  throw new FlexiblePricingError(
    'UNSUPPORTED_LOCALE',
    `Locale non supportée : ${requestedLocale} (langue de base "${baseLang}" supportée mais non disponible parmi [${availableLocales.join(', ')}])`,
  );
}

/**
 * Retourne le libellé public pour un plan et une locale résolue.
 *
 * @throws FlexiblePricingError(VALIDATION) si aucune traduction trouvée.
 */
export function getTranslation(
  planId: string,
  locale: string,
  translations: ResolvedTranslation[],
): string {
  const normalized = locale.toLowerCase();
  for (const t of translations) {
    if (t.pricingPlanId === planId && t.locale.toLowerCase() === normalized) {
      return t.publicLabel;
    }
  }
  throw new FlexiblePricingError(
    'VALIDATION',
    `getTranslation: aucune traduction pour le plan ${planId} en locale ${locale}`,
  );
}
