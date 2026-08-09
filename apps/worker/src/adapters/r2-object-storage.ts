/**
 * @uttily/worker — Adapter de production Cloudflare R2 pour ObjectStorage
 * (G5H-A, ADR-014 §2.4).
 *
 * Cloudflare R2 expose une API compatible S3. Cet adapter utilise
 * `@aws-sdk/client-s3` avec un endpoint R2 personnalisé.
 *
 * Caractéristiques :
 * - Bucket privé, juridiction `eu` (configurée côté Cloudflare, pas ici).
 * - `putIfAbsent` utilise une écriture conditionnelle atomique
 *   (`IfNoneMatch: '*'`).
 * - Aucun overwrite autorisé. Un objet existant avec un checksum différent est
 *   une anomalie traitée par le pipeline G5D (Q15 reste ouverte).
 * - Aucun bucket versioning natif (R2 ne le fournit pas).
 * - Aucun téléchargement public ni URL signée dans ce lot (Q9 reste ouverte).
 * - Le checksum SHA-256 hex est stocké dans les custom metadata Uttily, pas
 *   comme `ChecksumSHA256` AWS (qui attend du base64).
 * - Aucune configuration lue au module load.
 * - Aucun logging dans l'adapter.
 * - Les erreurs ne contiennent jamais de secret, credential, bucket, key,
 *   endpoint ou request ID.
 *
 * Câblé au worker exécutable depuis G5H-C2C-B3. La factory
 * `createR2ObjectStorageFromEnv` est appelée depuis
 * `createWorkerDependenciesFromEnv`.
 */

import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { ObjectStorage } from '@uttily/core';
import type { ObjectStoragePutResult, StoredObjectMetadata } from '@uttily/core';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration R2 validée. Toutes les valeurs sont non vides et bornées.
 * Ne contient jamais de valeur par défaut — l'appelant doit fournir toutes
 * les valeurs.
 */
export interface R2Config {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucketName: string;
}

/**
 * Format strict pour l'accountId R2 : alphanumérique, 6 à 64 caractères.
 * Les accountIds Cloudflare sont des hex strings de longueur variable.
 */
const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9]{6,64}$/;

/**
 * Nom de bucket S3/R2 : 3 à 63 caractères, alphanumériques, tirets et points.
 */
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * Métadonnée personnalisée Uttily pour le checksum SHA-256 hex.
 */
const METADATA_KEY_CHECKSUM = 'uttily-checksum-sha256';

/**
 * Métadonnée personnalisée Uttily pour la taille en décimal.
 */
const METADATA_KEY_SIZE = 'uttily-size-bytes';

/**
 * Erreur de configuration R2. Ne contient jamais de secret ou credential.
 */
export class R2ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'R2ConfigError';
  }
}

/**
 * Valide une configuration R2. Toutes les valeurs doivent être non vides,
 * non whitespace, et respecter les formats stricts.
 *
 * @throws {R2ConfigError} si la configuration est invalide. Les messages
 *   ne contiennent jamais la valeur reçue, le secret, ou le credential.
 */
export function validateR2Config(config: R2Config): void {
  if (
    !config.accountId ||
    config.accountId.trim() !== config.accountId ||
    !config.accountId.trim()
  ) {
    throw new R2ConfigError(
      'R2_ACCOUNT_ID est requis et ne doit pas être vide ou contenir uniquement des espaces.',
    );
  }
  if (!ACCOUNT_ID_PATTERN.test(config.accountId)) {
    throw new R2ConfigError(
      'R2_ACCOUNT_ID a un format invalide. Attendu : alphanumérique, 6 à 64 caractères.',
    );
  }

  if (
    !config.accessKeyId ||
    config.accessKeyId.trim() !== config.accessKeyId ||
    !config.accessKeyId.trim()
  ) {
    throw new R2ConfigError(
      'R2_ACCESS_KEY_ID est requis et ne doit pas être vide ou contenir uniquement des espaces.',
    );
  }

  if (
    !config.secretAccessKey ||
    config.secretAccessKey.trim() !== config.secretAccessKey ||
    !config.secretAccessKey.trim()
  ) {
    throw new R2ConfigError(
      'R2_SECRET_ACCESS_KEY est requis et ne doit pas être vide ou contenir uniquement des espaces.',
    );
  }

  if (
    !config.bucketName ||
    config.bucketName.trim() !== config.bucketName ||
    !config.bucketName.trim()
  ) {
    throw new R2ConfigError(
      'R2_BUCKET_NAME est requis et ne doit pas être vide ou contenir uniquement des espaces.',
    );
  }
  if (!BUCKET_NAME_PATTERN.test(config.bucketName)) {
    throw new R2ConfigError(
      'R2_BUCKET_NAME a un format invalide. Attendu : 3 à 63 caractères, minuscules, ' +
        'alphanumériques, tirets et points.',
    );
  }
}

/**
 * Construit la configuration S3Client pour R2 à partir d'une R2Config validée.
 */
function buildS3ClientConfig(config: R2Config): S3ClientConfig {
  return {
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    region: 'auto',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Erreurs d'infrastructure
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Type fermé d'erreur d'infrastructure R2. Aucune donnée sensible.
 */
export type R2ErrorCode =
  | 'CONFIG_INVALID'
  | 'CONDITIONAL_CONFLICT_TRANSIENT'
  | 'PROVIDER_TRANSIENT'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'OBJECT_NOT_FOUND';

export class R2StorageError extends Error {
  readonly code: R2ErrorCode;

  constructor(code: R2ErrorCode, message: string) {
    super(message);
    this.name = 'R2StorageError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Abstraction minimale pour testabilité
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstraction minimale compatible avec `S3Client.send()`. Permet l'injection
 * d'un client factice dans les tests sans mocker globalement le SDK.
 */
export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
  destroy?(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilitaires
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vérifie si une erreur AWS SDK est de type `NotFound` / `NoSuchKey` (404).
 */
function isNotFoundError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;
  const e = error as Record<string, unknown>;
  const name = e.name;
  if (name === 'NotFound' || name === 'NoSuchKey') return true;
  // Vérifier $metadata.httpStatusCode
  const metadata = e.$metadata as Record<string, unknown> | undefined;
  if (metadata && metadata.httpStatusCode === 404) return true;
  return false;
}

/**
 * Vérifie si une erreur AWS SDK est un `PreconditionFailed` (412).
 */
function isPreconditionFailedError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;
  const e = error as Record<string, unknown>;
  const name = e.name;
  if (name === 'PreconditionFailed' || name === 'ConditionalPutFailed') return true;
  const metadata = e.$metadata as Record<string, unknown> | undefined;
  if (metadata && metadata.httpStatusCode === 412) return true;
  return false;
}

/**
 * Vérifie si une erreur AWS SDK est un conflit conditionnel concurrent (409).
 * R2/S3 peut retourner 409 pour un conflit conditionnel concurrent.
 */
function isConditionalConflictError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;
  const e = error as Record<string, unknown>;
  const name = e.name;
  if (name === 'Conflict' || name === 'ConditionalPutFailed') return true;
  const metadata = e.$metadata as Record<string, unknown> | undefined;
  if (metadata && metadata.httpStatusCode === 409) return true;
  return false;
}

/**
 * Copie défensive d'un Uint8Array.
 */
function defensiveCopy(input: Uint8Array): Uint8Array {
  const copy = new Uint8Array(input.length);
  copy.set(input);
  return copy;
}

/**
 * Valide qu'un nombre est un safe integer positif ou nul.
 */
function isValidSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Valide qu'une chaîne est un checksum SHA-256 hex valide (64 caractères hex).
 */
function isValidChecksumHex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter R2
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adapter de production Cloudflare R2 pour le port `ObjectStorage`.
 *
 * Câblé au worker exécutable depuis G5H-C2C-B3.
 */
export class R2ObjectStorage implements ObjectStorage {
  private readonly client: S3ClientLike;
  private readonly bucketName: string;
  private closed = false;

  /**
   * @param config Configuration R2 validée.
   * @param client Client S3 injectable. Si absent, un `S3Client` réel est
   *   construit depuis la config. Les tests injectent un client factice.
   */
  constructor(config: R2Config, client?: S3ClientLike) {
    validateR2Config(config);
    this.bucketName = config.bucketName;
    this.client = client ?? new S3Client(buildS3ClientConfig(config));
  }

  /**
   * Ferme les ressources sous-jacentes du client S3 (sockets).
   * Idempotente : appeler plusieurs fois n'appelle destroy() qu'une seule fois.
   * Ne modifie pas le port métier ObjectStorage.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.client && typeof (this.client as S3ClientLike).destroy === 'function') {
      (this.client as S3ClientLike).destroy!();
    }
  }

  async putIfAbsent(input: {
    readonly key: string;
    readonly content: Uint8Array;
    readonly contentType: string;
    readonly checksumSha256: string;
    readonly sizeBytes: number;
  }): Promise<ObjectStoragePutResult> {
    // Copie défensive du Body avant tout envoi.
    const bodyCopy = defensiveCopy(input.content);

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: input.key,
      Body: bodyCopy,
      ContentType: input.contentType,
      ContentLength: input.sizeBytes,
      IfNoneMatch: '*',
      Metadata: {
        [METADATA_KEY_CHECKSUM]: input.checksumSha256,
        [METADATA_KEY_SIZE]: String(input.sizeBytes),
      },
    });

    let response: unknown;
    try {
      response = await this.client.send(command);
    } catch (error) {
      // 412 PreconditionFailed → l'objet existe déjà.
      if (isPreconditionFailedError(error)) {
        return this.handleAlreadyExists(input.key);
      }
      // 409 Conflict → conflit conditionnel concurrent (transitoire).
      if (isConditionalConflictError(error)) {
        throw new R2StorageError(
          'CONDITIONAL_CONFLICT_TRANSIENT',
          'Conflit conditionnel concurrent lors de l écriture. ' +
            "Le pipeline doit réessayer. Aucune donnée n'a été écrasée.",
        );
      }
      // Autre erreur fournisseur → erreur transitoire nettoyée.
      throw new R2StorageError(
        'PROVIDER_TRANSIENT',
        'Erreur transitoire du fournisseur de stockage lors de l écriture. ' +
          "Aucune donnée sensible n'est incluse dans ce message.",
      );
    }

    // Succès PutObject → CREATED.
    // On ne fait pas confiance au contenu de response (peut varier), on
    // valide juste que l'appel a réussi sans exception.
    void response;
    return { kind: 'CREATED' };
  }

  /**
   * Gère le cas où putIfAbsent reçoit un 412 (objet existant).
   * Lit les métadonnées avec HEAD et retourne ALREADY_EXISTS.
   */
  private async handleAlreadyExists(key: string): Promise<ObjectStoragePutResult> {
    const metadata = await this.head(key);
    if (metadata === null) {
      // L'objet a été supprimé entre le PUT et le HEAD — situation anormale.
      // On retourne une erreur transitoire pour que le pipeline réessaie.
      throw new R2StorageError(
        'PROVIDER_TRANSIENT',
        "L'objet existait lors de l écriture conditionnelle mais est introuvable " +
          'lors de la lecture des métadonnées. Le pipeline doit réessayer.',
      );
    }
    return { kind: 'ALREADY_EXISTS', metadata };
  }

  async head(key: string): Promise<StoredObjectMetadata | null> {
    const command = new HeadObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    let response: unknown;
    try {
      response = await this.client.send(command);
    } catch (error) {
      // 404 → null.
      if (isNotFoundError(error)) {
        return null;
      }
      // Autre erreur fournisseur → erreur transitoire nettoyée.
      throw new R2StorageError(
        'PROVIDER_TRANSIENT',
        'Erreur transitoire du fournisseur de stockage lors de la lecture des métadonnées. ' +
          "Aucune donnée sensible n'est incluse dans ce message.",
      );
    }

    // Extraire les métadonnées de la réponse.
    if (response == null || typeof response !== 'object') {
      throw new R2StorageError(
        'PROVIDER_INVALID_RESPONSE',
        'Réponse du fournisseur invalide lors de la lecture des métadonnées.',
      );
    }

    const resp = response as Record<string, unknown>;
    const contentType = resp.ContentType;
    const contentLength = resp.ContentLength;
    const metadata = resp.Metadata as Record<string, unknown> | undefined;

    if (typeof contentType !== 'string' || contentType.length === 0) {
      throw new R2StorageError(
        'PROVIDER_INVALID_RESPONSE',
        'ContentType absent ou invalide dans la réponse du fournisseur.',
      );
    }

    if (!isValidSize(contentLength)) {
      throw new R2StorageError(
        'PROVIDER_INVALID_RESPONSE',
        'ContentLength absent, négatif ou non entier dans la réponse du fournisseur.',
      );
    }

    // Checksum depuis les custom metadata Uttily, ou null si absent/invalide.
    const checksumRaw = metadata?.[METADATA_KEY_CHECKSUM];
    const checksumSha256 = isValidChecksumHex(checksumRaw) ? checksumRaw : null;

    return {
      contentType,
      sizeBytes: contentLength,
      checksumSha256,
    };
  }

  async get(key: string): Promise<Uint8Array> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    let response: unknown;
    try {
      response = await this.client.send(command);
    } catch (error) {
      // 404 → erreur introuvable nettoyée.
      if (isNotFoundError(error)) {
        throw new R2StorageError(
          'OBJECT_NOT_FOUND',
          "L'objet demandé est introuvable dans le stockage.",
        );
      }
      // Autre erreur fournisseur → erreur transitoire nettoyée.
      throw new R2StorageError(
        'PROVIDER_TRANSIENT',
        'Erreur transitoire du fournisseur de stockage lors de la lecture de l objet. ' +
          "Aucune donnée sensible n'est incluse dans ce message.",
      );
    }

    if (response == null || typeof response !== 'object') {
      throw new R2StorageError(
        'PROVIDER_INVALID_RESPONSE',
        'Réponse du fournisseur invalide lors de la lecture de l objet.',
      );
    }

    const resp = response as Record<string, unknown>;
    const body = resp.Body;

    if (body == null) {
      throw new R2StorageError(
        'PROVIDER_INVALID_RESPONSE',
        'Body absent dans la réponse du fournisseur.',
      );
    }

    // Convertir le body SDK en Uint8Array.
    // Le SDK peut retourner un Stream, un Blob, ou un Uint8Array selon la
    // plateforme. On gère les cas principaux.
    const bytes = await convertBodyToUint8Array(body);
    return defensiveCopy(bytes);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversion du body SDK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convertit un body SDK (Stream, Blob, Uint8Array, string) en Uint8Array.
 * @throws {R2StorageError} si le body n'est pas lisible.
 */
async function convertBodyToUint8Array(body: unknown): Promise<Uint8Array> {
  // Cas 1 : déjà un Uint8Array (ou Buffer qui est un Uint8Array).
  if (body instanceof Uint8Array) {
    return body;
  }

  // Cas 2 : string — encoder en UTF-8.
  if (typeof body === 'string') {
    return new TextEncoder().encode(body);
  }

  // Cas 3 : Blob — utiliser arrayBuffer().
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    const buffer = await body.arrayBuffer();
    return new Uint8Array(buffer);
  }

  // Cas 4 : ReadableStream — consommer avec un reader.
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return readReadableStream(body);
  }

  // Cas 5 : objet avec une méthode transformToByteArray (SDK v3 Node).
  if (
    body != null &&
    typeof body === 'object' &&
    typeof (body as Record<string, unknown>).transformToByteArray === 'function'
  ) {
    const bytes = await (
      body as { transformToByteArray(): Promise<Uint8Array> }
    ).transformToByteArray();
    return bytes;
  }

  // Cas 6 : objet avec une méthode arrayBuffer (ReadableStream-like).
  if (
    body != null &&
    typeof body === 'object' &&
    typeof (body as Record<string, unknown>).arrayBuffer === 'function'
  ) {
    const buffer = await (body as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer();
    return new Uint8Array(buffer);
  }

  throw new R2StorageError(
    'PROVIDER_INVALID_RESPONSE',
    'Body du fournisseur dans un format non lisible.',
  );
}

/**
 * Consomme un ReadableStream et retourne un Uint8Array.
 */
async function readReadableStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalLength += value.length;
    }
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory depuis process.env (câblée au worker depuis G5H-C2C-B3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construit une R2Config depuis les variables d'environnement.
 *
 * Variables attendues :
 * - R2_ACCOUNT_ID
 * - R2_ACCESS_KEY_ID
 * - R2_SECRET_ACCESS_KEY
 * - R2_BUCKET_NAME
 *
 * @throws {R2ConfigError} si une variable est absente ou invalide. Les
 *   messages ne contiennent jamais la valeur reçue.
 *
 * Appelée depuis `createWorkerDependenciesFromEnv` depuis G5H-C2C-B3.
 */
export function createR2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): R2Config {
  const config: R2Config = {
    accountId: env.R2_ACCOUNT_ID ?? '',
    accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
    bucketName: env.R2_BUCKET_NAME ?? '',
  };
  validateR2Config(config);
  return config;
}

/**
 * Construit un R2ObjectStorage depuis les variables d'environnement.
 *
 * Appelée depuis `createWorkerDependenciesFromEnv` depuis G5H-C2C-B3.
 */
export function createR2ObjectStorageFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): R2ObjectStorage {
  const config = createR2ConfigFromEnv(env);
  return new R2ObjectStorage(config);
}
