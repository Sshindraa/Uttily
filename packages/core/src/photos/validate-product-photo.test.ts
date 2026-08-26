import { describe, expect, it } from 'vitest';
import { PRODUCT_PHOTO_MAX_BYTES, validateProductPhoto } from './validate-product-photo';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
}

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  bytes[24] = (width - 1) & 0xff;
  bytes[25] = ((width - 1) >> 8) & 0xff;
  bytes[26] = (width - 1) >> 16;
  bytes[27] = (height - 1) & 0xff;
  bytes[28] = ((height - 1) >> 8) & 0xff;
  bytes[29] = (height - 1) >> 16;
  return bytes;
}

describe('validateProductPhoto', () => {
  it.each([
    ['image/png', png(800, 600)],
    ['image/jpeg', jpeg(800, 600)],
    ['image/webp', webpVp8x(800, 600)],
  ] as const)('accepte le contenu réel %s et extrait ses dimensions', (contentType, content) => {
    const result = validateProductPhoto(content, contentType);
    expect(result.contentType).toBe(contentType);
    expect(result.widthPx).toBe(800);
    expect(result.heightPx).toBe(600);
    expect(result.byteSize).toBe(content.byteLength);
    expect(result.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.content).not.toBe(content);
  });

  it('refuse un MIME déclaré qui ne correspond pas aux octets', () => {
    expect(() => validateProductPhoto(png(800, 600), 'image/jpeg')).toThrow(
      'type déclaré ne correspond pas',
    );
  });

  it('refuse les formats non image et les dimensions hors bornes', () => {
    expect(() => validateProductPhoto(new Uint8Array([1, 2, 3]), 'image/gif')).toThrow(
      'Format de photo',
    );
    expect(() => validateProductPhoto(png(199, 600), 'image/png')).toThrow('dimensions');
  });

  it('refuse une photo de plus de 10 Mo avant toute écriture', () => {
    const bytes = new Uint8Array(PRODUCT_PHOTO_MAX_BYTES + 1);
    expect(() => validateProductPhoto(bytes)).toThrow('10 Mo');
  });
});
