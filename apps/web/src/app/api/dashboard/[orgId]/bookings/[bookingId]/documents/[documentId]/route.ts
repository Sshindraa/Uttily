import { and, eq } from 'drizzle-orm';
import { bookings, documents } from '@uttily/database';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import { isValidUuid } from '@/lib/validation';
import { getTransactionalDocumentStorage } from '@/lib/transactional-document-storage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgId: string; bookingId: string; documentId: string }> },
): Promise<Response> {
  const { orgId, bookingId, documentId } = await params;
  if (!isValidUuid(orgId) || !isValidUuid(bookingId) || !isValidUuid(documentId)) {
    return new Response('Not found', { status: 404 });
  }

  try {
    const { db } = await requireFulfillmentOperatorOf(orgId);

    // Contrôle strict de propriété : le document doit appartenir à la réservation de l'organisation
    const docRows = await db
      .select({
        id: documents.id,
        storageKey: documents.storageKey,
        contentType: documents.contentType,
        type: documents.type,
        sizeBytes: documents.sizeBytes,
      })
      .from(documents)
      .innerJoin(bookings, eq(documents.bookingId, bookings.id))
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.organizationId, orgId),
          eq(bookings.id, bookingId),
          eq(bookings.organizationId, orgId),
        ),
      )
      .limit(1);

    if (docRows.length === 0) {
      return new Response('Not found', { status: 404 });
    }

    const doc = docRows[0]!;
    const storage = getTransactionalDocumentStorage();
    const content = await storage.get(doc.storageKey);

    return new Response(Buffer.from(content), {
      status: 200,
      headers: {
        'Content-Type': doc.contentType || 'application/pdf',
        'Content-Disposition': `inline; filename="uttily-${doc.type.toLowerCase()}-${doc.id.slice(0, 8)}.pdf"`,
        'Cache-Control': 'private, no-cache, no-store, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
