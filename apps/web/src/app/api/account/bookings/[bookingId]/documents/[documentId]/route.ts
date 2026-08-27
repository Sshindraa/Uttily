import { and, eq } from 'drizzle-orm';
import { bookings, documents } from '@uttily/database';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { isValidUuid } from '@/lib/validation';
import { getProductPhotoStorage } from '@/lib/product-photo-storage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bookingId: string; documentId: string }> },
): Promise<Response> {
  const { bookingId, documentId } = await params;
  if (!isValidUuid(bookingId) || !isValidUuid(documentId)) {
    return new Response('Not found', { status: 404 });
  }

  const user = await getAuthenticatedUser();
  if (!user) {
    return new Response('Not found', { status: 404 }); // 404 pour ne pas leaker l'existence
  }

  const db = getDb();

  // Contrôle strict de propriété : le document doit appartenir à la réservation du locataire connecté
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
        eq(bookings.id, bookingId),
        eq(bookings.customerUserId, user.id),
      ),
    )
    .limit(1);

  if (docRows.length === 0) {
    return new Response('Not found', { status: 404 });
  }

  const doc = docRows[0]!;

  try {
    const storage = getProductPhotoStorage();
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
    return new Response('Document temporairement indisponible', { status: 503 });
  }
}
