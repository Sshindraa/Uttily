import { eq, inArray } from 'drizzle-orm';
import type { DbExecutor } from '@uttily/database';
import {
  users,
  bookings,
  bookingLines,
  locations,
  products,
  productVariants,
  categories,
} from '@uttily/database';
import type { Article20PortableData } from './types';

/**
 * Construit le dataset portable au sens de l'article 20 du RGPD.
 *
 * Périmètre strictement limité aux données :
 * 1. Fournies par l'utilisateur ou générées par son utilisation directe.
 * 2. Traitées sur la base du contrat (art. 6.1.b) ou du consentement (art. 6.1.a).
 * 3. Par un traitement automatisé.
 *
 * Exclusions :
 * - Données dérivées/calculées (commissions, statuts internes, scores).
 * - Données de tiers (identité du loueur, constats d'état effectués par le loueur).
 * - Données soumises à conservation légale (factures, pièces comptables).
 * - Données de sécurité (logs, sessions, IP).
 */
export async function buildPortableData(
  db: DbExecutor,
  userId: string,
): Promise<Article20PortableData> {
  // 1. Profil fourni par l'utilisateur
  const [user] = await db
    .select({
      email: users.email,
      displayName: users.displayName,
      locale: users.locale,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw new Error('Utilisateur non trouvé.');
  }

  // 2. Réservations initiées par l'utilisateur
  const bookingRows = await db
    .select({
      bookingId: bookings.id,
      customerStartAt: bookings.customerStartAt,
      customerEndAt: bookings.customerEndAt,
      timezone: bookings.timezone,
      locationName: locations.name,
    })
    .from(bookings)
    .innerJoin(locations, eq(bookings.locationId, locations.id))
    .where(eq(bookings.customerUserId, userId));

  const bookingIds = bookingRows.map((b) => b.bookingId);

  // 3. Lignes de réservation (équipements demandés)
  const lineRows =
    bookingIds.length > 0
      ? await db
          .select({
            bookingId: bookingLines.bookingId,
            categoryName: categories.name,
            variantName: productVariants.name,
          })
          .from(bookingLines)
          .innerJoin(productVariants, eq(bookingLines.variantId, productVariants.id))
          .innerJoin(products, eq(productVariants.productId, products.id))
          .innerJoin(categories, eq(products.categoryId, categories.id))
          .where(inArray(bookingLines.bookingId, bookingIds))
      : [];

  const linesByBooking = new Map<string, Array<{ categoryName: string; variantLabel: string }>>();
  for (const line of lineRows) {
    const arr = linesByBooking.get(line.bookingId) ?? [];
    arr.push({ categoryName: line.categoryName, variantLabel: line.variantName ?? '' });
    linesByBooking.set(line.bookingId, arr);
  }

  return {
    profileProvided: {
      email: user.email,
      displayName: user.displayName,
      locale: user.locale,
    },
    bookingsInitiated: bookingRows.map((b) => ({
      bookingId: b.bookingId,
      customerStartAt: b.customerStartAt.toISOString(),
      customerEndAt: b.customerEndAt.toISOString(),
      timezone: b.timezone,
      locationName: b.locationName,
      items: (linesByBooking.get(b.bookingId) ?? []).map((l) => ({
        categoryName: l.categoryName,
        variantLabel: l.variantLabel,
      })),
    })),
  };
}
