import { describe, it, expect } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { resolvePublicBookingAuthority } from './resolve-public-booking-authority';

describe('resolvePublicBookingAuthority — tests unitaires', () => {
  const dummyDb = {} as unknown as DatabaseClient;
  const validUuid = '11111111-1111-4111-8111-111111111111';

  it('1. Rejette INVALID_INPUT si publicProductId est manquant ou non-UUID', async () => {
    const res1 = await resolvePublicBookingAuthority(dummyDb, {
      publicProductId: '',
      publicLocationId: validUuid,
      publicVariantId: validUuid,
    });
    expect(res1.kind).toBe('INVALID_INPUT');

    const res2 = await resolvePublicBookingAuthority(dummyDb, {
      publicProductId: 'not-a-uuid',
      publicLocationId: validUuid,
      publicVariantId: validUuid,
    });
    expect(res2.kind).toBe('INVALID_INPUT');
  });

  it('2. Rejette INVALID_INPUT si publicLocationId est manquant ou non-UUID', async () => {
    const res = await resolvePublicBookingAuthority(dummyDb, {
      publicProductId: validUuid,
      publicLocationId: 'invalid',
      publicVariantId: validUuid,
    });
    expect(res.kind).toBe('INVALID_INPUT');
  });

  it('3. Rejette INVALID_INPUT si publicVariantId est manquant ou non-UUID', async () => {
    const res = await resolvePublicBookingAuthority(dummyDb, {
      publicProductId: validUuid,
      publicLocationId: validUuid,
      publicVariantId: 'invalid',
    });
    expect(res.kind).toBe('INVALID_INPUT');
  });

  it('4. Rejette INVALID_INPUT si l’entrée est null ou non-objet', async () => {
    const res = await resolvePublicBookingAuthority(
      dummyDb,
      null as unknown as {
        publicProductId: string;
        publicLocationId: string;
        publicVariantId: string;
      },
    );
    expect(res.kind).toBe('INVALID_INPUT');
  });
});
