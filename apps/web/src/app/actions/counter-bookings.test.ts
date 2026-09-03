import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AuthenticatedUser } from '@uttily/core';
import type { DatabaseClient } from '@uttily/database';
import * as auth from '@/lib/auth';
import * as dbLib from '@/lib/db';
import { getCounterAvailableItemsAction, createCounterBookingAction } from './counter-bookings';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}));

vi.mock('@uttily/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uttily/core')>();
  return {
    ...actual,
    getMembership: vi.fn().mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000099',
      organizationId: '00000000-0000-0000-0000-000000000010',
      userId: '00000000-0000-0000-0000-000000000001',
      role: 'STAFF',
      status: 'ACTIVE',
    }),
    requireFulfillmentOperator: vi.fn(),
    getCounterAvailableItems: vi.fn(),
    createCounterBooking: vi.fn(),
  };
});

describe('Counter Bookings Server Actions (Lot 21-U2-AD)', () => {
  const user: AuthenticatedUser = {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'operator@example.com',
    emailVerified: true,
    isPlatformAdmin: false,
    oidcSubject: 'sub_operator_1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getCounterAvailableItemsAction', () => {
    it('retourne une erreur si l’utilisateur n’est pas connecté', async () => {
      vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(null);

      const result = await getCounterAvailableItemsAction({
        organizationId: '00000000-0000-0000-0000-000000000010',
        locationId: '00000000-0000-0000-0000-000000000020',
        startAtIso: '2026-09-10T10:00:00Z',
        endAtIso: '2026-09-10T14:00:00Z',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('UNAUTHENTICATED');
      }
    });

    it('retourne la liste des matériels disponibles avec succès', async () => {
      vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);
      vi.spyOn(dbLib, 'getDb').mockReturnValueOnce({} as DatabaseClient);

      const { getCounterAvailableItems } = await import('@uttily/core');
      vi.mocked(getCounterAvailableItems).mockResolvedValueOnce({
        location: {
          id: '00000000-0000-0000-0000-000000000020',
          name: 'Chamonix Base',
          timeZone: 'Europe/Paris',
        },
        startAt: new Date('2026-09-10T10:00:00Z'),
        endAt: new Date('2026-09-10T14:00:00Z'),
        items: [
          {
            id: '00000000-0000-0000-0000-000000000030',
            internalSku: 'VTT-001',
            serialNumber: 'SN-1234',
            condition: 'NEW',
            variantId: '00000000-0000-0000-0000-000000000040',
            variantName: 'Taille M',
            variantAttributes: { size: 'M' },
            productId: '00000000-0000-0000-0000-000000000050',
            productName: 'VTT Electrique',
            categorySlug: 'velos',
            categoryName: 'Vélos',
          },
        ],
      });

      const result = await getCounterAvailableItemsAction({
        organizationId: '00000000-0000-0000-0000-000000000010',
        locationId: '00000000-0000-0000-0000-000000000020',
        startAtIso: '2026-09-10T10:00:00Z',
        endAtIso: '2026-09-10T14:00:00Z',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.items).toHaveLength(1);
        expect(result.data.items[0]?.internalSku).toBe('VTT-001');
      }
    });
  });

  describe('createCounterBookingAction', () => {
    it('valide et crée une réservation au comptoir avec succès', async () => {
      vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);
      vi.spyOn(dbLib, 'getDb').mockReturnValueOnce({} as DatabaseClient);

      const { createCounterBooking } = await import('@uttily/core');
      vi.mocked(createCounterBooking).mockResolvedValueOnce({
        bookingId: '00000000-0000-0000-0000-000000000088',
        bookingReference: '#UT-12ABCD',
        totalAmountMinor: 12000,
        status: 'CONFIRMED',
      });

      const result = await createCounterBookingAction({
        organizationId: '00000000-0000-0000-0000-000000000010',
        locationId: '00000000-0000-0000-0000-000000000020',
        channel: 'WALK_IN',
        customerName: 'Sophie Bernard',
        customerEmail: 'sophie@example.com',
        customerPhone: '+33698765432',
        startAtIso: '2026-09-10T10:00:00Z',
        endAtIso: '2026-09-10T14:00:00Z',
        itemIds: ['00000000-0000-0000-0000-000000000030'],
        paymentMethod: 'ON_SITE_CARD',
        idempotencyKey: 'idemp-test-action-1',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.bookingId).toBe('00000000-0000-0000-0000-000000000088');
        expect(result.data.bookingReference).toBe('#UT-12ABCD');
        expect(result.data.status).toBe('CONFIRMED');
      }
    });

    it('rejette si aucun équipement n’est sélectionné', async () => {
      vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);
      vi.spyOn(dbLib, 'getDb').mockReturnValueOnce({} as DatabaseClient);

      const result = await createCounterBookingAction({
        organizationId: '00000000-0000-0000-0000-000000000010',
        locationId: '00000000-0000-0000-0000-000000000020',
        channel: 'WALK_IN',
        customerName: 'Sophie Bernard',
        customerEmail: 'sophie@example.com',
        startAtIso: '2026-09-10T10:00:00Z',
        endAtIso: '2026-09-10T14:00:00Z',
        itemIds: [],
        paymentMethod: 'ON_SITE_CARD',
        idempotencyKey: 'idemp-test-empty',
      });

      expect(result.ok).toBe(false);
    });
  });
});
