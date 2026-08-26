import { and, eq, isNull } from 'drizzle-orm';
import { productPhotos } from '@uttily/database';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import { getProductPhotoStorage } from '@/lib/product-photo-storage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgId: string; productId: string; photoId: string }> },
): Promise<Response> {
  const { orgId, productId, photoId } = await params;
  try {
    const { db, organizationId } = await requireCatalogViewerOf(orgId);
    const [photo] = await db
      .select({ storageKey: productPhotos.storageKey, contentType: productPhotos.contentType })
      .from(productPhotos)
      .where(
        and(
          eq(productPhotos.id, photoId),
          eq(productPhotos.organizationId, organizationId),
          eq(productPhotos.productId, productId),
          eq(productPhotos.fileState, 'AVAILABLE'),
          isNull(productPhotos.deletedAt),
        ),
      )
      .limit(1);
    if (!photo || !isAllowedContentType(photo.contentType))
      return new Response('Not found', { status: 404 });
    const content = await getProductPhotoStorage().get(photo.storageKey);
    return new Response(Buffer.from(content), {
      status: 200,
      headers: {
        'Content-Type': photo.contentType,
        'Content-Length': String(content.byteLength),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function isAllowedContentType(
  value: string | null,
): value is 'image/jpeg' | 'image/png' | 'image/webp' {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/webp';
}
