import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { MVP_ORGANIZATION_CURRENCY, normalizeMvpOrganizationCurrency } from './organizations';

describe('organisation currency in the MVP', () => {
  it('normalizes the only supported currency', () => {
    expect(MVP_ORGANIZATION_CURRENCY).toBe('EUR');
    expect(normalizeMvpOrganizationCurrency(' eur ')).toBe('EUR');
    expect(normalizeMvpOrganizationCurrency()).toBe('EUR');
  });

  it('rejects a currency that the public booking and payment flows cannot handle', () => {
    expect(() => normalizeMvpOrganizationCurrency('USD')).toThrow('EUR');
    expect(() => normalizeMvpOrganizationCurrency('EUROPE')).toThrow('EUR');
  });
});

describe('updateOrganizationLegalSettings', () => {
  it('rejette des données légales avec un SIRET invalide (échec Luhn)', async () => {
    const { updateOrganizationLegalSettings } = await import('./organizations');
    const mockDb = {} as unknown as DatabaseClient;

    await expect(
      updateOrganizationLegalSettings(mockDb, 'org-1', {
        legalName: 'Test SAS',
        registrationNumber: '11111111111111', // invalide
      }),
    ).rejects.toThrow('SIRET');
  });

  it('rejette des données légales avec un code postal invalide', async () => {
    const { updateOrganizationLegalSettings } = await import('./organizations');
    const mockDb = {} as unknown as DatabaseClient;

    await expect(
      updateOrganizationLegalSettings(mockDb, 'org-1', {
        legalName: 'Test SAS',
        registrationNumber: '732 829 320 00074', // valide
        registeredOfficePostalCode: '740', // trop court
      }),
    ).rejects.toThrow('code postal');
  });

  it('exécute la mise à jour transactionnelle et l’audit log sur données valides', async () => {
    const { updateOrganizationLegalSettings } = await import('./organizations');

    const updatedRow = {
      id: 'org-1',
      legalName: 'Outdoor Rent SAS',
      publicDisplayName: 'Les Vélos du Lac',
      slug: 'outdoor-rent',
      status: 'ACTIVE' as const,
      isProfessional: true,
      defaultCurrency: 'EUR',
      defaultCancellationPolicyCode: 'FLEXIBLE' as const,
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
    };

    const mockTx = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedRow]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue([]),
      }),
    };

    const mockDb = {
      transaction: vi.fn().mockImplementation(async (callback) => callback(mockTx)),
    } as unknown as DatabaseClient;

    const result = await updateOrganizationLegalSettings(mockDb, 'org-1', {
      legalName: 'Outdoor Rent SAS',
      legalForm: 'SAS',
      registrationNumber: '732 829 320 00074',
      vatNumber: 'FR44732829320',
      registryCity: 'Annecy',
      registeredOfficePostalCode: '74000',
      registeredOfficeCity: 'Annecy',
      actorUserId: 'user-1',
    });

    expect(result.id).toBe('org-1');
    expect(result.legalForm).toBe('SAS');
    expect(result.registrationNumber).toBe('73282932000074');
    expect(mockTx.insert).toHaveBeenCalled();
  });
});
