import { describe, expect, it } from 'vitest';
import { createPublicSearchCursorCodec, PUBLIC_SEARCH_CONTRACT_VERSION } from './cursor';
import { PublicSearchError } from './errors';
import type { PublicSearchIntent } from './types';

const SECRET = 'a-secret-of-at-least-32-bytes-long-for-tests';
const validTuple = {
  rawDistanceMeters: 1234.5,
  publicProductId: 'a0b1c2d3-e4f5-4a6b-b7c8-d9e0f1a2b3c4',
  publicLocationId: 'b1c2d3e4-f5a6-4b7c-c8d9-e0f1a2b3c4d5',
};

const baseFingerprint = {
  destinationPublicId: 'd0e1f2a3-b4c5-4d6e-e7f8-a9b0c1d2e3f4',
  canonicalLocale: 'fr',
  canonicalIntent: {
    kind: 'TIME_RANGE' as const,
    startAt: '2026-08-08T09:00:00',
    endAt: '2026-08-08T17:00:00',
  },
  categoryId: null,
  viewport: null,
  contractVersion: PUBLIC_SEARCH_CONTRACT_VERSION,
};

describe('PublicSearchCursorCodec', () => {
  it('encode/decode round-trip', () => {
    const codec = createPublicSearchCursorCodec(SECRET);
    const cursor = codec.encode(validTuple, baseFingerprint);
    const decoded = codec.decode(cursor, baseFingerprint);
    expect(decoded).toEqual(validTuple);
  });

  it('refuse un octet modifié', () => {
    const codec = createPublicSearchCursorCodec(SECRET);
    const cursor = codec.encode(validTuple, baseFingerprint);
    const tampered = cursor.slice(0, cursor.length - 4) + 'XXXX';
    expect(() => codec.decode(tampered, baseFingerprint)).toThrow(PublicSearchError);
    try {
      codec.decode(tampered, baseFingerprint);
    } catch (err) {
      expect(err).toBeInstanceOf(PublicSearchError);
      expect((err as PublicSearchError).code).toBe('INVALID_CURSOR');
    }
  });

  it('refuse une distance modifiée dans le payload', () => {
    const codec = createPublicSearchCursorCodec(SECRET);
    const cursor = codec.encode(validTuple, baseFingerprint);
    // The payload is base64url before the '.' separator.
    const [payloadB64, sig] = cursor.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));
    payload.k.rawDistanceMeters = 9999;
    const newPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const tampered = `${newPayload}.${sig}`;
    expect(() => codec.decode(tampered, baseFingerprint)).toThrow(PublicSearchError);
  });

  it('refuse un id modifié', () => {
    const codec = createPublicSearchCursorCodec(SECRET);
    const cursor = codec.encode(validTuple, baseFingerprint);
    const [payloadB64, sig] = cursor.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));
    payload.k.publicProductId = 'a0b1c2d3-e4f5-4a6b-b7c8-d9e0f1a2b3c5';
    const newPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const tampered = `${newPayload}.${sig}`;
    expect(() => codec.decode(tampered, baseFingerprint)).toThrow(PublicSearchError);
  });

  it('refuse une destination différente', () => {
    const codec = createPublicSearchCursorCodec(SECRET);
    const cursor = codec.encode(validTuple, baseFingerprint);
    const otherFingerprint = {
      ...baseFingerprint,
      destinationPublicId: '11111111-1111-1111-1111-111111111111',
    };
    expect(() => codec.decode(cursor, otherFingerprint)).toThrow(PublicSearchError);
  });

  it('refuse un curseur utilisé depuis un autre viewport', () => {
    const codec = createPublicSearchCursorCodec(SECRET);
    const viewport = {
      kind: 'VIEWPORT' as const,
      south: 45.8,
      west: 6.0,
      north: 46.0,
      east: 6.3,
    };
    const cursor = codec.encode(validTuple, { ...baseFingerprint, viewport });
    expect(() =>
      codec.decode(cursor, {
        ...baseFingerprint,
        viewport: { ...viewport, east: 6.4 },
      }),
    ).toThrow(PublicSearchError);
  });

  it('conserve le sentinel destination quand aucun viewport n’est fourni', () => {
    const codec = createPublicSearchCursorCodec(SECRET);
    const cursor = codec.encode(validTuple, baseFingerprint);
    const [payloadB64] = cursor.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8')) as {
      f: { a: unknown };
    };
    expect(payload.f.a).toEqual({ k: 'D' });
  });

  it('refuse un TIME_RANGE avec un DAY_RANGE', () => {
    const codec = createPublicSearchCursorCodec(SECRET);
    const cursor = codec.encode(validTuple, baseFingerprint);
    const dayIntent: PublicSearchIntent = {
      kind: 'DAY_RANGE',
      startDate: '2026-08-08',
      endDateExclusive: '2026-08-09',
    };
    const otherFingerprint = { ...baseFingerprint, canonicalIntent: dayIntent };
    expect(() => codec.decode(cursor, otherFingerprint)).toThrow(PublicSearchError);
  });

  it('refuse un mauvais secret', () => {
    const codec = createPublicSearchCursorCodec(SECRET);
    const cursor = codec.encode(validTuple, baseFingerprint);
    const otherCodec = createPublicSearchCursorCodec(
      'another-secret-of-at-least-32-bytes-for-tests',
    );
    expect(() => otherCodec.decode(cursor, baseFingerprint)).toThrow(PublicSearchError);
  });

  it('refuse une signature tronquée', () => {
    const codec = createPublicSearchCursorCodec(SECRET);
    const cursor = codec.encode(validTuple, baseFingerprint);
    const tampered = cursor.slice(0, cursor.indexOf('.') + 1) + 'abc';
    expect(() => codec.decode(tampered, baseFingerprint)).toThrow(PublicSearchError);
  });

  it('refuse une mauvaise version de contrat', () => {
    const codec = createPublicSearchCursorCodec(SECRET);
    const cursor = codec.encode(validTuple, baseFingerprint);
    const otherFingerprint = { ...baseFingerprint, contractVersion: 99 };
    expect(() => codec.decode(cursor, otherFingerprint)).toThrow(PublicSearchError);
  });

  it('refuse un payload sans signature', () => {
    const codec = createPublicSearchCursorCodec(SECRET);
    expect(() => codec.decode('plain-payload', baseFingerprint)).toThrow(PublicSearchError);
  });

  it('refuse un secret de moins de 32 octets', () => {
    expect(() => createPublicSearchCursorCodec('short-secret')).toThrow(PublicSearchError);
  });

  it('refuse une propriété supplémentaire dans le payload', () => {
    const codec = createPublicSearchCursorCodec(SECRET);
    const cursor = codec.encode(validTuple, baseFingerprint);
    const [payloadB64, sig] = cursor.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));
    payload.x = 'extra';
    const newPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const tampered = `${newPayload}.${sig}`;
    expect(() => codec.decode(tampered, baseFingerprint)).toThrow(PublicSearchError);
  });

  it('refuse une propriété supplémentaire dans le tuple keyset', () => {
    const codec = createPublicSearchCursorCodec(SECRET);
    const cursor = codec.encode(validTuple, baseFingerprint);
    const [payloadB64, sig] = cursor.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));
    payload.k.extra = 'x';
    const newPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const tampered = `${newPayload}.${sig}`;
    expect(() => codec.decode(tampered, baseFingerprint)).toThrow(PublicSearchError);
  });

  it('refuse une propriété supplémentaire dans l empreinte', () => {
    const codec = createPublicSearchCursorCodec(SECRET);
    const cursor = codec.encode(validTuple, baseFingerprint);
    const [payloadB64, sig] = cursor.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));
    payload.f.extra = 'x';
    const newPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const tampered = `${newPayload}.${sig}`;
    expect(() => codec.decode(tampered, baseFingerprint)).toThrow(PublicSearchError);
  });
});
