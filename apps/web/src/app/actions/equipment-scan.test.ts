import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AuthorizationError, type AuthenticatedUser } from '@uttily/core';
import * as catalogAuth from '@/lib/catalog-auth';
import { scanEquipmentPhotoAction } from './equipment-scan';

vi.mock('@/lib/catalog-auth', () => ({
  requireCatalogManagerOf: vi.fn(),
}));

describe('scanEquipmentPhotoAction', () => {
  const orgId = '00000000-0000-0000-0000-000000000001';
  const dummyUser: AuthenticatedUser = {
    id: 'u-1',
    email: 'user@example.com',
    oidcSubject: 'sub-1',
    emailVerified: true,
    isPlatformAdmin: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejette une requête sans photo', async () => {
    const formData = new FormData();
    const res = await scanEquipmentPhotoAction(
      orgId,
      { ok: false, code: 'UNKNOWN', message: '' },
      formData,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('VALIDATION');
      expect(res.message).toContain('photo');
    }
  });

  it('rejette une photo dépassant 10 Mo', async () => {
    const largeBlob = new Uint8Array(11 * 1024 * 1024);
    const file = new File([largeBlob], 'giant.jpg', { type: 'image/jpeg' });
    const formData = new FormData();
    formData.append('photo', file);

    const res = await scanEquipmentPhotoAction(
      orgId,
      { ok: false, code: 'UNKNOWN', message: '' },
      formData,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('VALIDATION');
      expect(res.message).toContain('10 Mo');
    }
  });

  it('exécute l’analyse et retourne la proposition avec succès pour un gestionnaire de catalogue', async () => {
    vi.mocked(catalogAuth.requireCatalogManagerOf).mockResolvedValue({
      user: dummyUser,
      db: {} as any,
      organizationId: orgId,
    });

    const smallContent = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic bytes
    const file = new File([smallContent], 'velo.jpg', { type: 'image/jpeg' });
    const formData = new FormData();
    formData.append('photo', file);

    const res = await scanEquipmentPhotoAction(
      orgId,
      { ok: false, code: 'UNKNOWN', message: '' },
      formData,
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toBeDefined();
      expect(res.data.brand).toBeDefined();
      expect(res.data.model).toBeDefined();
      expect(res.data.categorySlug).toBeDefined();
      expect(res.data.specifications).toBeDefined();
    }
  });

  it('bloque l’accès si requireCatalogManagerOf lève une erreur', async () => {
    vi.mocked(catalogAuth.requireCatalogManagerOf).mockRejectedValue(
      new AuthorizationError('Accès interdit : permissions insuffisantes.'),
    );

    const smallContent = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const file = new File([smallContent], 'velo.jpg', { type: 'image/jpeg' });
    const formData = new FormData();
    formData.append('photo', file);

    const res = await scanEquipmentPhotoAction(
      orgId,
      { ok: false, code: 'UNKNOWN', message: '' },
      formData,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain('Accès interdit');
    }
  });
});
