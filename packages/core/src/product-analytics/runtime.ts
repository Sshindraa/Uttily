/**
 * @uttily/core — Module Product Analytics (G7H-B).
 *
 * Resolveur d'environnement analytics pur et injectable.
 *
 * La resolution est explicite via `PRODUCT_ANALYTICS_ENVIRONMENT` :
 * - DEVELOPMENT : collecte autorisee.
 * - TEST : collecte autorisee.
 * - PRODUCTION : toujours DISABLED dans G7H-B — aucun flag ne peut l'activer.
 * - valeur absente : DISABLED.
 * - valeur invalide : DISABLED avec diagnostic normalise.
 *
 * Aucun mapping automatique depuis NODE_ENV.
 * Aucun mapping global depuis STRIPE_ENVIRONMENT.
 * Aucun flag PRODUCT_ANALYTICS_PRODUCTION_ENABLED.
 *
 * G7H-B lock : le type `ResolvedAnalyticsEnvironment` est une union FERMEE qui
 * ne contient JAMAIS 'PRODUCTION'. Il ne reutilise PAS `AnalyticsEnvironment`
 * (qui contient PRODUCTION pour le low-level recorder controle). Le verrou
 * appartient au resolver / safe recorder / cablage : meme un cast runtime
 * `'PRODUCTION' as ResolvedAnalyticsEnvironment` doit etre rejete par le safe
 * recorder (defense-in-depth dans safe-record.ts).
 */

/**
 * Union FERMEE des environnements analytics resolus apres le verrou G7H-B.
 *
 * PRODUCTION est volontairement ABSENT : aucun flag ne peut l'activer dans
 * G7H-B. Le low-level `recordProductAnalyticsEvent` accepte encore PRODUCTION
 * (via `AnalyticsEnvironment`) pour une activation future controlee, mais le
 * resolver et le safe recorder ne le propagent jamais.
 */
export type ResolvedAnalyticsEnvironment = 'DEVELOPMENT' | 'TEST' | 'DISABLED';

/**
 * Configuration injectable pour la resolution d'environnement.
 * Permet de tester la resolution sans dependre de process.env.
 */
export interface AnalyticsEnvironmentConfig {
  readonly productAnalyticsEnvironment?: string | undefined;
}

/**
 * Resultat de la resolution d'environnement, incluant un diagnostic
 * normalise quand la valeur est invalide ou PRODUCTION.
 */
export interface ResolvedAnalyticsEnvironmentResult {
  readonly environment: ResolvedAnalyticsEnvironment;
  readonly diagnostic?: string;
}

/**
 * Resoud l'environnement analytics depuis une configuration pure et injectable.
 *
 * PRODUCTION est toujours DISABLED dans G7H-B : aucun flag ne peut l'activer.
 * Une valeur absente ou invalide retourne DISABLED.
 *
 * @returns L'environnement resolu (DEVELOPMENT, TEST ou DISABLED).
 */
export function resolveAnalyticsEnvironment(
  config: AnalyticsEnvironmentConfig,
): ResolvedAnalyticsEnvironment {
  return resolveAnalyticsEnvironmentWithDiagnostic(config).environment;
}

/**
 * Resoud l'environnement analytics avec un diagnostic normalise.
 *
 * Le diagnostic est present uniquement quand la valeur est absente, invalide
 * ou PRODUCTION. Il ne contient jamais de donnee sensible.
 *
 * @returns L'environnement resolu et un diagnostic optionnel.
 */
export function resolveAnalyticsEnvironmentWithDiagnostic(
  config: AnalyticsEnvironmentConfig,
): ResolvedAnalyticsEnvironmentResult {
  const raw = config.productAnalyticsEnvironment;
  if (raw === undefined || raw === null || raw === '') {
    return {
      environment: 'DISABLED',
      diagnostic: 'PRODUCT_ANALYTICS_ENVIRONMENT absent — collecte desactivee.',
    };
  }
  if (raw === 'DEVELOPMENT') {
    return { environment: 'DEVELOPMENT' };
  }
  if (raw === 'TEST') {
    return { environment: 'TEST' };
  }
  if (raw === 'PRODUCTION') {
    return {
      environment: 'DISABLED',
      diagnostic:
        "PRODUCT_ANALYTICS_ENVIRONMENT=PRODUCTION reste bloque dans G7H-B — aucun flag ne peut l'activer.",
    };
  }
  return {
    environment: 'DISABLED',
    diagnostic: `PRODUCT_ANALYTICS_ENVIRONMENT invalide — collecte desactivee.`,
  };
}

/**
 * Resoud l'environnement analytics depuis process.env.
 *
 * Utilise par defaut dans les modules Core qui n'ont pas de configuration
 * injectable. La resolution reste pure : cette fonction lit process.env et
 * delegue a resolveAnalyticsEnvironment.
 *
 * @returns L'environnement resolu (DEVELOPMENT, TEST ou DISABLED).
 */
export function resolveAnalyticsEnvironmentFromProcessEnv(): ResolvedAnalyticsEnvironment {
  return resolveAnalyticsEnvironment({
    productAnalyticsEnvironment: process.env.PRODUCT_ANALYTICS_ENVIRONMENT,
  });
}
