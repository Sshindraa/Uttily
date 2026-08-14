import { describe, expect, it } from 'vitest';
import {
  createSupplementBookingAmendment,
  buildSupplementProviderIdempotencyKey,
} from './create-supplement-booking-amendment';

const actor = {
  id: '00000000-0000-4000-8000-000000000001',
  oidcSubject: 'test',
  email: 'test@example.com',
  emailVerified: true,
  isPlatformAdmin: false,
};

describe('createSupplementBookingAmendment — contrat local C1', () => {
  it('refuse une commande invalide sans atteindre la base', async () => {
    const result = await createSupplementBookingAmendment(
      {} as never,
      actor,
      '00000000-0000-4000-8000-000000000002',
      {
        bookingId: 'bad',
        expectedLastAppliedAmendmentNumber: 0,
        intent: { kind: 'TIME_RANGE', startAt: 'bad', endAt: 'bad' },
        desiredLines: [],
        idempotencyKey: 'invalid',
      },
    );
    expect(result).toMatchObject({ kind: 'INVALID_INPUT' });
  });

  it('construit la clé provider déterministe exigée par ADR-023', () => {
    expect(buildSupplementProviderIdempotencyKey('payment-id', 1)).toBe(
      'pi_amendment_payment-id_1',
    );
    expect(buildSupplementProviderIdempotencyKey('payment-id', 2)).toBe(
      'pi_amendment_payment-id_2',
    );
  });

  it('retourne INVALID_INPUT pour une organisation invalide et FORBIDDEN pour un actor invalide', async () => {
    const command = {
      bookingId: actor.id,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE' as const,
        startDate: '2026-03-10',
        endDateExclusive: '2026-03-11',
      },
      desiredLines: [{ variantId: actor.id, quantity: 1 }],
      idempotencyKey: 'validation-boundaries',
    };
    await expect(
      createSupplementBookingAmendment({} as never, actor, 'not-an-organization-id', command),
    ).resolves.toMatchObject({ kind: 'INVALID_INPUT' });
    await expect(
      createSupplementBookingAmendment(
        {} as never,
        { ...actor, id: 'not-an-actor-id' },
        '00000000-0000-4000-8000-000000000002',
        command,
      ),
    ).resolves.toMatchObject({ kind: 'FORBIDDEN' });
  });

  it('retourne INVALID_INPUT pour une Date now invalide ou non représentable', async () => {
    const command = {
      bookingId: actor.id,
      expectedLastAppliedAmendmentNumber: 0,
      intent: {
        kind: 'DAY_RANGE' as const,
        startDate: '2026-03-10',
        endDateExclusive: '2026-03-11',
      },
      desiredLines: [{ variantId: actor.id, quantity: 1 }],
      idempotencyKey: 'invalid-now',
    };
    await expect(
      createSupplementBookingAmendment(
        {} as never,
        actor,
        '00000000-0000-4000-8000-000000000002',
        command,
        { now: new Date(Number.NaN) },
      ),
    ).resolves.toMatchObject({ kind: 'INVALID_INPUT' });
    await expect(
      createSupplementBookingAmendment(
        {} as never,
        actor,
        '00000000-0000-4000-8000-000000000002',
        command,
        { now: new Date(8_640_000_000_000_000) },
      ),
    ).resolves.toMatchObject({ kind: 'INVALID_INPUT' });
  });
});
