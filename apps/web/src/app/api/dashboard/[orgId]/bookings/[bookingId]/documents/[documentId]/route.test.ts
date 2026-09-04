import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireFulfillmentOperatorOfMock, storageGetMock, getTransactionalDocumentStorageMock } =
  vi.hoisted(() => ({
    requireFulfillmentOperatorOfMock: vi.fn(),
    storageGetMock: vi.fn(),
    getTransactionalDocumentStorageMock: vi.fn(),
  }));

vi.mock('@/lib/fulfillment-auth', () => ({
  requireFulfillmentOperatorOf: requireFulfillmentOperatorOfMock,
}));

vi.mock('@/lib/transactional-document-storage', () => ({
  getTransactionalDocumentStorage: getTransactionalDocumentStorageMock,
}));

const { GET } = await import('./route');

const validOrgId = '00000000-0000-4000-8000-000000000001';
const validBookingId = '00000000-0000-4000-8000-000000000002';
const validDocId = '00000000-0000-4000-8000-000000000003';

function mockDbWithDocument(doc: Record<string, unknown> | null): unknown {
  const limit = vi.fn().mockResolvedValue(doc ? [doc] : []);
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  const select = vi.fn(() => ({ from }));
  return { select };
}

beforeEach(() => {
  requireFulfillmentOperatorOfMock.mockReset();
  storageGetMock.mockReset();
  getTransactionalDocumentStorageMock.mockReset();
  getTransactionalDocumentStorageMock.mockReturnValue({
    get: storageGetMock,
  });
});

describe('GET /api/dashboard/[orgId]/bookings/[bookingId]/documents/[documentId]', () => {
  it('répond 404 sans toucher au storage si un paramètre est invalide', async () => {
    const response = await GET(new Request('http://localhost/api/test'), {
      params: Promise.resolve({
        orgId: 'bad',
        bookingId: validBookingId,
        documentId: validDocId,
      }),
    });

    expect(response.status).toBe(404);
    expect(requireFulfillmentOperatorOfMock).not.toHaveBeenCalled();
  });

  it('répond 404 si requireFulfillmentOperatorOf rejette (non autorisé)', async () => {
    requireFulfillmentOperatorOfMock.mockRejectedValue(new Error('FORBIDDEN'));

    const response = await GET(new Request('http://localhost/api/test'), {
      params: Promise.resolve({
        orgId: validOrgId,
        bookingId: validBookingId,
        documentId: validDocId,
      }),
    });

    expect(response.status).toBe(404);
  });

  it('répond 404 si le document n existe pas ou appartient à une autre organisation', async () => {
    const mockDb = mockDbWithDocument(null);
    requireFulfillmentOperatorOfMock.mockResolvedValue({
      db: mockDb,
      organizationId: validOrgId,
      user: { id: 'user-1' },
    });

    const response = await GET(new Request('http://localhost/api/test'), {
      params: Promise.resolve({
        orgId: validOrgId,
        bookingId: validBookingId,
        documentId: validDocId,
      }),
    });

    expect(response.status).toBe(404);
  });

  it('sert le document PDF avec les en-têtes corrects si autorisé', async () => {
    const mockDb = mockDbWithDocument({
      id: validDocId,
      storageKey: 'docs/org/receipt.pdf',
      contentType: 'application/pdf',
      type: 'RECEIPT',
      sizeBytes: 1234,
    });
    requireFulfillmentOperatorOfMock.mockResolvedValue({
      db: mockDb,
      organizationId: validOrgId,
      user: { id: 'user-1' },
    });
    storageGetMock.mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46])); // %PDF

    const response = await GET(new Request('http://localhost/api/test'), {
      params: Promise.resolve({
        orgId: validOrgId,
        bookingId: validBookingId,
        documentId: validDocId,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Content-Disposition')).toContain('uttily-receipt');
    expect(response.headers.get('Cache-Control')).toContain('private');
  });
});
