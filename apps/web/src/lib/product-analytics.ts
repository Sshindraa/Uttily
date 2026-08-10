/**
 * apps/web — Helper analytics produit (G7H-B).
 *
 * Resoud l'environnement analytics pour les call sites Web.
 * La resolution est pure et deleguee au module Core.
 * PRODUCTION reste bloque — aucun flag ne peut l'activer dans G7H-B.
 */

import {
  resolveAnalyticsEnvironmentFromProcessEnv,
  type ResolvedAnalyticsEnvironment,
} from '@uttily/core';

let cached: ResolvedAnalyticsEnvironment | null = null;

/**
 * Retourne l'environnement analytics resolu depuis process.env.
 * Le resultat est mis en cache pour la duree de vie du process.
 *
 * @returns DEVELOPMENT, TEST ou DISABLED. Jamais PRODUCTION.
 */
export function getAnalyticsEnvironment(): ResolvedAnalyticsEnvironment {
  if (cached !== null) return cached;
  cached = resolveAnalyticsEnvironmentFromProcessEnv();
  return cached;
}
