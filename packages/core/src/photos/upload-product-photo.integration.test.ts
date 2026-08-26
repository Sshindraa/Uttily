import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { assertLocalhost, createDatabase, runMigrations } from '@uttily/database';
import type { ProductPhotoStorage, ProductPhotoStoragePutResult } from './storage';
import { uploadProductPhoto } from './upload-product-photo';
import { replaceProductPhoto } from './replace-product-photo';

const sourceUrl = process.env.DATABASE_URL;
const ci = process.env.CI === '1' || process.env.CI === 'true';
const testDatabase = `uttily_test_g8b_photos_${Date.now()}`;
const shouldSkip = !sourceUrl && !ci;
let testUrl: string | null = null;

class FakePhotoStorage implements ProductPhotoStorage {
  readonly objects = new Map<string, Uint8Array>();
  readonly deletedKeys: string[] = [];

  async putIfAbsent(input: {
    readonly key: string;
    readonly content: Uint8Array;
    readonly contentType: string;
    readonly checksumSha256: string;
    readonly sizeBytes: number;
  }): Promise<ProductPhotoStoragePutResult> {
    if (this.objects.has(input.key)) {
      return {
        kind: 'ALREADY_EXISTS',
        metadata: {
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          checksumSha256: input.checksumSha256,
        },
      };
    }
    this.objects.set(input.key, new Uint8Array(input.content));
    return { kind: 'CREATED' };
  }

  async head(key: string) {
    const content = this.objects.get(key);
    return content
      ? { contentType: 'image/png', sizeBytes: content.byteLength, checksumSha256: null }
      : null;
  }

  async get(key: string): Promise<Uint8Array> {
    const content = this.objects.get(key);
    if (!content) throw new Error('not found');
    return new Uint8Array(content);
  }

  async deleteIfPresent(key: string): Promise<void> {
    this.deletedKeys.push(key);
    this.objects.delete(key);
  }
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

async function connectable(url: string): Promise<boolean> {
  try {
    const sql = postgres(url, { max: 1, connect_timeout: 3 });
    await sql`SELECT 1`;
    await sql.end();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(shouldSkip)('uploadProductPhoto — G8B-1 PostgreSQL', () => {
  beforeAll(async () => {
    if (!sourceUrl) throw new Error('CI: DATABASE_URL est requise pour G8B-1.');
    if (!(await connectable(sourceUrl))) throw new Error('PostgreSQL local est injoignable.');
    assertLocalhost(sourceUrl);
    const admin = postgres(sourceUrl, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabase}`);
    await admin.unsafe(`CREATE DATABASE ${testDatabase}`);
    await admin.end();
    const parsed = new URL(sourceUrl);
    parsed.pathname = `/${testDatabase}`;
    testUrl = parsed.toString();
    await runMigrations(testUrl);
  }, 600000);

  afterAll(async () => {
    if (!sourceUrl || !testUrl) return;
    const admin = postgres(sourceUrl, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabase}`);
    await admin.end();
  });

  it('valide les octets, écrit R2, passe AVAILABLE et rejoue sans overwrite', async () => {
    if (!testUrl) return;
    const suffix = Math.random().toString(36).slice(2, 8);
    const sql = postgres(testUrl, { max: 2 });
    const org = await sql`
      INSERT INTO organizations (legal_name, slug, default_currency)
      VALUES (${'G8B Org ' + suffix}, ${'g8b-org-' + suffix}, 'EUR') RETURNING id
    `.then((rows) => rows[0]!);
    const category = await sql`SELECT id FROM categories WHERE slug = 'equipment' LIMIT 1`.then(
      (rows) => rows[0]!,
    );
    const product = await sql`
      INSERT INTO products (organization_id, category_id, name, slug, description)
      VALUES (${org.id}, ${category.id}, 'Kayak G8B', ${'g8b-product-' + suffix}, 'Description')
      RETURNING id
    `.then((rows) => rows[0]!);
    await sql.end();

    const db = createDatabase(testUrl);
    const storage = new FakePhotoStorage();
    const photoId = crypto.randomUUID();
    const content = png(800, 600);
    const first = await uploadProductPhoto(db, storage, {
      organizationId: org.id,
      productId: product.id,
      photoId,
      content,
      declaredContentType: 'image/png',
    });
    expect(first.fileState).toBe('AVAILABLE');
    expect(storage.objects.size).toBe(1);
    const replay = await uploadProductPhoto(db, storage, {
      organizationId: org.id,
      productId: product.id,
      photoId,
      content,
      declaredContentType: 'image/png',
    });
    expect(replay.id).toBe(first.id);
    expect(storage.objects.size).toBe(1);
    await db.$client.end();
  });

  it('remplace une photo après upload et supprime physiquement l ancienne clé', async () => {
    if (!testUrl) return;
    const suffix = Math.random().toString(36).slice(2, 8);
    const sql = postgres(testUrl, { max: 2 });
    const org = await sql`
      INSERT INTO organizations (legal_name, slug, default_currency)
      VALUES (${'G8B Replace ' + suffix}, ${'g8b-replace-' + suffix}, 'EUR') RETURNING id
    `.then((rows) => rows[0]!);
    const category = await sql`SELECT id FROM categories WHERE slug = 'equipment' LIMIT 1`.then(
      (rows) => rows[0]!,
    );
    const product = await sql`
      INSERT INTO products (organization_id, category_id, name, slug, description)
      VALUES (${org.id}, ${category.id}, 'Kayak Replace', ${'g8b-replace-product-' + suffix}, 'Description')
      RETURNING id
    `.then((rows) => rows[0]!);
    await sql.end();

    const db = createDatabase(testUrl);
    const storage = new FakePhotoStorage();
    const original = await uploadProductPhoto(db, storage, {
      organizationId: org.id,
      productId: product.id,
      photoId: crypto.randomUUID(),
      content: png(800, 600),
      declaredContentType: 'image/png',
    });
    const originalKey = original.storageKey;
    const replacementId = crypto.randomUUID();
    const replacement = await replaceProductPhoto(db, storage, {
      organizationId: org.id,
      productId: product.id,
      photoId: original.id,
      replacementPhotoId: replacementId,
      content: png(801, 600),
      declaredContentType: 'image/png',
    });
    expect(replacement.fileState).toBe('AVAILABLE');
    expect(storage.deletedKeys).toContain(originalKey);
    const verification = postgres(testUrl, { max: 1 });
    try {
      const rows = await verification`
        SELECT count(*)::int AS count FROM product_photos
        WHERE product_id = ${product.id} AND file_state = 'AVAILABLE' AND deleted_at IS NULL
      `;
      expect(Number(rows[0]!.count)).toBe(1);
    } finally {
      await verification.end();
    }
    await db.$client.end();
  });
});
