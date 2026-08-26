import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  ProductPhotoStorage,
  ProductPhotoStorageMetadata,
  ProductPhotoStoragePutResult,
} from '@uttily/core';

const ACCOUNT_ID_RE = /^[a-zA-Z0-9]{6,64}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** Adapter serveur R2 pour les photos produit. Aucun accès depuis le client. */
class R2ProductPhotoStorage implements ProductPhotoStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async putIfAbsent(input: {
    readonly key: string;
    readonly content: Uint8Array;
    readonly contentType: string;
    readonly checksumSha256: string;
    readonly sizeBytes: number;
  }): Promise<ProductPhotoStoragePutResult> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          Body: new Uint8Array(input.content),
          ContentType: input.contentType,
          ContentLength: input.sizeBytes,
          IfNoneMatch: '*',
          Metadata: { 'uttily-checksum-sha256': input.checksumSha256 },
        }),
      );
      return { kind: 'CREATED' };
    } catch (error) {
      if (isHttpError(error, 412)) {
        const metadata = await this.head(input.key);
        if (!metadata) throw new Error('Objet photo absent après un conflit conditionnel.');
        return { kind: 'ALREADY_EXISTS', metadata };
      }
      throw new Error('Écriture R2 indisponible.');
    }
  }

  async head(key: string): Promise<ProductPhotoStorageMetadata | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (typeof response.ContentType !== 'string' || typeof response.ContentLength !== 'number') {
        throw new Error('Métadonnées R2 invalides.');
      }
      const checksum = response.Metadata?.['uttily-checksum-sha256'] ?? null;
      return {
        contentType: response.ContentType,
        sizeBytes: response.ContentLength,
        checksumSha256: typeof checksum === 'string' ? checksum : null,
      };
    } catch (error) {
      if (isHttpError(error, 404)) return null;
      throw new Error('Lecture R2 indisponible.');
    }
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body || typeof response.Body.transformToByteArray !== 'function') {
        throw new Error('Corps R2 invalide.');
      }
      return new Uint8Array(await response.Body.transformToByteArray());
    } catch (error) {
      if (isHttpError(error, 404)) throw new Error('Objet photo introuvable.');
      throw new Error('Lecture R2 indisponible.');
    }
  }

  async deleteIfPresent(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isHttpError(error, 404)) return;
      throw new Error('Suppression R2 indisponible.');
    }
  }
}

function isHttpError(error: unknown, status: number): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { $metadata?: { httpStatusCode?: number }; name?: string };
  return (
    value.$metadata?.httpStatusCode === status ||
    (status === 404 && (value.name === 'NotFound' || value.name === 'NoSuchKey')) ||
    (status === 412 &&
      (value.name === 'PreconditionFailed' || value.name === 'ConditionalPutFailed'))
  );
}

function readR2Config(env: NodeJS.ProcessEnv = process.env): {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
} {
  const accountId = env.R2_ACCOUNT_ID ?? '';
  const accessKeyId = env.R2_ACCESS_KEY_ID ?? '';
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY ?? '';
  const bucket = env.R2_PHOTOS_BUCKET_NAME ?? env.R2_BUCKET_NAME ?? '';
  if (
    !ACCOUNT_ID_RE.test(accountId) ||
    !accessKeyId.trim() ||
    !secretAccessKey.trim() ||
    !BUCKET_RE.test(bucket)
  ) {
    throw new Error('Le stockage des photos n’est pas configuré.');
  }
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

export function getProductPhotoStorage(env: NodeJS.ProcessEnv = process.env): ProductPhotoStorage {
  const config = readR2Config(env);
  return new R2ProductPhotoStorage(
    new S3Client({
      endpoint: `https://${config.accountId}.eu.r2.cloudflarestorage.com`,
      region: 'auto',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    }),
    config.bucket,
  );
}
