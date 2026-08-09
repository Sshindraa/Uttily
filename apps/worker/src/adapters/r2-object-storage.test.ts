import { describe, it, expect } from 'vitest';
import {
  R2ObjectStorage,
  R2ConfigError,
  R2StorageError,
  validateR2Config,
  createR2ConfigFromEnv,
  type R2Config,
  type S3ClientLike,
} from './r2-object-storage';

// Toutes les valeurs de test sont fictives. Aucun credential réel.

const VALID_CONFIG: R2Config = {
  accountId: 'testaccount123',
  accessKeyId: 'testaccesskey',
  secretAccessKey: 'testsecretkey',
  bucketName: 'uttily-test-bucket',
};

const TEST_KEY = 'documents/booking/test-key-123';
const TEST_CONTENT = new Uint8Array([1, 2, 3, 4, 5]);
const TEST_CONTENT_TYPE = 'application/pdf';
const TEST_CHECKSUM = 'a'.repeat(64);
const TEST_SIZE = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Mock client factice — capture les commandes sans réseau
// ─────────────────────────────────────────────────────────────────────────────

interface MockResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly response?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly error?: any;
}

interface CapturedCommand {
  readonly constructorName: string;
  readonly input: Record<string, unknown>;
}

class MockS3Client implements S3ClientLike {
  readonly capturedCommands: CapturedCommand[] = [];
  private responses: MockResponse[] = [];
  private callIndex = 0;
  destroyCallCount = 0;
  destroyShouldThrow = false;

  setResponses(responses: MockResponse[]): void {
    this.responses = responses;
    this.callIndex = 0;
  }

  async send(command: unknown): Promise<unknown> {
    // Capturer la commande pour inspection.
    const constructorName = command?.constructor?.name ?? 'Unknown';
    const input = (command as { input?: Record<string, unknown> })?.input ?? {};
    this.capturedCommands.push({ constructorName, input });

    const mock = this.responses[this.callIndex];
    this.callIndex++;
    if (mock?.error) {
      throw mock.error;
    }
    return mock?.response ?? {};
  }

  destroy(): void {
    this.destroyCallCount++;
    if (this.destroyShouldThrow) {
      throw new Error('destroy failed');
    }
  }

  reset(): void {
    this.capturedCommands.length = 0;
    this.responses = [];
    this.callIndex = 0;
    this.destroyCallCount = 0;
    this.destroyShouldThrow = false;
  }
}

// Helpers pour construire des erreurs AWS SDK factices.

function awsError(name: string, httpStatusCode: number): Error {
  const err = new Error(`AWS SDK error: ${name}`);
  err.name = name;
  Object.assign(err, { $metadata: { httpStatusCode } });
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('R2ObjectStorage', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Configuration
  // ─────────────────────────────────────────────────────────────────────────

  describe('validateR2Config', () => {
    it('accepte une configuration valide', () => {
      expect(() => validateR2Config(VALID_CONFIG)).not.toThrow();
    });

    it('rejette un accountId absent', () => {
      let caught: unknown;
      try {
        validateR2Config({ ...VALID_CONFIG, accountId: '' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2ConfigError);
      expect((caught as Error).message).toContain('R2_ACCOUNT_ID');
    });

    it('rejette un accessKeyId absent', () => {
      let caught: unknown;
      try {
        validateR2Config({ ...VALID_CONFIG, accessKeyId: '' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2ConfigError);
      expect((caught as Error).message).toContain('R2_ACCESS_KEY_ID');
    });

    it('rejette un secretAccessKey absent', () => {
      let caught: unknown;
      try {
        validateR2Config({ ...VALID_CONFIG, secretAccessKey: '' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2ConfigError);
      expect((caught as Error).message).toContain('R2_SECRET_ACCESS_KEY');
    });

    it('rejette un bucketName absent', () => {
      let caught: unknown;
      try {
        validateR2Config({ ...VALID_CONFIG, bucketName: '' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2ConfigError);
      expect((caught as Error).message).toContain('R2_BUCKET_NAME');
    });

    it('rejette un accountId whitespace uniquement', () => {
      let caught: unknown;
      try {
        validateR2Config({ ...VALID_CONFIG, accountId: '   ' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2ConfigError);
    });

    it('rejette un accessKeyId whitespace uniquement', () => {
      let caught: unknown;
      try {
        validateR2Config({ ...VALID_CONFIG, accessKeyId: '  ' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2ConfigError);
    });

    it('rejette un accountId invalide (caractères spéciaux)', () => {
      let caught: unknown;
      try {
        validateR2Config({ ...VALID_CONFIG, accountId: 'bad!account' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2ConfigError);
    });

    it('rejette un accountId trop court (moins de 6)', () => {
      let caught: unknown;
      try {
        validateR2Config({ ...VALID_CONFIG, accountId: 'abc' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2ConfigError);
    });

    it('rejette un bucketName invalide (majuscules)', () => {
      let caught: unknown;
      try {
        validateR2Config({ ...VALID_CONFIG, bucketName: 'UpperCaseBucket' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2ConfigError);
    });

    it('les erreurs ne contiennent pas la valeur du secret', () => {
      let caught: unknown;
      try {
        validateR2Config({
          ...VALID_CONFIG,
          secretAccessKey: 'SUPERSECRET_VALUE_123',
        });
        // Invalider pour forcer une erreur sur secretAccessKey
        validateR2Config({
          accountId: 'testaccount123',
          accessKeyId: 'testaccesskey',
          secretAccessKey: '',
          bucketName: 'uttily-test-bucket',
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2ConfigError);
      expect((caught as Error).message).not.toContain('SUPERSECRET_VALUE_123');
    });
  });

  describe('createR2ConfigFromEnv', () => {
    it('construit depuis des variables valides', () => {
      const config = createR2ConfigFromEnv({
        R2_ACCOUNT_ID: 'testaccount123',
        R2_ACCESS_KEY_ID: 'testaccesskey',
        R2_SECRET_ACCESS_KEY: 'testsecretkey',
        R2_BUCKET_NAME: 'uttily-test-bucket',
      });
      expect(config.accountId).toBe('testaccount123');
      expect(config.bucketName).toBe('uttily-test-bucket');
    });

    it('rejette si une variable est absente', () => {
      let caught: unknown;
      try {
        createR2ConfigFromEnv({ R2_ACCOUNT_ID: 'testaccount123' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2ConfigError);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // putIfAbsent
  // ─────────────────────────────────────────────────────────────────────────

  describe('putIfAbsent', () => {
    it('succès PutObject → CREATED', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ response: { ETag: '"abc123"' } }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      const result = await storage.putIfAbsent({
        key: TEST_KEY,
        content: TEST_CONTENT,
        contentType: TEST_CONTENT_TYPE,
        checksumSha256: TEST_CHECKSUM,
        sizeBytes: TEST_SIZE,
      });

      expect(result.kind).toBe('CREATED');
    });

    it('envoie une commande PutObjectCommand', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ response: {} }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      await storage.putIfAbsent({
        key: TEST_KEY,
        content: TEST_CONTENT,
        contentType: TEST_CONTENT_TYPE,
        checksumSha256: TEST_CHECKSUM,
        sizeBytes: TEST_SIZE,
      });

      expect(mock.capturedCommands.length).toBe(1);
      expect(mock.capturedCommands[0]!.constructorName).toBe('PutObjectCommand');
    });

    it("IfNoneMatch est toujours '*'", async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ response: {} }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      await storage.putIfAbsent({
        key: TEST_KEY,
        content: TEST_CONTENT,
        contentType: TEST_CONTENT_TYPE,
        checksumSha256: TEST_CHECKSUM,
        sizeBytes: TEST_SIZE,
      });

      expect(mock.capturedCommands[0]!.input).toHaveProperty('IfNoneMatch', '*');
    });

    it('ContentType et ContentLength sont définis', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ response: {} }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      await storage.putIfAbsent({
        key: TEST_KEY,
        content: TEST_CONTENT,
        contentType: TEST_CONTENT_TYPE,
        checksumSha256: TEST_CHECKSUM,
        sizeBytes: TEST_SIZE,
      });

      expect(mock.capturedCommands[0]!.input).toHaveProperty('ContentType', TEST_CONTENT_TYPE);
      expect(mock.capturedCommands[0]!.input).toHaveProperty('ContentLength', TEST_SIZE);
    });

    it('custom metadata contient checksum et taille', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ response: {} }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      await storage.putIfAbsent({
        key: TEST_KEY,
        content: TEST_CONTENT,
        contentType: TEST_CONTENT_TYPE,
        checksumSha256: TEST_CHECKSUM,
        sizeBytes: TEST_SIZE,
      });

      const metadata = mock.capturedCommands[0]!.input.Metadata as Record<string, string>;
      expect(metadata).toHaveProperty('uttily-checksum-sha256', TEST_CHECKSUM);
      expect(metadata).toHaveProperty('uttily-size-bytes', String(TEST_SIZE));
    });

    it('copie défensive du Body — modifier l input après put n affecte pas l envoi', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ response: {} }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      const input = new Uint8Array([1, 2, 3]);
      await storage.putIfAbsent({
        key: TEST_KEY,
        content: input,
        contentType: TEST_CONTENT_TYPE,
        checksumSha256: TEST_CHECKSUM,
        sizeBytes: 3,
      });

      // Modifier l'input après l'appel.
      input[0] = 99;

      // Le Body envoyé doit être une copie, pas l'input original.
      const sentBody = mock.capturedCommands[0]!.input.Body as Uint8Array;
      expect(sentBody[0]).toBe(1);
    });

    it('412 PreconditionFailed → ALREADY_EXISTS avec métadonnées', async () => {
      const mock = new MockS3Client();
      mock.setResponses([
        { error: awsError('PreconditionFailed', 412) },
        {
          response: {
            ContentType: TEST_CONTENT_TYPE,
            ContentLength: TEST_SIZE,
            Metadata: { 'uttily-checksum-sha256': TEST_CHECKSUM },
          },
        },
      ]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      const result = await storage.putIfAbsent({
        key: TEST_KEY,
        content: TEST_CONTENT,
        contentType: TEST_CONTENT_TYPE,
        checksumSha256: TEST_CHECKSUM,
        sizeBytes: TEST_SIZE,
      });

      expect(result.kind).toBe('ALREADY_EXISTS');
      if (result.kind === 'ALREADY_EXISTS') {
        expect(result.metadata.contentType).toBe(TEST_CONTENT_TYPE);
        expect(result.metadata.sizeBytes).toBe(TEST_SIZE);
        expect(result.metadata.checksumSha256).toBe(TEST_CHECKSUM);
      }
      // Deux commandes : PUT puis HEAD.
      expect(mock.capturedCommands.length).toBe(2);
      expect(mock.capturedCommands[1]!.constructorName).toBe('HeadObjectCommand');
    });

    it('409 Conflict → erreur transitoire (CONDITIONAL_CONFLICT_TRANSIENT)', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ error: awsError('Conflict', 409) }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      let caught: unknown;
      try {
        await storage.putIfAbsent({
          key: TEST_KEY,
          content: TEST_CONTENT,
          contentType: TEST_CONTENT_TYPE,
          checksumSha256: TEST_CHECKSUM,
          sizeBytes: TEST_SIZE,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2StorageError);
      expect((caught as R2StorageError).code).toBe('CONDITIONAL_CONFLICT_TRANSIENT');
      // Pas de HEAD après un 409.
      expect(mock.capturedCommands.length).toBe(1);
    });

    it('500 → erreur transitoire nettoyée (PROVIDER_TRANSIENT)', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ error: awsError('InternalError', 500) }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      let caught: unknown;
      try {
        await storage.putIfAbsent({
          key: TEST_KEY,
          content: TEST_CONTENT,
          contentType: TEST_CONTENT_TYPE,
          checksumSha256: TEST_CHECKSUM,
          sizeBytes: TEST_SIZE,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2StorageError);
      expect((caught as R2StorageError).code).toBe('PROVIDER_TRANSIENT');
    });

    it('timeout (erreur réseau) → erreur transitoire nettoyée', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ error: new Error('Connection timeout') }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      let caught: unknown;
      try {
        await storage.putIfAbsent({
          key: TEST_KEY,
          content: TEST_CONTENT,
          contentType: TEST_CONTENT_TYPE,
          checksumSha256: TEST_CHECKSUM,
          sizeBytes: TEST_SIZE,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2StorageError);
      expect((caught as R2StorageError).code).toBe('PROVIDER_TRANSIENT');
      // Le message ne doit pas contenir le message brut.
      expect((caught as Error).message).not.toContain('Connection timeout');
    });

    it('aucun PUT non conditionnel — IfNoneMatch toujours présent', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ response: {} }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      await storage.putIfAbsent({
        key: TEST_KEY,
        content: TEST_CONTENT,
        contentType: TEST_CONTENT_TYPE,
        checksumSha256: TEST_CHECKSUM,
        sizeBytes: TEST_SIZE,
      });

      // IfNoneMatch doit toujours être '*' — jamais absent.
      const input = mock.capturedCommands[0]!.input;
      expect(input.IfNoneMatch).toBe('*');
    });

    it('deux appels concurrents ne déclenchent jamais d overwrite (412 sur le second)', async () => {
      const mock = new MockS3Client();
      mock.setResponses([
        { response: { ETag: '"first"' } },
        { error: awsError('PreconditionFailed', 412) },
        {
          response: {
            ContentType: TEST_CONTENT_TYPE,
            ContentLength: TEST_SIZE,
            Metadata: { 'uttily-checksum-sha256': TEST_CHECKSUM },
          },
        },
      ]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      const result1 = await storage.putIfAbsent({
        key: TEST_KEY,
        content: TEST_CONTENT,
        contentType: TEST_CONTENT_TYPE,
        checksumSha256: TEST_CHECKSUM,
        sizeBytes: TEST_SIZE,
      });
      expect(result1.kind).toBe('CREATED');

      const result2 = await storage.putIfAbsent({
        key: TEST_KEY,
        content: new Uint8Array([9, 9, 9]),
        contentType: 'text/plain',
        checksumSha256: 'b'.repeat(64),
        sizeBytes: 3,
      });
      expect(result2.kind).toBe('ALREADY_EXISTS');
      if (result2.kind === 'ALREADY_EXISTS') {
        // Les métadonnées sont celles de l'objet original, pas du second.
        expect(result2.metadata.contentType).toBe(TEST_CONTENT_TYPE);
        expect(result2.metadata.sizeBytes).toBe(TEST_SIZE);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // head
  // ─────────────────────────────────────────────────────────────────────────

  describe('head', () => {
    it('retourne les métadonnées complètes', async () => {
      const mock = new MockS3Client();
      mock.setResponses([
        {
          response: {
            ContentType: TEST_CONTENT_TYPE,
            ContentLength: TEST_SIZE,
            Metadata: { 'uttily-checksum-sha256': TEST_CHECKSUM },
          },
        },
      ]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      const meta = await storage.head(TEST_KEY);
      expect(meta).not.toBeNull();
      expect(meta?.contentType).toBe(TEST_CONTENT_TYPE);
      expect(meta?.sizeBytes).toBe(TEST_SIZE);
      expect(meta?.checksumSha256).toBe(TEST_CHECKSUM);
    });

    it('checksum absent → null', async () => {
      const mock = new MockS3Client();
      mock.setResponses([
        {
          response: {
            ContentType: TEST_CONTENT_TYPE,
            ContentLength: TEST_SIZE,
            Metadata: {},
          },
        },
      ]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      const meta = await storage.head(TEST_KEY);
      expect(meta?.checksumSha256).toBeNull();
    });

    it('checksum invalide (non hex 64) → null', async () => {
      const mock = new MockS3Client();
      mock.setResponses([
        {
          response: {
            ContentType: TEST_CONTENT_TYPE,
            ContentLength: TEST_SIZE,
            Metadata: { 'uttily-checksum-sha256': 'invalid' },
          },
        },
      ]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      const meta = await storage.head(TEST_KEY);
      expect(meta?.checksumSha256).toBeNull();
    });

    it('404 NotFound → null', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ error: awsError('NotFound', 404) }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      const meta = await storage.head(TEST_KEY);
      expect(meta).toBeNull();
    });

    it('404 NoSuchKey → null', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ error: awsError('NoSuchKey', 404) }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      const meta = await storage.head(TEST_KEY);
      expect(meta).toBeNull();
    });

    it('taille invalide (négative) → erreur de protocole', async () => {
      const mock = new MockS3Client();
      mock.setResponses([
        {
          response: {
            ContentType: TEST_CONTENT_TYPE,
            ContentLength: -1,
            Metadata: {},
          },
        },
      ]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      let caught: unknown;
      try {
        await storage.head(TEST_KEY);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2StorageError);
      expect((caught as R2StorageError).code).toBe('PROVIDER_INVALID_RESPONSE');
    });

    it('taille absente → erreur de protocole', async () => {
      const mock = new MockS3Client();
      mock.setResponses([
        {
          response: {
            ContentType: TEST_CONTENT_TYPE,
            Metadata: {},
          },
        },
      ]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      let caught: unknown;
      try {
        await storage.head(TEST_KEY);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2StorageError);
      expect((caught as R2StorageError).code).toBe('PROVIDER_INVALID_RESPONSE');
    });

    it('erreur fournisseur → erreur transitoire nettoyée', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ error: awsError('ServiceUnavailable', 503) }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      let caught: unknown;
      try {
        await storage.head(TEST_KEY);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2StorageError);
      expect((caught as R2StorageError).code).toBe('PROVIDER_TRANSIENT');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // get
  // ─────────────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('body Uint8Array → converti et copie défensive', async () => {
      const mock = new MockS3Client();
      const bodyData = new Uint8Array([10, 20, 30]);
      mock.setResponses([{ response: { Body: bodyData } }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      const result = await storage.get(TEST_KEY);
      expect(Array.from(result)).toEqual([10, 20, 30]);

      // Copie défensive : modifier le résultat ne doit pas affecter le body original.
      result[0] = 99;
      expect(bodyData[0]).toBe(10);
    });

    it('body string → converti en Uint8Array', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ response: { Body: 'hello' } }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      const result = await storage.get(TEST_KEY);
      expect(Array.from(result)).toEqual(Array.from(new TextEncoder().encode('hello')));
    });

    it('404 → erreur OBJECT_NOT_FOUND nettoyée', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ error: awsError('NotFound', 404) }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      let caught: unknown;
      try {
        await storage.get(TEST_KEY);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2StorageError);
      expect((caught as R2StorageError).code).toBe('OBJECT_NOT_FOUND');
    });

    it('body absent → erreur de protocole', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ response: {} }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      let caught: unknown;
      try {
        await storage.get(TEST_KEY);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2StorageError);
      expect((caught as R2StorageError).code).toBe('PROVIDER_INVALID_RESPONSE');
    });

    it('erreur fournisseur → erreur transitoire sans fuite', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ error: new Error('ECONNRESET to r2.cloudflarestorage.com') }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      let caught: unknown;
      try {
        await storage.get(TEST_KEY);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2StorageError);
      expect((caught as R2StorageError).code).toBe('PROVIDER_TRANSIENT');
      expect((caught as Error).message).not.toContain('ECONNRESET');
      expect((caught as Error).message).not.toContain('r2.cloudflarestorage.com');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Sécurité — non-divulgation
  // ─────────────────────────────────────────────────────────────────────────

  describe('sécurité — non-divulgation des secrets', () => {
    it('aucun message d erreur ne contient accessKeyId', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ error: awsError('InternalError', 500) }]);
      const storage = new R2ObjectStorage(
        { ...VALID_CONFIG, accessKeyId: 'SECRET_ACCESS_KEY_VALUE' },
        mock,
      );

      let caught: unknown;
      try {
        await storage.putIfAbsent({
          key: TEST_KEY,
          content: TEST_CONTENT,
          contentType: TEST_CONTENT_TYPE,
          checksumSha256: TEST_CHECKSUM,
          sizeBytes: TEST_SIZE,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2StorageError);
      expect((caught as Error).message).not.toContain('SECRET_ACCESS_KEY_VALUE');
    });

    it('aucun message d erreur ne contient secretAccessKey', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ error: awsError('InternalError', 500) }]);
      const storage = new R2ObjectStorage(
        { ...VALID_CONFIG, secretAccessKey: 'SUPER_SECRET_KEY_123' },
        mock,
      );

      let caught: unknown;
      try {
        await storage.putIfAbsent({
          key: TEST_KEY,
          content: TEST_CONTENT,
          contentType: TEST_CONTENT_TYPE,
          checksumSha256: TEST_CHECKSUM,
          sizeBytes: TEST_SIZE,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2StorageError);
      expect((caught as Error).message).not.toContain('SUPER_SECRET_KEY_123');
    });

    it('aucun message d erreur ne contient accountId', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ error: awsError('InternalError', 500) }]);
      const storage = new R2ObjectStorage({ ...VALID_CONFIG, accountId: 'secretaccountid' }, mock);

      let caught: unknown;
      try {
        await storage.putIfAbsent({
          key: TEST_KEY,
          content: TEST_CONTENT,
          contentType: TEST_CONTENT_TYPE,
          checksumSha256: TEST_CHECKSUM,
          sizeBytes: TEST_SIZE,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2StorageError);
      expect((caught as Error).message).not.toContain('secretaccountid');
    });

    it('aucun message d erreur ne contient bucketName', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ error: awsError('InternalError', 500) }]);
      const storage = new R2ObjectStorage(
        { ...VALID_CONFIG, bucketName: 'super-secret-bucket' },
        mock,
      );

      let caught: unknown;
      try {
        await storage.putIfAbsent({
          key: TEST_KEY,
          content: TEST_CONTENT,
          contentType: TEST_CONTENT_TYPE,
          checksumSha256: TEST_CHECKSUM,
          sizeBytes: TEST_SIZE,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2StorageError);
      expect((caught as Error).message).not.toContain('super-secret-bucket');
    });

    it('aucun message d erreur ne contient la clé objet', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ error: awsError('InternalError', 500) }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      let caught: unknown;
      try {
        await storage.putIfAbsent({
          key: 'documents/booking/SECRET_KEY_PATH',
          content: TEST_CONTENT,
          contentType: TEST_CONTENT_TYPE,
          checksumSha256: TEST_CHECKSUM,
          sizeBytes: TEST_SIZE,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2StorageError);
      expect((caught as Error).message).not.toContain('SECRET_KEY_PATH');
    });

    it('aucun message d erreur ne contient endpoint', async () => {
      const mock = new MockS3Client();
      mock.setResponses([{ error: awsError('InternalError', 500) }]);
      const storage = new R2ObjectStorage(VALID_CONFIG, mock);

      let caught: unknown;
      try {
        await storage.putIfAbsent({
          key: TEST_KEY,
          content: TEST_CONTENT,
          contentType: TEST_CONTENT_TYPE,
          checksumSha256: TEST_CHECKSUM,
          sizeBytes: TEST_SIZE,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2StorageError);
      expect((caught as Error).message).not.toContain('r2.cloudflarestorage.com');
    });

    it('erreur de configuration ne contient pas la valeur du credential', () => {
      let caught: unknown;
      try {
        validateR2Config({
          accountId: 'testaccount123',
          accessKeyId: 'LEAKED_ACCESS_KEY',
          secretAccessKey: '',
          bucketName: 'uttily-test-bucket',
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(R2ConfigError);
      expect((caught as Error).message).not.toContain('LEAKED_ACCESS_KEY');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // close() — idempotence
  // ─────────────────────────────────────────────────────────────────────────

  describe('R2ObjectStorage.close()', () => {
    it('close() appelle destroy() une seule fois', () => {
      const client = new MockS3Client();
      const storage = new R2ObjectStorage(VALID_CONFIG, client);
      storage.close();
      storage.close();
      expect(client.destroyCallCount).toBe(1);
    });

    it("close() ne lève pas si le client n'a pas destroy()", () => {
      // Client sans destroy() — utiliser un objet minimal
      const clientWithoutDestroy: S3ClientLike = {
        send: async () => ({}),
      };
      const storage = new R2ObjectStorage(VALID_CONFIG, clientWithoutDestroy);
      expect(() => storage.close()).not.toThrow();
    });

    it('close() propage l exception de destroy() (comportement documenté)', () => {
      const client = new MockS3Client();
      client.destroyShouldThrow = true;
      const storage = new R2ObjectStorage(VALID_CONFIG, client);
      expect(() => storage.close()).toThrow();
    });

    it('close() après close() avec destroy qui lève — pas de double appel', () => {
      const client = new MockS3Client();
      client.destroyShouldThrow = true;
      const storage = new R2ObjectStorage(VALID_CONFIG, client);
      try {
        storage.close();
      } catch {
        // ignore
      }
      try {
        storage.close();
      } catch {
        // ignore
      }
      expect(client.destroyCallCount).toBe(1);
    });
  });
});
