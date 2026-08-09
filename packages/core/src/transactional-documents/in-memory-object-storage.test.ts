import { describe, it, expect } from 'vitest';
import { InMemoryObjectStorage } from './in-memory-object-storage';

const TEST_KEY = 'test-key-123';
const TEST_CONTENT = new Uint8Array([1, 2, 3, 4, 5]);
const TEST_CONTENT_TYPE = 'application/octet-stream';
const TEST_CHECKSUM = 'a'.repeat(64);
const TEST_SIZE = 5;

describe('InMemoryObjectStorage', () => {
  it('CREATED — première écriture réussit', async () => {
    const storage = new InMemoryObjectStorage();
    const result = await storage.putIfAbsent({
      key: TEST_KEY,
      content: TEST_CONTENT,
      contentType: TEST_CONTENT_TYPE,
      checksumSha256: TEST_CHECKSUM,
      sizeBytes: TEST_SIZE,
    });
    expect(result.kind).toBe('CREATED');
  });

  it('ALREADY_EXISTS — seconde écriture retourne les métadonnées existantes', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.putIfAbsent({
      key: TEST_KEY,
      content: TEST_CONTENT,
      contentType: TEST_CONTENT_TYPE,
      checksumSha256: TEST_CHECKSUM,
      sizeBytes: TEST_SIZE,
    });
    const result = await storage.putIfAbsent({
      key: TEST_KEY,
      content: new Uint8Array([9, 9, 9]),
      contentType: 'text/plain',
      checksumSha256: 'b'.repeat(64),
      sizeBytes: 3,
    });
    expect(result.kind).toBe('ALREADY_EXISTS');
    if (result.kind === 'ALREADY_EXISTS') {
      expect(result.metadata.contentType).toBe(TEST_CONTENT_TYPE);
      expect(result.metadata.sizeBytes).toBe(TEST_SIZE);
      expect(result.metadata.checksumSha256).toBe(TEST_CHECKSUM);
    }
  });

  it("aucun overwrite — l'objet existant n'est jamais modifié", async () => {
    const storage = new InMemoryObjectStorage();
    await storage.putIfAbsent({
      key: TEST_KEY,
      content: TEST_CONTENT,
      contentType: TEST_CONTENT_TYPE,
      checksumSha256: TEST_CHECKSUM,
      sizeBytes: TEST_SIZE,
    });
    // Tenter d'écrire un contenu différent
    await storage.putIfAbsent({
      key: TEST_KEY,
      content: new Uint8Array([9, 9, 9]),
      contentType: 'text/plain',
      checksumSha256: 'b'.repeat(64),
      sizeBytes: 3,
    });
    // Vérifier que l'objet original est intact
    const content = await storage.get(TEST_KEY);
    expect(Array.from(content)).toEqual(Array.from(TEST_CONTENT));
    const meta = await storage.head(TEST_KEY);
    expect(meta?.contentType).toBe(TEST_CONTENT_TYPE);
    expect(meta?.sizeBytes).toBe(TEST_SIZE);
    expect(meta?.checksumSha256).toBe(TEST_CHECKSUM);
  });

  it('head — retourne les métadonnées ou null', async () => {
    const storage = new InMemoryObjectStorage();
    expect(await storage.head('nonexistent')).toBeNull();
    await storage.putIfAbsent({
      key: TEST_KEY,
      content: TEST_CONTENT,
      contentType: TEST_CONTENT_TYPE,
      checksumSha256: TEST_CHECKSUM,
      sizeBytes: TEST_SIZE,
    });
    const meta = await storage.head(TEST_KEY);
    expect(meta).not.toBeNull();
    expect(meta?.contentType).toBe(TEST_CONTENT_TYPE);
    expect(meta?.sizeBytes).toBe(TEST_SIZE);
    expect(meta?.checksumSha256).toBe(TEST_CHECKSUM);
  });

  it('get — retourne une copie défensive du contenu', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.putIfAbsent({
      key: TEST_KEY,
      content: TEST_CONTENT,
      contentType: TEST_CONTENT_TYPE,
      checksumSha256: TEST_CHECKSUM,
      sizeBytes: TEST_SIZE,
    });
    const content1 = await storage.get(TEST_KEY);
    const content2 = await storage.get(TEST_KEY);
    expect(Array.from(content1)).toEqual(Array.from(TEST_CONTENT));
    expect(Array.from(content2)).toEqual(Array.from(TEST_CONTENT));
    // Modifier la copie ne doit pas affecter le stockage
    content1[0] = 99;
    const content3 = await storage.get(TEST_KEY);
    expect(content3[0]).toBe(1);
  });

  it("get — lève une erreur si la clé n'existe pas", async () => {
    const storage = new InMemoryObjectStorage();
    await expect(storage.get('nonexistent')).rejects.toThrow();
  });

  it('failPut — putIfAbsent lève toujours une erreur', async () => {
    const storage = new InMemoryObjectStorage({ failPut: true });
    await expect(
      storage.putIfAbsent({
        key: TEST_KEY,
        content: TEST_CONTENT,
        contentType: TEST_CONTENT_TYPE,
        checksumSha256: TEST_CHECKSUM,
        sizeBytes: TEST_SIZE,
      }),
    ).rejects.toThrow();
  });

  it('omitChecksum — metadata.checksumSha256 = null', async () => {
    const storage = new InMemoryObjectStorage({ omitChecksum: true });
    await storage.putIfAbsent({
      key: TEST_KEY,
      content: TEST_CONTENT,
      contentType: TEST_CONTENT_TYPE,
      checksumSha256: TEST_CHECKSUM,
      sizeBytes: TEST_SIZE,
    });
    const meta = await storage.head(TEST_KEY);
    expect(meta?.checksumSha256).toBeNull();
  });

  it("notFoundOnGet — get lève même si l'objet existe", async () => {
    const storage = new InMemoryObjectStorage({ notFoundOnGet: true });
    await storage.putIfAbsent({
      key: TEST_KEY,
      content: TEST_CONTENT,
      contentType: TEST_CONTENT_TYPE,
      checksumSha256: TEST_CHECKSUM,
      sizeBytes: TEST_SIZE,
    });
    await expect(storage.get(TEST_KEY)).rejects.toThrow();
  });

  it('returnDifferentContent — get retourne un contenu différent', async () => {
    const storage = new InMemoryObjectStorage({ returnDifferentContent: true });
    await storage.putIfAbsent({
      key: TEST_KEY,
      content: TEST_CONTENT,
      contentType: TEST_CONTENT_TYPE,
      checksumSha256: TEST_CHECKSUM,
      sizeBytes: TEST_SIZE,
    });
    const content = await storage.get(TEST_KEY);
    expect(content.length).toBe(TEST_CONTENT.length + 1);
    expect(content[TEST_CONTENT.length]).toBe(0xff);
  });

  it('returnDifferentContent — head retourne un sizeBytes différent', async () => {
    const storage = new InMemoryObjectStorage({ returnDifferentContent: true });
    await storage.putIfAbsent({
      key: TEST_KEY,
      content: TEST_CONTENT,
      contentType: TEST_CONTENT_TYPE,
      checksumSha256: TEST_CHECKSUM,
      sizeBytes: TEST_SIZE,
    });
    const meta = await storage.head(TEST_KEY);
    expect(meta?.sizeBytes).toBe(TEST_SIZE + 1);
  });

  it("copie défensive à l'écriture — modifier l'input après put n'affecte pas le stockage", async () => {
    const storage = new InMemoryObjectStorage();
    const input = new Uint8Array([1, 2, 3]);
    await storage.putIfAbsent({
      key: TEST_KEY,
      content: input,
      contentType: TEST_CONTENT_TYPE,
      checksumSha256: TEST_CHECKSUM,
      sizeBytes: 3,
    });
    input[0] = 99;
    const content = await storage.get(TEST_KEY);
    expect(content[0]).toBe(1);
  });
});
