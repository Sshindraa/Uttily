import { and, eq, inArray, isNull } from 'drizzle-orm';
import { categories, productPhotos, products } from '@uttily/database';
import { COMMERCIAL_EQUIPMENT_FAMILY_SLUGS } from '@uttily/core';
import { getDb } from '@/lib/db';
import { getProductPhotoStorage } from '@/lib/product-photo-storage';
import { isValidUuid } from '@/lib/validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ publicPhotoId: string }> },
): Promise<Response> {
  const { publicPhotoId } = await params;
  if (!isValidUuid(publicPhotoId)) return new Response('Not found', { status: 404 });
  const db = getDb();
  const [photo] = await db
    .select({
      storageKey: productPhotos.storageKey,
      contentType: productPhotos.contentType,
      widthPx: productPhotos.widthPx,
      heightPx: productPhotos.heightPx,
    })
    .from(productPhotos)
    .innerJoin(products, eq(products.id, productPhotos.productId))
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(
      and(
        eq(productPhotos.publicId, publicPhotoId),
        eq(productPhotos.fileState, 'AVAILABLE'),
        isNull(productPhotos.deletedAt),
        eq(products.publicationStatus, 'PUBLISHED'),
        isNull(products.deletedAt),
        eq(categories.isActive, true),
        inArray(categories.slug, [...COMMERCIAL_EQUIPMENT_FAMILY_SLUGS]),
      ),
    )
    .limit(1);

  if (!photo || !isAllowedContentType(photo.contentType)) {
    return new Response('Not found', { status: 404 });
  }

  try {
    const content = await getProductPhotoStorage().get(photo.storageKey);
    return new Response(Buffer.from(content), {
      status: 200,
      headers: {
        'Content-Type': photo.contentType,
        'Content-Length': String(content.byteLength),
        // URL publique contrôlée par l'application ; le CDN/proxy peut mettre
        // en cache une version validée sans exposer le bucket R2.
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new Response('Image temporarily unavailable', { status: 503 });
  }
}

function isAllowedContentType(
  value: string | null,
): value is 'image/jpeg' | 'image/png' | 'image/webp' {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/webp';
}
