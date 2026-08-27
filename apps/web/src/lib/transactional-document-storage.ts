import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

const ACCOUNT_ID_RE = /^[a-zA-Z0-9]{6,64}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export interface TransactionalDocumentStorage {
  get(key: string): Promise<Uint8Array>;
}

class R2TransactionalDocumentStorage implements TransactionalDocumentStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async get(key: string): Promise<Uint8Array> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body) throw new Error('Contenu de document R2 absent.');
      return await response.Body.transformToByteArray();
    } catch (error) {
      if (isHttpError(error, 404)) throw new Error('Document introuvable sur le stockage R2.');
      throw new Error('Lecture du document R2 indisponible.');
    }
  }
}

function isHttpError(error: unknown, status: number): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { $metadata?: { httpStatusCode?: number }; name?: string };
  return (
    value.$metadata?.httpStatusCode === status ||
    (status === 404 && (value.name === 'NotFound' || value.name === 'NoSuchKey'))
  );
}

function readR2DocumentConfig(env: NodeJS.ProcessEnv = process.env): {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
} {
  const accountId = env['R2_ACCOUNT_ID'] ?? '';
  const accessKeyId = env['R2_ACCESS_KEY_ID'] ?? '';
  const secretAccessKey = env['R2_SECRET_ACCESS_KEY'] ?? '';
  // Utilise STRICTEMENT le bucket documentaire R2_BUCKET_NAME (séparé de R2_PHOTOS_BUCKET_NAME)
  const bucket = env['R2_BUCKET_NAME'] ?? '';
  if (
    !ACCOUNT_ID_RE.test(accountId) ||
    !accessKeyId.trim() ||
    !secretAccessKey.trim() ||
    !BUCKET_RE.test(bucket)
  ) {
    throw new Error(
      'Le stockage des documents transactionnels R2_BUCKET_NAME n’est pas configuré.',
    );
  }
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

export function getTransactionalDocumentStorage(
  env: NodeJS.ProcessEnv = process.env,
): TransactionalDocumentStorage {
  const config = readR2DocumentConfig(env);
  return new R2TransactionalDocumentStorage(
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
