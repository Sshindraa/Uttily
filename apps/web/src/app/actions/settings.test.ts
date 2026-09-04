import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AuthenticatedUser } from '@uttily/core';
import type { DatabaseClient } from '@uttily/database';
import * as auth from '@/lib/auth';
import * as dbLib from '@/lib/db';
import {
  updateCompanySettingsAction,
  updateCompanyLegalSettingsAction,
  updateCancellationPolicyAction,
} from './settings';

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@uttily/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uttily/core')>();
  return {
    ...actual,
    getMembership: vi.fn(),
    updateOrganizationPublicSettings: vi.fn(),
    updateOrganizationCancellationPolicy: vi.fn(),
    updateOrganizationLegalSettings: vi.fn(),
  };
});

describe('Settings Server Actions', () => {
  const user: AuthenticatedUser = {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'admin@example.com',
    emailVerified: true,
    isPlatformAdmin: false,
    oidcSubject: 'sub_1',
  };
  const orgId = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updateCompanySettingsAction : rejette si non authentifié', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(null);
    await expect(
      updateCompanySettingsAction(orgId, { publicDisplayName: 'Vélo Express' }),
    ).rejects.toThrow('Non authentifié');
  });

  it('updateCompanySettingsAction : rejette si rôle insuffisant (ex : STAFF)', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);
    vi.spyOn(dbLib, 'getDb').mockReturnValueOnce({} as DatabaseClient);
    const { getMembership } = await import('@uttily/core');
    vi.mocked(getMembership).mockResolvedValueOnce({
      organizationId: orgId,
      userId: user.id,
      role: 'STAFF',
      status: 'ACTIVE',
    });

    await expect(
      updateCompanySettingsAction(orgId, { publicDisplayName: 'Vélo Express' }),
    ).rejects.toThrow('Permission refusée');
  });

  it('updateCancellationPolicyAction : rejette si non authentifié', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(null);
    await expect(updateCancellationPolicyAction(orgId, 'MODERATE')).rejects.toThrow(
      'Non authentifié',
    );
  });

  it('updateCancellationPolicyAction : rejette si rôle insuffisant (ex : MANAGER)', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);
    vi.spyOn(dbLib, 'getDb').mockReturnValueOnce({} as DatabaseClient);
    const { getMembership } = await import('@uttily/core');
    vi.mocked(getMembership).mockResolvedValueOnce({
      organizationId: orgId,
      userId: user.id,
      role: 'MANAGER',
      status: 'ACTIVE',
    });

    await expect(updateCancellationPolicyAction(orgId, 'MODERATE')).rejects.toThrow(
      'Permission refusée',
    );
  });

  it('updateCompanyLegalSettingsAction : rejette si non authentifié', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(null);
    await expect(
      updateCompanyLegalSettingsAction(orgId, {
        legalName: 'Test SAS',
        registrationNumber: '732 829 320 00074',
      }),
    ).rejects.toThrow('Non authentifié');
  });

  it('updateCompanyLegalSettingsAction : rejette si rôle insuffisant (ex : STAFF)', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);
    vi.spyOn(dbLib, 'getDb').mockReturnValueOnce({} as DatabaseClient);
    const { getMembership } = await import('@uttily/core');
    vi.mocked(getMembership).mockResolvedValueOnce({
      organizationId: orgId,
      userId: user.id,
      role: 'STAFF',
      status: 'ACTIVE',
    });

    await expect(
      updateCompanyLegalSettingsAction(orgId, {
        legalName: 'Test SAS',
        registrationNumber: '732 829 320 00074',
      }),
    ).rejects.toThrow('Permission refusée');
  });

  it('updateCompanyLegalSettingsAction : met à jour avec succès pour OWNER/ADMIN', async () => {
    vi.spyOn(auth, 'getAuthenticatedUser').mockResolvedValueOnce(user);
    vi.spyOn(dbLib, 'getDb').mockReturnValueOnce({} as DatabaseClient);
    const { getMembership, updateOrganizationLegalSettings } = await import('@uttily/core');
    vi.mocked(getMembership).mockResolvedValueOnce({
      organizationId: orgId,
      userId: user.id,
      role: 'OWNER',
      status: 'ACTIVE',
    });
    vi.mocked(updateOrganizationLegalSettings).mockResolvedValueOnce({
      id: orgId,
      legalName: 'Outdoor Rent SAS',
      publicDisplayName: 'Les Vélos du Lac',
      slug: 'outdoor-rent',
      status: 'ACTIVE',
      isProfessional: true,
      defaultCurrency: 'EUR',
      defaultCancellationPolicyCode: 'FLEXIBLE',
      legalForm: 'SAS',
      registrationNumber: '73282932000074',
      vatNumber: 'FR44732829320',
      registryCity: 'Annecy',
      capitalAmount: '10 000 €',
      legalRepresentativeName: 'Camille Martin',
      registeredOfficeAddress: '15 Quai de la Tournette',
      registeredOfficePostalCode: '74000',
      registeredOfficeCity: 'Annecy',
      registeredOfficeCountryCode: 'FR',
    });

    const result = await updateCompanyLegalSettingsAction(orgId, {
      legalName: 'Outdoor Rent SAS',
      legalForm: 'SAS',
      registrationNumber: '732 829 320 00074',
      vatNumber: 'FR44732829320',
      registryCity: 'Annecy',
      registeredOfficePostalCode: '74000',
      registeredOfficeCity: 'Annecy',
    });

    expect(result.organization.legalForm).toBe('SAS');
    expect(result.organization.registrationNumber).toBe('73282932000074');
    expect(updateOrganizationLegalSettings).toHaveBeenCalledWith(
      expect.anything(),
      orgId,
      expect.objectContaining({
        legalName: 'Outdoor Rent SAS',
        actorUserId: user.id,
      }),
    );
  });
});
