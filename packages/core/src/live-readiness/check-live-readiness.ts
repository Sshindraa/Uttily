/**
 * @uttily/core — LIVE Readiness Checker (Chantier 20-A).
 *
 * Vérifie la présence et la cohérence des variables d'environnement
 * nécessaires au passage LIVE.
 *
 * Garanties :
 * - Ne log JAMAIS de valeur de variable.
 * - N'écrit JAMAIS en base de données.
 * - Ne crée JAMAIS de PaymentIntent.
 * - N'appelle JAMAIS un provider payant.
 * - Fonctionne avec des valeurs factices dans les tests.
 */

import { type LiveVariableRule, REQUIRED_LIVE_VARIABLES, OPTIONAL_VARIABLES } from './live-config';

/** Statut individuel d'une variable vérifiée. */
export type VariableStatus =
  | 'PRESENT'
  | 'MISSING'
  | 'EMPTY'
  | 'INVALID_PREFIX'
  | 'TOO_SHORT'
  | 'INVALID_VALUE'
  | 'NOT_HTTPS'
  | 'NOT_PUBLIC'
  | 'NOT_POSITIVE_INT';

/** Résultat de vérification d'une variable individuelle. */
export interface VariableCheckResult {
  readonly name: string;
  readonly description: string;
  readonly status: VariableStatus;
  readonly required: boolean;
}

/** Statut d'une cohérence entre plusieurs variables ou d'un verrou applicatif. */
export type ReadinessGateStatus = 'PASS' | 'FAIL';

/** Résultat sans valeur d'un contrôle transversal. */
export interface ReadinessGateResult {
  readonly name: string;
  readonly description: string;
  readonly status: ReadinessGateStatus;
}

/** Rapport complet de readiness LIVE. */
export interface ReadinessReport {
  readonly ready: boolean;
  readonly required: readonly VariableCheckResult[];
  readonly optional: readonly VariableCheckResult[];
  readonly requiredPassCount: number;
  readonly requiredFailCount: number;
  readonly gates: readonly ReadinessGateResult[];
  readonly gateFailCount: number;
}

/** Vérifie une variable individuelle contre sa règle. Ne retourne jamais la valeur. */
function checkVariable(
  rule: LiveVariableRule,
  env: Record<string, string | undefined>,
): VariableStatus {
  const value = env[rule.name];

  // Absent
  if (value === undefined || value === null) {
    return 'MISSING';
  }

  // Vide
  if (value.trim() === '') {
    return 'EMPTY';
  }

  // Préfixe
  if (rule.prefixCheck !== undefined && !value.startsWith(rule.prefixCheck)) {
    return 'INVALID_PREFIX';
  }

  // Longueur minimale
  if (rule.minLength !== undefined && value.length < rule.minLength) {
    return 'TOO_SHORT';
  }

  // Valeur exacte
  if (rule.mustEqual !== undefined && value !== rule.mustEqual) {
    return 'INVALID_VALUE';
  }

  // Entier positif
  if (rule.mustBePositiveInt === true) {
    const num = Number(value);
    if (!Number.isSafeInteger(num) || num <= 0) {
      return 'NOT_POSITIVE_INT';
    }
  }

  // URL HTTPS
  if (rule.mustBeHttps === true || rule.mustBePublicHttps === true) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') {
        return 'NOT_HTTPS';
      }
      if (rule.mustBePublicHttps === true && isLocalHostname(url.hostname)) {
        return 'NOT_PUBLIC';
      }
    } catch {
      return 'NOT_HTTPS';
    }
  }

  // DATABASE_URL LIVE ne doit pas pointer vers PostgreSQL local ni vers une
  // autre forme d'URL silencieusement interprétable par l'environnement TEST.
  if (rule.mustBeRemotePostgresUrl === true) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
        return 'INVALID_VALUE';
      }
      if (isLocalHostname(url.hostname)) {
        return 'INVALID_VALUE';
      }
    } catch {
      return 'INVALID_VALUE';
    }
  }

  return 'PRESENT';
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase()) || LOCAL_HOSTNAMES.has(normalized);
}

/**
 * Contrôles qui ne peuvent pas être exprimés par une variable isolée.
 * Ils ne retournent jamais les valeurs comparées.
 */
function checkReadinessGates(env: Record<string, string | undefined>): ReadinessGateResult[] {
  const platformWebhookSecret = env.STRIPE_PLATFORM_WEBHOOK_SECRET?.trim();
  const connectWebhookSecret = env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim();
  const analyticsEnvironment = env.PRODUCT_ANALYTICS_ENVIRONMENT;

  return [
    {
      name: 'STRIPE_WEBHOOK_ENDPOINT_SECRETS_DISTINCT',
      description: 'Les secrets webhook plateforme et Connect sont distincts',
      status:
        platformWebhookSecret !== undefined &&
        platformWebhookSecret.length > 0 &&
        connectWebhookSecret !== undefined &&
        connectWebhookSecret.length > 0 &&
        platformWebhookSecret !== connectWebhookSecret
          ? 'PASS'
          : 'FAIL',
    },
    {
      name: 'ANALYTICS_PRODUCTION_PRIVACY_LOCK',
      description: 'Analytics PRODUCTION bloqué jusqu’au sign-off privacy 20-C',
      status: analyticsEnvironment === 'PRODUCTION' ? 'FAIL' : 'PASS',
    },
  ];
}

/**
 * Vérifie toutes les variables REQUIRED_LIVE et OPTIONAL.
 *
 * `ready` est true seulement si toutes les variables REQUIRED sont PRESENT.
 * Aucune valeur n'est incluse dans le rapport.
 */
export function checkLiveReadiness(
  env: Record<string, string | undefined> = process.env,
): ReadinessReport {
  const required: VariableCheckResult[] = REQUIRED_LIVE_VARIABLES.map((rule) => ({
    name: rule.name,
    description: rule.description,
    status: checkVariable(rule, env),
    required: true,
  }));

  const optional: VariableCheckResult[] = OPTIONAL_VARIABLES.map((rule) => ({
    name: rule.name,
    description: rule.description,
    status: checkVariable(rule, env),
    required: false,
  }));

  const requiredPassCount = required.filter((r) => r.status === 'PRESENT').length;
  const requiredFailCount = required.length - requiredPassCount;
  const gates = checkReadinessGates(env);
  const gateFailCount = gates.filter((gate) => gate.status === 'FAIL').length;

  return {
    ready: requiredFailCount === 0 && gateFailCount === 0,
    required,
    optional,
    requiredPassCount,
    requiredFailCount,
    gates,
    gateFailCount,
  };
}
