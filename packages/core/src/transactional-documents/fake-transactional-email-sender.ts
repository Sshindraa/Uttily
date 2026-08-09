/**
 * @uttily/core — Fake déterministe en mémoire pour TransactionalEmailSender
 * (G5H-C2B, ADR-013 §13.4).
 *
 * NE JAMAIS utiliser en production. Fake en mémoire pour tests uniquement.
 * Aucun réseau, aucun SDK, aucune horloge interne.
 *
 * Comportement idempotent :
 * - Premier send avec une providerIdempotencyKey → SENT, providerMessageId déterministe.
 * - Replay même clé + même payload → même providerMessageId (déduplication).
 * - Même clé + payload différent → DETERMINISTIC_REFUSAL / IDEMPOTENT_PAYLOAD_CONFLICT.
 * - Clé vide ou blanche → DETERMINISTIC_REFUSAL / PROVIDER_REFUSED_DETERMINISTIC.
 * - Injection de résultats contrôlable : setNextResult / setNextResults.
 *
 * Confidentialité :
 * - Aucun PII (email, nom, adresse) n'apparaît dans les messages d'erreur.
 * - Le fingerprint interne (en mémoire, jamais logué) inclut recipientEmail
 *   pour la détection de conflit, mais n'est jamais exposé.
 *
 * Copies défensives :
 * - Chaque appel à `calls` retourne de NOUVELLES copies (profondes pour variables).
 * - L'input original ne peut pas être muté rétroactivement.
 * - Une copie retournée par `calls` ne peut pas être mutée pour corrompre l'état interne.
 *
 * Empreinte canonique :
 * - Les clés des variables sont triées avant comparaison.
 * - Deux objets variables sémantiquement identiques avec un ordre d'insertion
 *   différent sont considérés comme identiques.
 */

import type { TransactionalEmailSender } from './ports';
import type { EmailInput, EmailSendResult } from './types';

/** Injection pour setNextResult (rétro-compatible). */
export type FakeEmailInjection =
  EmailSendResult | { readonly kind: 'THROW_ERROR' } | { readonly kind: 'THROW_NON_ERROR' };

/**
 * Fake en mémoire pour TransactionalEmailSender.
 *
 * NE JAMAIS utiliser en production.
 */
export class FakeTransactionalEmailSender implements TransactionalEmailSender {
  /** Store interne : providerIdempotencyKey → { providerMessageId, inputFingerprint }. */
  private readonly sentEmails = new Map<
    string,
    { providerMessageId: string; inputFingerprint: string }
  >();

  /** Suivi des appels techniques (copies défensives profondes). */
  private readonly _calls: EmailInput[] = [];

  /**
   * Accès en lecture seule aux appels techniques.
   * Retourne de NOUVELLES copies défensives à chaque accès (y compris variables).
   * Muter une copie retournée n'affecte pas l'état interne.
   */
  get calls(): readonly EmailInput[] {
    return this._calls.map((c) => this.deepCopyInput(c));
  }

  /** Nombre d'appels send() qui n'ont PAS abouti à un SENT. */
  private failedCallCount = 0;

  /** Injection de résultat pour les prochains appels (EmailSendResult, Error ou non-Error). */
  private nextInjections: unknown[] = [];

  /** Préfixe du providerMessageId déterministe. */
  private readonly messageIdPrefix: string;

  constructor(opts: { messageIdPrefix?: string } = {}) {
    this.messageIdPrefix = opts.messageIdPrefix ?? 'fake-msg-';
  }

  async send(input: EmailInput): Promise<EmailSendResult> {
    // Copie défensive profonde de l'input et stockage pour sendCallCount.
    const inputCopy = this.deepCopyInput(input);
    this._calls.push(inputCopy);

    // Injection configurée pour le prochain appel (priorité la plus haute).
    const injection = this.nextInjections.shift();
    if (injection !== undefined) {
      return this.applyInjection(input, injection);
    }

    // Clé d'idempotence vide ou blanche : refus déterministe, pas d'exception.
    if (!input.providerIdempotencyKey || input.providerIdempotencyKey.trim().length === 0) {
      this.failedCallCount++;
      return {
        kind: 'DETERMINISTIC_REFUSAL',
        failureCode: 'PROVIDER_REFUSED_DETERMINISTIC',
      };
    }

    // Vérifier les doublons de providerIdempotencyKey.
    const existing = this.sentEmails.get(input.providerIdempotencyKey);
    if (existing) {
      // Même clé — vérifier si le payload correspond (empreinte canonique).
      const currentFingerprint = this.fingerprint(input);
      if (existing.inputFingerprint !== currentFingerprint) {
        // Même clé, payload différent → DETERMINISTIC_REFUSAL (no throw).
        this.failedCallCount++;
        return {
          kind: 'DETERMINISTIC_REFUSAL',
          failureCode: 'IDEMPOTENT_PAYLOAD_CONFLICT',
        };
      }
      // Même clé, même payload → retourner le même providerMessageId (déduplication).
      return { kind: 'SENT', providerMessageId: existing.providerMessageId };
    }

    // Générer un providerMessageId déterministe à partir de la clé d'idempotence.
    const providerMessageId = this.messageIdPrefix + input.providerIdempotencyKey;

    // Stocker l'email avec son empreinte canonique.
    this.sentEmails.set(input.providerIdempotencyKey, {
      providerMessageId,
      inputFingerprint: this.fingerprint(input),
    });

    return { kind: 'SENT', providerMessageId };
  }

  /**
   * Applique une injection et met à jour les compteurs / le store selon le résultat.
   * Les Error sont propagées, tout autre non-Error est jeté tel quel.
   */
  private applyInjection(input: EmailInput, value: unknown): EmailSendResult {
    if (value instanceof Error) {
      this.failedCallCount++;
      throw value;
    }

    const isResultLike =
      typeof value === 'object' &&
      value !== null &&
      'kind' in value &&
      typeof (value as Record<string, unknown>).kind === 'string';

    if (!isResultLike) {
      this.failedCallCount++;
      throw value;
    }

    const result = value as EmailSendResult;
    if (result.kind !== 'SENT') {
      this.failedCallCount++;
      return result;
    }

    // On ne stocke que les SENT avec un providerMessageId non vide.
    if (result.providerMessageId.length > 0) {
      this.sentEmails.set(input.providerIdempotencyKey, {
        providerMessageId: result.providerMessageId,
        inputFingerprint: this.fingerprint(input),
      });
    }
    return result;
  }

  /**
   * Configure le prochain (ou les N prochains) appel(s) avec un résultat injecté.
   * Peut être un EmailSendResult, { kind: 'THROW_ERROR' } ou { kind: 'THROW_NON_ERROR' }.
   */
  setNextResult(injection: FakeEmailInjection): void {
    if (injection.kind === 'THROW_ERROR') {
      this.nextInjections.push(new Error('INJECTED_ERROR: échec inattendu injecté'));
      return;
    }
    if (injection.kind === 'THROW_NON_ERROR') {
      this.nextInjections.push('INJECTED_NON_ERROR');
      return;
    }
    this.nextInjections.push(injection);
  }

  /**
   * Configure une liste de résultats pour les prochains appels.
   * - EmailSendResult : retourné tel quel.
   * - Error : propagée (jetée).
   * - Toute autre valeur : jetée telle quelle (test de catch défensif).
   */
  setNextResults(results: Array<EmailSendResult | Error | unknown>): void {
    for (const result of results) {
      this.nextInjections.push(result);
    }
  }

  /** Configure les N prochains appels pour échouer avec une erreur transitoire. */
  failNext(n: number): void {
    for (let i = 0; i < n; i++) {
      this.nextInjections.push(new Error('EMAIL_SEND_FAILED: échec transitoire injecté'));
    }
  }

  /** Configure le prochain appel pour retourner un résultat invalide (providerMessageId vide). */
  returnInvalidResultNext(): void {
    this.nextInjections.push({ kind: 'SENT', providerMessageId: '' });
  }

  /** Nombre d'emails logiques uniques acceptés (SENT non vides). */
  get uniqueEmailCount(): number {
    return this.sentEmails.size;
  }

  /** Nombre d'appels techniques send(). */
  get sendCallCount(): number {
    return this._calls.length;
  }

  /** Nombre d'appels send() qui n'ont PAS abouti à un SENT. */
  get failedCount(): number {
    return this.failedCallCount;
  }

  /** Vérifie si une providerIdempotencyKey spécifique a été acceptée. */
  wasSent(providerIdempotencyKey: string): boolean {
    return this.sentEmails.has(providerIdempotencyKey);
  }

  /** Retourne le providerMessageId pour une clé spécifique, ou undefined. */
  getProviderMessageId(providerIdempotencyKey: string): string | undefined {
    return this.sentEmails.get(providerIdempotencyKey)?.providerMessageId;
  }

  /**
   * Empreinte canonique pour la comparaison de déduplication (en mémoire uniquement,
   * jamais persisté en DB ni logué). Inclut recipientEmail pour la détection
   * de conflit : la même clé avec un recipientEmail différent est un conflit.
   *
   * Les clés des variables sont triées pour garantir que deux objets variables
   * sémantiquement identiques avec un ordre d'insertion différent produisent
   * la même empreinte.
   */
  private fingerprint(input: EmailInput): string {
    const sortedVariables: Record<string, string | number> = {};
    const keys = Object.keys(input.variables).sort();
    for (const key of keys) {
      sortedVariables[key] = input.variables[key] as string | number;
    }
    return JSON.stringify({
      recipientEmail: input.recipientEmail,
      templateKey: input.templateKey,
      variables: sortedVariables,
    });
  }

  /**
   * Copie défensive profonde d'un EmailInput.
   * Crée un nouvel objet avec une copie profonde des variables.
   */
  private deepCopyInput(input: EmailInput): EmailInput {
    return {
      recipientEmail: input.recipientEmail,
      templateKey: input.templateKey,
      providerIdempotencyKey: input.providerIdempotencyKey,
      variables: { ...input.variables },
    };
  }

  /** Réinitialise tout l'état pour la réutilisation dans les tests. */
  reset(): void {
    this.sentEmails.clear();
    this._calls.length = 0;
    this.failedCallCount = 0;
    this.nextInjections = [];
  }
}
