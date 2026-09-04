import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { getAuthenticatedUserMock, getUserPrivacyRequestsMock, redirectMock } = vi.hoisted(() => ({
  getAuthenticatedUserMock: vi.fn(),
  getUserPrivacyRequestsMock: vi.fn(),
  redirectMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: getAuthenticatedUserMock,
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({})),
}));

vi.mock('next/navigation', () => ({
  redirect: redirectMock,
}));

vi.mock('@clerk/nextjs', () => ({
  useClerk: () => ({
    signOut: vi.fn(),
  }),
}));

vi.mock('@uttily/core', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@uttily/core');
  return {
    ...actual,
    getUserPrivacyRequests: getUserPrivacyRequestsMock,
  };
});

const { default: AccountPrivacyPage, generateMetadata } = await import('./page');

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'features',
  'privacy',
  'privacy-view.tsx',
);

describe('AccountPrivacyPage (Lot 21-P1)', () => {
  const user = { id: '00000000-0000-4000-8000-000000000001' };
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');

  beforeEach(() => {
    getAuthenticatedUserMock.mockReset();
    getUserPrivacyRequestsMock.mockReset();
    redirectMock.mockReset();
  });

  it('génère les métadonnées bilingues', async () => {
    const metaFr = await generateMetadata({ params: Promise.resolve({ locale: 'fr' }) });
    expect(metaFr.title).toContain('Confidentialité');

    const metaEn = await generateMetadata({ params: Promise.resolve({ locale: 'en' }) });
    expect(metaEn.title).toContain('Privacy');
  });

  it('exige une authentification locataire et redirige vers sign-in si absent', async () => {
    expect(pageSource).toContain('getAuthenticatedUser()');
    expect(pageSource).toContain('redirect(');
    expect(pageSource).toContain('sign-in?redirect_url=');
  });

  it('redirige vers sign-in si non authentifié à l’exécution', async () => {
    getAuthenticatedUserMock.mockResolvedValue(null);

    await AccountPrivacyPage({ params: Promise.resolve({ locale: 'fr' }) });
    expect(redirectMock).toHaveBeenCalledWith(expect.stringContaining('/sign-in'));
  });

  it('affiche les boutons de téléchargement d’export Art. 15 et Art. 20', () => {
    expect(featureSource).toContain('/api/account/privacy/export');
    expect(featureSource).toContain('/api/account/privacy/export?scope=portability');
    expect(featureSource).toContain('id="btn-export-access"');
    expect(featureSource).toContain('id="btn-export-portability"');
  });

  it('rend la vue avec les demandes existantes si authentifié', async () => {
    getAuthenticatedUserMock.mockResolvedValue(user);
    getUserPrivacyRequestsMock.mockResolvedValue([
      {
        id: 'req-00000001-0000-0000-0000-000000000000',
        requestType: 'ACCESS',
        status: 'RECEIVED',
        receivedAt: new Date('2026-09-03T10:00:00.000Z'),
        responseDueAt: new Date('2026-10-03T10:00:00.000Z'),
        extendedUntil: null,
        resolvedAt: null,
      },
    ]);

    const page = await AccountPrivacyPage({ params: Promise.resolve({ locale: 'fr' }) });
    const html = renderToStaticMarkup(page);

    expect(html).toContain('Confidentialité et données personnelles');
    expect(html).toContain('Télécharger ma copie (Art. 15)');
    expect(html).toContain('Exporter mes données (Art. 20)');
    expect(html).toContain('Historique de vos demandes');
    expect(html).toContain('Reçue');
  });
});
