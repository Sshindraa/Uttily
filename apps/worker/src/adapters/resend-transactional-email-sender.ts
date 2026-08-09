/**
 * @uttily/worker — Adapter de production Resend pour TransactionalEmailSender
 * (G5H-B, ADR-014 §2.5).
 *
 * Utilise le SDK officiel `resend` (v6.18.1) pour l'API email Resend.
 *
 * Caractéristiques :
 * - Implémente exactement le port `TransactionalEmailSender` de `@uttily/core`.
 * - Mapping fermé des templateKeys logiques vers les identifiants Resend.
 * - `providerIdempotencyKey` transmis via `{ idempotencyKey }` au SDK.
 * - Fenêtre de déduplication Resend : 24 heures (documentée).
 * - Aucune configuration lue au chargement du module.
 * - Aucun logging dans l'adapter.
 * - Les erreurs ne contiennent JAMAIS de secret, PII, credential, template ID,
 *   providerIdempotencyKey, variables, bookingId, payload brut, réponse brute
 *   Resend, request ID, headers ou URL fournisseur.
 * - Aucun retry interne : un seul appel fournisseur par `send`.
 *
 * Câblé au worker exécutable depuis G5H-C2C-B3. La factory
 * `createResendTransactionalEmailSenderFromEnv` est appelée depuis
 * `createWorkerDependenciesFromEnv`.
 *
 * La politique de retry < 24 h et fail-closed sera implémentée dans G5H-C.
 */

import { Resend } from 'resend';
import type { TransactionalEmailSender } from '@uttily/core';
import type { EmailInput, EmailSendResult } from '@uttily/core';
import { BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY } from '@uttily/core';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration Resend validée. Toutes les valeurs sont non vides et bornées.
 */
export interface ResendConfig {
  readonly apiKey: string;
  readonly fromEmail: string;
  readonly bookingConfirmedTemplateId: string;
}

/**
 * Erreur de configuration Resend. Ne contient jamais de secret ou credential.
 */
export class ResendConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResendConfigError';
  }
}

/**
 * Valide qu'une chaîne est non vide et sans whitespace extérieur.
 */
function isNonEmptyTrimmed(value: string): boolean {
  return value.length > 0 && value.trim() === value && value.trim().length > 0;
}

/**
 * Valide une adresse email simple (forme `local@domain.tld`).
 *
 * Cet adapter utilise un sous-ensemble ASCII conservateur (refuse les parties
 * locales entre guillemets RFC 5321/5322 complexes, les domaines internationalisés
 * IDN, et les commentaires) car les emails transactionnels Uttily n'ont pas besoin
 * de ces formes. L'objectif est la sécurité et la prévisibilité.
 *
 * Règles :
 * - longueur totale ≤ 254
 * - aucun whitespace ni caractère de contrôle (0x00-0x1F, 0x7F)
 * - exactement un `@`
 * - partie locale : non vide, longueur ≤ 64, charset `[A-Za-z0-9._+-]`,
 *   ne commence ni ne finit par un point, aucun point consécutif (..)
 * - domaine : longueur ≤ 253, au moins deux labels séparés par un point,
 *   aucun label vide, chaque label ≤ 63 caractères, charset par label `[A-Za-z0-9-]`
 *   (PAS d'underscore), chaque label commence et finit par une lettre ou un chiffre,
 *   aucun point initial/final, aucun point consécutif.
 */
function isValidSimpleEmail(value: string): boolean {
  if (value.length === 0 || value.length > 254) return false;
  if (/\s/.test(value) || /[\x00-\x1F\x7F]/.test(value)) return false;
  const atIndex = value.indexOf('@');
  if (atIndex < 1) return false;
  if (value.lastIndexOf('@') !== atIndex) return false;
  const local = value.substring(0, atIndex);
  const domain = value.substring(atIndex + 1);
  if (local.length === 0 || local.length > 64) return false;
  if (domain.length === 0 || domain.length > 253) return false;
  // Charset local conservateur : refuse slash, chevrons, espaces, contrôle, etc.
  if (!/^[A-Za-z0-9._+-]+$/.test(local)) return false;
  // La partie locale ne commence ni ne finit par un point, ni points consécutifs.
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  // Aucun point initial/final ni points consécutifs dans le domaine.
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    // Charset label : lettres ASCII, chiffres et tiret uniquement (PAS d'underscore).
    if (!/^[A-Za-z0-9-]+$/.test(label)) return false;
    // Chaque label commence et finit par une lettre ou un chiffre (pas tiret).
    if (!/^[A-Za-z0-9]/.test(label) || !/[A-Za-z0-9]$/.test(label)) return false;
  }
  return true;
}

/**
 * Compte le nombre d'occurrences d'un caractère dans une chaîne.
 * Utilisé pour détecter les chevrons supplémentaires (au lieu du test tautologique
 * `indexOf === lastIndexOf` qui ne détecte jamais les doublons).
 */
function countChar(str: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === ch) count++;
  }
  return count;
}

/**
 * Valide l'adresse d'expédition (config `RESEND_FROM_EMAIL`).
 * Accepte `email@domain.tld` ou `Nom affiché <email@domain.tld>`.
 * Refuse les chevrons incomplets/multiples/désordonnés, les suffixes après `>`,
 * le nom d'affichage vide, et l'injection de header (CR/LF/caractères de contrôle).
 */
function isValidFromAddress(value: string): boolean {
  if (value.length === 0 || value.length > 254) return false;
  if (/[\r\n]/.test(value)) return false;
  const ltCount = countChar(value, '<');
  const gtCount = countChar(value, '>');
  if (ltCount === 0 && gtCount === 0) {
    // Forme simple : email@domain.tld.
    return isValidSimpleEmail(value);
  }
  // Forme avec nom d'affichage : exactement un `<` et un `>`.
  if (ltCount !== 1 || gtCount !== 1) return false;
  // `>` doit être le DERNIER caractère (aucun suffixe après).
  if (!value.endsWith('>')) return false;
  const ltIndex = value.indexOf('<');
  const gtIndex = value.lastIndexOf('>');
  if (ltIndex >= gtIndex) return false;
  const displayName = value.substring(0, ltIndex);
  const inner = value.substring(ltIndex + 1, gtIndex);
  // Nom d'affichage non vide après trim.
  if (displayName.trim().length === 0) return false;
  // Le nom ne contient aucun `<`, `>`, CR, LF, ni caractère de contrôle.
  if (/[\x00-\x1F\x7F<>]/.test(displayName)) return false;
  // L'adresse interne ne doit pas avoir de whitespace extérieur.
  if (inner.trim() !== inner) return false;
  return isValidSimpleEmail(inner);
}

/**
 * Valide l'email du destinataire (input).
 *
 * Ce validateur local duplique la logique de `parseRecipientEmail` de Core
 * (`packages/core/src/transactional-documents/recipient-email.ts`) car celle-ci
 * n'est pas exportée publiquement depuis `@uttily/core`. Ne pas créer d'import
 * profond fragile vers le module interne.
 *
 * Le destinataire n'accepte PAS la forme avec nom d'affichage (seulement email@domain.tld).
 */
function isValidRecipientEmail(value: string): boolean {
  if (value.trim() !== value) return false;
  return isValidSimpleEmail(value);
}

/**
 * Valide la configuration Resend. Toutes les valeurs doivent être non vides,
 * non whitespace, et respecter les formats attendus.
 *
 * @throws {ResendConfigError} si la configuration est invalide. Les messages
 *   ne contiennent jamais la valeur reçue, le secret, ou le credential.
 */
export function validateResendConfig(config: ResendConfig): void {
  if (!isNonEmptyTrimmed(config.apiKey)) {
    throw new ResendConfigError(
      'RESEND_API_KEY est requis et ne doit pas être vide ou contenir uniquement des espaces.',
    );
  }
  if (!config.apiKey.startsWith('re_')) {
    throw new ResendConfigError(
      'RESEND_API_KEY a un format invalide (préfixe `re_` attendu). ' +
        "La valeur n'est pas affichée pour des raisons de sécurité.",
    );
  }
  if (/\s/.test(config.apiKey)) {
    throw new ResendConfigError(
      'RESEND_API_KEY ne doit contenir aucun whitespace (interne ou extérieur). ' +
        "La valeur n'est pas affichée pour des raisons de sécurité.",
    );
  }
  if (config.apiKey.length > 256) {
    throw new ResendConfigError(
      'RESEND_API_KEY dépasse la longueur maximale autorisée (256 caractères). ' +
        "La valeur n'est pas affichée pour des raisons de sécurité.",
    );
  }

  if (!isNonEmptyTrimmed(config.fromEmail)) {
    throw new ResendConfigError(
      'RESEND_FROM_EMAIL est requis et ne doit pas être vide ou contenir uniquement des espaces.',
    );
  }
  if (!isValidFromAddress(config.fromEmail)) {
    throw new ResendConfigError(
      'RESEND_FROM_EMAIL a un format invalide. Attendu : une adresse email ou ' +
        '"Nom <email@domaine.com>". La valeur reçue n\'est pas affichée.',
    );
  }

  if (!isNonEmptyTrimmed(config.bookingConfirmedTemplateId)) {
    throw new ResendConfigError(
      'RESEND_BOOKING_CONFIRMED_TEMPLATE_ID est requis et ne doit pas être vide ' +
        'ou contenir uniquement des espaces.',
    );
  }
  if (/[\r\n]/.test(config.bookingConfirmedTemplateId)) {
    throw new ResendConfigError(
      'RESEND_BOOKING_CONFIRMED_TEMPLATE_ID ne doit contenir aucun CR ni LF. ' +
        "La valeur n'est pas affichée.",
    );
  }
  if (config.bookingConfirmedTemplateId.length > 256) {
    throw new ResendConfigError(
      'RESEND_BOOKING_CONFIRMED_TEMPLATE_ID dépasse la longueur maximale autorisée ' +
        "(256 caractères). La valeur n'est pas affichée.",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Abstraction minimale pour testabilité
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload envoyé à Resend via le SDK (mode template).
 * Structurellement compatible avec `CreateEmailOptions` du SDK.
 */
export interface ResendSendPayload {
  readonly from: string;
  readonly to: string;
  readonly template: {
    readonly id: string;
    readonly variables?: Record<string, string | number>;
  };
}

/**
 * Options envoyées à Resend via le SDK.
 * Structurellement compatible avec `CreateEmailRequestOptions` du SDK.
 */
export interface ResendSendOptions {
  readonly idempotencyKey?: string;
}

/**
 * Réponse de Resend (succès).
 */
export interface ResendResponseData {
  readonly id: string;
}

/**
 * Réponse d'erreur de Resend.
 */
export interface ResendResponseError {
  readonly message: string;
  readonly statusCode: number | null;
  readonly name: string;
}

/**
 * Réponse complète de Resend.
 * Structurellement compatible avec `CreateEmailResponse` du SDK.
 */
export interface ResendSendResponse {
  readonly data: ResendResponseData | null;
  readonly error: ResendResponseError | null;
}

/**
 * Abstraction minimale autour de `resend.emails.send`. Permet l'injection
 * d'un client factice dans les tests sans mocker globalement le SDK.
 */
export interface ResendEmailsLike {
  send(payload: ResendSendPayload, options?: ResendSendOptions): Promise<ResendSendResponse>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapping fermé des templates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mapping fermé des templateKeys logiques vers les identifiants Resend.
 * Aucun template inconnu ne peut être envoyé.
 * Retourne le templateId ou null si non supporté.
 */
function resolveTemplateId(templateKey: string, config: ResendConfig): string | null {
  switch (templateKey) {
    case BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY:
      return config.bookingConfirmedTemplateId;
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation d'input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Longueur maximale d'une clé d'idempotence Resend (documentée : 256).
 */
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

/**
 * Résultat de la validation locale de l'input.
 * - 'OK' : input valide.
 * - 'INVALID_RECIPIENT' : destinataire local invalide.
 * - 'TEMPLATE_NOT_SUPPORTED' : template local absent/non supporté.
 * - 'PROVIDER_REFUSED_DETERMINISTIC' : autre validation locale déterministe
 *   (clé d'idempotence trop longue, variables invalides).
 */
type LocalValidationResult =
  'OK' | 'INVALID_RECIPIENT' | 'TEMPLATE_NOT_SUPPORTED' | 'PROVIDER_REFUSED_DETERMINISTIC';

/**
 * Valide l'input avant l'appel fournisseur.
 *
 * @returns 'OK' si valide, sinon un code de refus déterministe local.
 *   Les messages ne contiennent jamais de PII ou donnée sensible.
 */
function validateEmailInput(input: EmailInput): LocalValidationResult {
  // recipientEmail : non vide, format robuste.
  if (!input.recipientEmail || !isNonEmptyTrimmed(input.recipientEmail)) {
    return 'INVALID_RECIPIENT';
  }
  if (!isValidRecipientEmail(input.recipientEmail)) {
    return 'INVALID_RECIPIENT';
  }

  // templateKey : non vide.
  if (!input.templateKey || !isNonEmptyTrimmed(input.templateKey)) {
    return 'TEMPLATE_NOT_SUPPORTED';
  }

  // providerIdempotencyKey : non vide, sans whitespace extérieur, <= 256.
  if (!input.providerIdempotencyKey || !isNonEmptyTrimmed(input.providerIdempotencyKey)) {
    return 'PROVIDER_REFUSED_DETERMINISTIC';
  }
  if (input.providerIdempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return 'PROVIDER_REFUSED_DETERMINISTIC';
  }

  // variables : sérialisables, string ou number, nombres finis et safe integers.
  if (!validateVariables(input.variables)) {
    return 'PROVIDER_REFUSED_DETERMINISTIC';
  }

  return 'OK';
}

/**
 * Noms de variables réservés par Resend (interdits).
 * Source : https://resend.com/docs/api-reference/emails/send-email
 */
const RESERVED_VARIABLE_NAMES: ReadonlySet<string> = new Set([
  'FIRST_NAME',
  'LAST_NAME',
  'EMAIL',
  'UNSUBSCRIBE_URL',
]);

const VARIABLE_NAME_PATTERN = /^[A-Za-z0-9_]+$/;
const MAX_VARIABLE_NAME_LENGTH = 50;
const MAX_VARIABLE_STRING_LENGTH = 2000;

/**
 * Valide que les variables sont conformes au contrat Resend :
 * - nom : uniquement lettres ASCII (a-z, A-Z), chiffres (0-9) et underscore (_)
 * - longueur du nom : 1 à 50 caractères
 * - noms réservés interdits : FIRST_NAME, LAST_NAME, EMAIL, UNSUBSCRIBE_URL
 * - valeur string : longueur ≤ 2 000 caractères
 * - valeur number : finie et safe integer
 *
 * @returns true si valide, false sinon. Les messages d'erreur ne sont jamais exposés.
 */
function validateVariables(variables: Readonly<Record<string, string | number>>): boolean {
  for (const key of Object.keys(variables)) {
    if (!key || key.length === 0) {
      return false;
    }
    if (key.length > MAX_VARIABLE_NAME_LENGTH) {
      return false;
    }
    if (!VARIABLE_NAME_PATTERN.test(key)) {
      return false;
    }
    if (RESERVED_VARIABLE_NAMES.has(key)) {
      return false;
    }
    const value = variables[key];
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
        return false;
      }
    } else if (typeof value === 'string') {
      if (value.length > MAX_VARIABLE_STRING_LENGTH) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification des erreurs Resend
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Codes d'erreur Resend spécifiques à l'idempotence.
 */
const IDEMPOTENT_REQUEST_CONFLICT_CODE = 'invalid_idempotent_request';
const CONCURRENT_IDEMPOTENT_REQUESTS_CODE = 'concurrent_idempotent_requests';
const INVALID_IDEMPOTENCY_KEY_CODE = 'invalid_idempotency_key';

/**
 * Noms d'erreur identifiant un timeout structuré (pas de free-text).
 */
const TIMEOUT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'AbortError',
  'TimeoutError',
  'ETIMEDOUT',
  'ECONNABORTED',
]);

/**
 * Noms/codes d'erreur identifiant une erreur réseau structurée (pas de free-text).
 */
const NETWORK_ERROR_NAMES: ReadonlySet<string> = new Set([
  'NetworkError',
  'ENOTFOUND',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
]);

/**
 * Classifie une erreur Resend (réponse error non-null) en EmailSendResult.
 * Ne transmet jamais le message brut, le request ID, ou les headers.
 * Classification uniquement depuis error.name et error.statusCode (pas de free-text).
 */
function classifyResendError(error: ResendResponseError): EmailSendResult {
  // Conflits d'idempotence spécifiques.
  if (error.name === IDEMPOTENT_REQUEST_CONFLICT_CODE) {
    return {
      kind: 'DETERMINISTIC_REFUSAL',
      failureCode: 'IDEMPOTENT_PAYLOAD_CONFLICT',
    };
  }
  if (error.name === CONCURRENT_IDEMPOTENT_REQUESTS_CODE) {
    return {
      kind: 'TRANSIENT_NOT_SENT',
      failureCode: 'CONCURRENT_IDEMPOTENT_REQUESTS',
    };
  }
  if (error.name === INVALID_IDEMPOTENCY_KEY_CODE) {
    return {
      kind: 'DETERMINISTIC_REFUSAL',
      failureCode: 'PROVIDER_REFUSED_DETERMINISTIC',
    };
  }

  // Classification par status code.
  const statusCode = error.statusCode;
  if (statusCode !== null) {
    if (statusCode === 429) {
      return {
        kind: 'TRANSIENT_NOT_SENT',
        failureCode: 'PROVIDER_RATE_LIMITED',
      };
    }
    if (statusCode >= 500) {
      return {
        kind: 'UNCERTAIN',
        failureCode: 'PROVIDER_5XX',
      };
    }
    if (statusCode >= 400 && statusCode < 500) {
      return {
        kind: 'DETERMINISTIC_REFUSAL',
        failureCode: 'PROVIDER_REFUSED_DETERMINISTIC',
      };
    }
  }

  // Status code absent ou inattendu → UNCERTAIN (safe).
  return {
    kind: 'UNCERTAIN',
    failureCode: 'PROVIDER_INVALID_RESPONSE',
  };
}

/**
 * Classifie une exception (catch) en EmailSendResult.
 * Classification uniquement depuis error.name, error.code (pas de free-text).
 */
function classifyException(err: unknown): EmailSendResult {
  if (err instanceof Error) {
    if (TIMEOUT_ERROR_NAMES.has(err.name)) {
      return { kind: 'UNCERTAIN', failureCode: 'PROVIDER_TIMEOUT' };
    }
    if (NETWORK_ERROR_NAMES.has(err.name)) {
      return { kind: 'UNCERTAIN', failureCode: 'PROVIDER_NETWORK_ERROR' };
    }
    // Vérifier error.code pour les erreurs Node.js (ENOTFOUND, etc.).
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (TIMEOUT_ERROR_NAMES.has(code)) {
        return { kind: 'UNCERTAIN', failureCode: 'PROVIDER_TIMEOUT' };
      }
      if (NETWORK_ERROR_NAMES.has(code)) {
        return { kind: 'UNCERTAIN', failureCode: 'PROVIDER_NETWORK_ERROR' };
      }
      // TypeError de fetch portant un code réseau connu.
      if (err.name === 'TypeError' && NETWORK_ERROR_NAMES.has(code)) {
        return { kind: 'UNCERTAIN', failureCode: 'PROVIDER_NETWORK_ERROR' };
      }
    }
  }
  return { kind: 'UNCERTAIN', failureCode: 'UNKNOWN_FAILURE_AFTER_CALL_START' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter Resend
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adapter de production Resend pour le port `TransactionalEmailSender`.
 *
 * Câblé au worker exécutable depuis G5H-C2C-B3.
 */
export class ResendTransactionalEmailSender implements TransactionalEmailSender {
  private readonly emails: ResendEmailsLike;
  private readonly config: ResendConfig;

  /**
   * @param config Configuration Resend validée.
   * @param emails Client `resend.emails` injectable. Si absent, un `Resend`
   *   réel est construit depuis la config. Les tests injectent un client factice.
   */
  constructor(config: ResendConfig, emails?: ResendEmailsLike) {
    validateResendConfig(config);
    this.config = config;
    this.emails = emails ?? new Resend(config.apiKey).emails;
  }

  async send(input: EmailInput): Promise<EmailSendResult> {
    // 1. Valider l'input avant tout appel fournisseur.
    const validation = validateEmailInput(input);
    if (validation !== 'OK') {
      // Refus déterministe local — pas d'appel fournisseur.
      return {
        kind: 'DETERMINISTIC_REFUSAL',
        failureCode: validation,
      };
    }

    // 2. Résoudre le templateId depuis le mapping fermé.
    const templateId = resolveTemplateId(input.templateKey, this.config);
    if (templateId === null) {
      return {
        kind: 'DETERMINISTIC_REFUSAL',
        failureCode: 'TEMPLATE_NOT_SUPPORTED',
      };
    }

    // 3. Copie défensive des variables.
    const variablesCopy: Record<string, string | number> = {};
    for (const key of Object.keys(input.variables)) {
      const value = input.variables[key];
      if (typeof value === 'string' || typeof value === 'number') {
        variablesCopy[key] = value;
      }
    }

    // 4. Construire le payload Resend (mode template).
    const payload: ResendSendPayload = {
      from: this.config.fromEmail,
      to: input.recipientEmail,
      template: {
        id: templateId,
        variables: variablesCopy,
      },
    };

    // 5. Construire les options avec la clé d'idempotence.
    const options: ResendSendOptions = {
      idempotencyKey: input.providerIdempotencyKey,
    };

    // 6. Appel fournisseur unique (aucun retry interne).
    let response: ResendSendResponse;
    try {
      response = await this.emails.send(payload, options);
    } catch (err) {
      // Erreur réseau, timeout, ou exception non-Error → classifier.
      // Ne pas transmettre le message brut de l'exception.
      return classifyException(err);
    }

    // 7. Vérifier la réponse.
    if (response == null || typeof response !== 'object') {
      return {
        kind: 'UNCERTAIN',
        failureCode: 'PROVIDER_INVALID_RESPONSE',
      };
    }

    // 8. Si error est non-null → classifier l'erreur.
    if (response.error !== null && response.error !== undefined) {
      return classifyResendError(response.error);
    }

    // 9. Si data est null ou absent → réponse invalide.
    if (response.data === null || response.data === undefined) {
      return {
        kind: 'UNCERTAIN',
        failureCode: 'PROVIDER_INVALID_RESPONSE',
      };
    }

    // 10. Exiger data.id non vide.
    const data = response.data;
    if (typeof data.id !== 'string' || data.id.trim().length === 0) {
      return {
        kind: 'UNCERTAIN',
        failureCode: 'PROVIDER_INVALID_RESPONSE',
      };
    }

    // 11. Succès : retourner { kind: 'SENT', providerMessageId }.
    return {
      kind: 'SENT',
      providerMessageId: data.id,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory depuis process.env (câblée au worker depuis G5H-C2C-B3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construit une ResendConfig depuis les variables d'environnement.
 *
 * Variables attendues :
 * - RESEND_API_KEY
 * - RESEND_FROM_EMAIL
 * - RESEND_BOOKING_CONFIRMED_TEMPLATE_ID
 *
 * @throws {ResendConfigError} si une variable est absente ou invalide. Les
 *   messages ne contiennent jamais la valeur reçue.
 *
 * Appelée depuis `createWorkerDependenciesFromEnv` depuis G5H-C2C-B3.
 */
export function createResendConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ResendConfig {
  const config: ResendConfig = {
    apiKey: env.RESEND_API_KEY ?? '',
    fromEmail: env.RESEND_FROM_EMAIL ?? '',
    bookingConfirmedTemplateId: env.RESEND_BOOKING_CONFIRMED_TEMPLATE_ID ?? '',
  };
  validateResendConfig(config);
  return config;
}

/**
 * Construit un ResendTransactionalEmailSender depuis les variables d'environnement.
 *
 * Appelée depuis `createWorkerDependenciesFromEnv` depuis G5H-C2C-B3.
 */
export function createResendTransactionalEmailSenderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResendTransactionalEmailSender {
  const config = createResendConfigFromEnv(env);
  return new ResendTransactionalEmailSender(config);
}
