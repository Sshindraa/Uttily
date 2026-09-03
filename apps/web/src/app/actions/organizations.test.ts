import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AuthenticatedUser } from '@uttily/core';
import type { DatabaseClient } from '@uttily/database';
import * as auth from '@/lib/auth';
import * as dbLib from '@/lib/db';
import { createOrganizationAction } from './organizations';

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
    createOrganizationForUser: vi.fn(),
  };
});

describe('Organizations Server Actions', () => {
  const user: AuthenticatedUser = {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'loueur@example.com',
    emailVerified: true,
    isPlatformAdmin: false,
    oidcSubject: 'sub_1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejette la création si l’utilisateur n’est pas authentifié', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(null);
    await expect(
      createOrganizationAction({ legalName: 'Mon Shop', proTermsAccepted: true }),
    ).rejects.toThrow('Non authentifié.');
  });

  it('rejette la création si les Conditions Générales Partenaires ne sont pas acceptées', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);
    await expect(
      createOrganizationAction({ legalName: 'Mon Shop', proTermsAccepted: false }),
    ).rejects.toThrow('L’acceptation des Conditions Générales Partenaires');
  });

  it('appelle createOrganizationForUser et revalide le dashboard en cas de succès', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);
    vi.spyOn(dbLib, 'getDb').mockReturnValueOnce({} as DatabaseClient);
    const { createOrganizationForUser } = await import('@uttily/core');
    vi.mocked(createOrganizationForUser).mockResolvedValueOnce({
      organization: {
        id: '11111111-1111-1111-1111-111111111111',
        legalName: 'Mon Shop',
        publicDisplayName: null,
        slug: 'mon-shop',
        status: 'ACTIVE',
        isProfessional: true,
        defaultCurrency: 'EUR',
        defaultCancellationPolicyCode: 'FLEXIBLE',
        legalForm: null,
        registrationNumber: null,
        vatNumber: null,
        registryCity: null,
        capitalAmount: null,
        legalRepresentativeName: null,
        registeredOfficeAddress: null,
        registeredOfficePostalCode: null,
        registeredOfficeCity: null,
        registeredOfficeCountryCode: 'FR',
      },
    });

    const result = await createOrganizationAction({
      legalName: 'Mon Shop',
      proTermsAccepted: true,
      proTermsVersion: 'v1',
    });

    expect(result.organization.slug).toBe('mon-shop');
    expect(createOrganizationForUser).toHaveBeenCalledWith(
      expect.anything(),
      user,
      expect.objectContaining({ proTermsAccepted: true, proTermsVersion: 'v1' }),
    );
  });
});
