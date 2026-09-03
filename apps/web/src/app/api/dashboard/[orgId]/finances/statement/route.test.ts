import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireFinancialViewerOfMock,
  getMerchantFinanceOverviewMock,
  generateCommissionStatementCsvMock,
} = vi.hoisted(() => ({
  requireFinancialViewerOfMock: vi.fn(),
  getMerchantFinanceOverviewMock: vi.fn(),
  generateCommissionStatementCsvMock: vi.fn(),
}));

vi.mock('@/lib/finances-auth', () => ({
  requireFinancialViewerOf: requireFinancialViewerOfMock,
}));

vi.mock('@uttily/core', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@uttily/core');
  return {
    ...actual,
    getMerchantFinanceOverview: getMerchantFinanceOverviewMock,
    generateCommissionStatementCsv: generateCommissionStatementCsvMock,
  };
});

const { GET } = await import('./route');

const validOrgId = '00000000-0000-4000-8000-000000000001';

function mockDbWithOrg(org: Record<string, unknown>): unknown {
  const limit = vi.fn().mockResolvedValue([org]);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select };
}

beforeEach(() => {
  requireFinancialViewerOfMock.mockReset();
  getMerchantFinanceOverviewMock.mockReset();
  generateCommissionStatementCsvMock.mockReset();
});

describe('GET /api/dashboard/[orgId]/finances/statement', () => {
  it('répond 401 si non authentifié', async () => {
    requireFinancialViewerOfMock.mockRejectedValue(new Error('UNAUTHENTICATED'));

    const response = await GET(new Request('http://localhost/api/test'), {
      params: Promise.resolve({ orgId: validOrgId }),
    });

    expect(response.status).toBe(401);
  });

  it('répond 403 si utilisateur non manager', async () => {
    requireFinancialViewerOfMock.mockRejectedValue(new Error('FORBIDDEN'));

    const response = await GET(new Request('http://localhost/api/test'), {
      params: Promise.resolve({ orgId: validOrgId }),
    });

    expect(response.status).toBe(403);
  });

  it('génère et renvoie le décompte CSV avec en-têtes comptables si autorisé', async () => {
    const mockDb = mockDbWithOrg({
      legalName: 'Outdoor Rent SAS',
      legalForm: 'SAS',
      registrationNumber: '73282932000074',
      vatNumber: 'FR44732829320',
      registryCity: 'Annecy',
    });

    requireFinancialViewerOfMock.mockResolvedValue({
      db: mockDb,
      organizationId: validOrgId,
      user: { id: 'user-1' },
    });

    getMerchantFinanceOverviewMock.mockResolvedValue({
      currency: 'EUR',
      period: { label: 'Août 2026' },
      activity: [],
    });

    generateCommissionStatementCsvMock.mockReturnValue('\uFEFF"DÉCOMPTE OFFICIEL";"100.00"');

    const response = await GET(new Request('http://localhost/api/test'), {
      params: Promise.resolve({ orgId: validOrgId }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/csv');
    expect(response.headers.get('Content-Disposition')).toContain('decompte-commissions-uttily');
    const text = await response.text();
    expect(text).toContain('DÉCOMPTE OFFICIEL');
  });
});
