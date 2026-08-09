/**
 * @uttily/core — Validation stricte du EmailSendResult à l'exécution (G5H-C2B, ADR-013 §13.4).
 *
 * Parseur PUR et FERMÉ : aucune dépendance externe, aucun effet de bord.
 * Les messages d'erreur ne contiennent JAMAIS la valeur reçue (confidentialité).
 *
 * Règles de validation :
 * 1. Type object (non-null, non-array).
 * 2. Propriété `kind` ∈ {SENT, DETERMINISTIC_REFUSAL, TRANSIENT_NOT_SENT, UNCERTAIN}.
 * 3. SENT : exactement {kind, providerMessageId}, providerMessageId valide.
 * 4. DETERMINISTIC_REFUSAL : exactement {kind, failureCode}, failureCode ∈ les 4 codes.
 * 5. TRANSIENT_NOT_SENT : exactement {kind, failureCode}, failureCode ∈ les 2 codes.
 * 6. UNCERTAIN : exactement {kind, failureCode}, failureCode ∈ les 5 codes.
 * 7. Aucune propriété supplémentaire sur aucune variante.
 */

import { parseProviderMessageId } from './provider-message-id';
import type {
  EmailSendResult,
  EmailDeterministicFailureCode,
  EmailTransientFailureCode,
  EmailUncertainFailureCode,
} from './types';

const DETERMINISTIC_CODES: ReadonlySet<string> = new Set([
  'INVALID_RECIPIENT',
  'TEMPLATE_NOT_SUPPORTED',
  'PROVIDER_REFUSED_DETERMINISTIC',
  'IDEMPOTENT_PAYLOAD_CONFLICT',
]);

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'CONCURRENT_IDEMPOTENT_REQUESTS',
  'PROVIDER_RATE_LIMITED',
]);

const UNCERTAIN_CODES: ReadonlySet<string> = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_NETWORK_ERROR',
  'PROVIDER_5XX',
  'PROVIDER_INVALID_RESPONSE',
  'UNKNOWN_FAILURE_AFTER_CALL_START',
]);

const SENT_KEYS: ReadonlySet<string> = new Set(['kind', 'providerMessageId']);
const FAILURE_KEYS: ReadonlySet<string> = new Set(['kind', 'failureCode']);

function checkKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error('EMAIL_RESULT_INVALID: propriété supplémentaire');
    }
  }
}

/**
 * Valide un EmailSendResult reçu depuis le fournisseur à l'exécution.
 *
 * @param raw La valeur brute reçue (type `unknown` pour validation défensive).
 * @returns `{ ok: true; result: EmailSendResult }` si valide (résultat normalisé).
 * @throws Error('EMAIL_RESULT_INVALID: ...') si invalide.
 *         Les messages d'erreur ne contiennent JAMAIS la valeur reçue.
 */
export function validateEmailResult(raw: unknown): { ok: true; result: EmailSendResult } {
  // 1. Type object (non-null, non-array).
  if (raw === null || raw === undefined) {
    throw new Error('EMAIL_RESULT_INVALID: null ou undefined');
  }
  if (typeof raw !== 'object') {
    throw new Error('EMAIL_RESULT_INVALID: type incorrect');
  }
  if (Array.isArray(raw)) {
    throw new Error('EMAIL_RESULT_INVALID: tableau non autorisé');
  }

  const obj = raw as Record<string, unknown>;

  // 2. Propriété `kind` string.
  if (typeof obj.kind !== 'string') {
    throw new Error('EMAIL_RESULT_INVALID: kind manquant ou non-string');
  }

  switch (obj.kind) {
    case 'SENT': {
      checkKeys(obj, SENT_KEYS);
      if (obj.providerMessageId === undefined) {
        throw new Error('EMAIL_RESULT_INVALID: providerMessageId manquant');
      }
      const providerMessageId = parseProviderMessageId(obj.providerMessageId);
      return { ok: true, result: { kind: 'SENT', providerMessageId } };
    }
    case 'DETERMINISTIC_REFUSAL': {
      checkKeys(obj, FAILURE_KEYS);
      if (typeof obj.failureCode !== 'string' || !DETERMINISTIC_CODES.has(obj.failureCode)) {
        throw new Error('EMAIL_RESULT_INVALID: failureCode invalide pour DETERMINISTIC_REFUSAL');
      }
      return {
        ok: true,
        result: {
          kind: 'DETERMINISTIC_REFUSAL',
          failureCode: obj.failureCode as EmailDeterministicFailureCode,
        },
      };
    }
    case 'TRANSIENT_NOT_SENT': {
      checkKeys(obj, FAILURE_KEYS);
      if (typeof obj.failureCode !== 'string' || !TRANSIENT_CODES.has(obj.failureCode)) {
        throw new Error('EMAIL_RESULT_INVALID: failureCode invalide pour TRANSIENT_NOT_SENT');
      }
      return {
        ok: true,
        result: {
          kind: 'TRANSIENT_NOT_SENT',
          failureCode: obj.failureCode as EmailTransientFailureCode,
        },
      };
    }
    case 'UNCERTAIN': {
      checkKeys(obj, FAILURE_KEYS);
      if (typeof obj.failureCode !== 'string' || !UNCERTAIN_CODES.has(obj.failureCode)) {
        throw new Error('EMAIL_RESULT_INVALID: failureCode invalide pour UNCERTAIN');
      }
      return {
        ok: true,
        result: {
          kind: 'UNCERTAIN',
          failureCode: obj.failureCode as EmailUncertainFailureCode,
        },
      };
    }
    default:
      throw new Error('EMAIL_RESULT_INVALID: kind incorrect');
  }
}
