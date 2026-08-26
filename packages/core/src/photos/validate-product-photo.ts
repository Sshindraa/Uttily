import { createHash } from 'node:crypto';
import { PhotoError } from './errors';

export const PRODUCT_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const PRODUCT_PHOTO_MIN_DIMENSION = 200;
export const PRODUCT_PHOTO_MAX_DIMENSION = 8000;
export const PRODUCT_PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ProductPhotoContentType = (typeof PRODUCT_PHOTO_CONTENT_TYPES)[number];

export interface ValidatedProductPhoto {
  readonly content: Uint8Array;
  readonly contentType: ProductPhotoContentType;
  readonly byteSize: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly checksumSha256: string;
}

/**
 * Valide les octets réels de l'image, pas uniquement le MIME déclaré par le
 * navigateur. Les trois formats acceptés sont bornés à 10 MiB et 200–8000 px.
 */
export function validateProductPhoto(
  content: Uint8Array,
  declaredContentType?: string,
): ValidatedProductPhoto {
  if (content.byteLength === 0 || content.byteLength > PRODUCT_PHOTO_MAX_BYTES) {
    throw invalidPhoto('La photo doit peser entre 1 octet et 10 Mo.');
  }

  const detected = detectImage(content);
  if (!detected) throw invalidPhoto('Format de photo non pris en charge.');
  if (declaredContentType && declaredContentType !== detected.contentType) {
    throw invalidPhoto('Le type déclaré ne correspond pas au contenu de la photo.');
  }
  if (
    detected.widthPx < PRODUCT_PHOTO_MIN_DIMENSION ||
    detected.widthPx > PRODUCT_PHOTO_MAX_DIMENSION ||
    detected.heightPx < PRODUCT_PHOTO_MIN_DIMENSION ||
    detected.heightPx > PRODUCT_PHOTO_MAX_DIMENSION
  ) {
    throw invalidPhoto('Les dimensions doivent être comprises entre 200 et 8000 pixels.');
  }

  return {
    content: copyBytes(content),
    contentType: detected.contentType,
    byteSize: content.byteLength,
    widthPx: detected.widthPx,
    heightPx: detected.heightPx,
    checksumSha256: createHash('sha256').update(content).digest('hex'),
  };
}

function invalidPhoto(message: string): PhotoError {
  return new PhotoError('PHOTO_VALIDATION_FAILED', message);
}

function copyBytes(value: Uint8Array): Uint8Array {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function detectImage(
  bytes: Uint8Array,
): { contentType: ProductPhotoContentType; widthPx: number; heightPx: number } | null {
  if (isPng(bytes)) {
    if (bytes.byteLength < 24) return null;
    return {
      contentType: 'image/png',
      widthPx: readUint32BE(bytes, 16),
      heightPx: readUint32BE(bytes, 20),
    };
  }
  if (isJpeg(bytes)) {
    const dimensions = readJpegDimensions(bytes);
    return dimensions ? { contentType: 'image/jpeg', ...dimensions } : null;
  }
  if (isWebp(bytes)) {
    const dimensions = readWebpDimensions(bytes);
    return dimensions ? { contentType: 'image/webp', ...dimensions } : null;
  }
  return null;
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function readJpegDimensions(bytes: Uint8Array): { widthPx: number; heightPx: number } | null {
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.byteLength) return null;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) return null;
    const segmentLength = readUint16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return null;
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) return null;
      return {
        heightPx: readUint16BE(bytes, offset + 3),
        widthPx: readUint16BE(bytes, offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 16 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function readWebpDimensions(bytes: Uint8Array): { widthPx: number; heightPx: number } | null {
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (chunk === 'VP8X' && bytes.byteLength >= 30) {
    return { widthPx: readUint24LE(bytes, 24) + 1, heightPx: readUint24LE(bytes, 27) + 1 };
  }
  if (chunk === 'VP8L' && bytes.byteLength >= 25 && bytes[20] === 0x2f) {
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return { widthPx: (bits & 0x3fff) + 1, heightPx: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ' && bytes.byteLength >= 30) {
    const frame = 20;
    if (bytes[frame] === 0x9d && bytes[frame + 1] === 0x01 && bytes[frame + 2] === 0x2a) {
      return {
        widthPx: readUint16LE(bytes, frame + 3) & 0x3fff,
        heightPx: readUint16LE(bytes, frame + 5) & 0x3fff,
      };
    }
  }
  return null;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}
