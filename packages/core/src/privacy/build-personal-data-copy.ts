import { eq, inArray } from 'drizzle-orm';
import type { DbExecutor } from '@uttily/database';
import {
  users,
  bookings,
  bookingLines,
  payments,
  locations,
  products,
  productVariants,
  categories,
  documents,
  refunds,
} from '@uttily/database';
import type { Article15PersonalDataCopy } from './types';

/**
 * Construit la copie de données personnelles au sens de l'article 15 du RGPD.
 *
 * Périmètre : données strictement scoped par userId / customerUserId.
 *
 * Exclusions explicites :
 * - Aucun ID Stripe, aucun connectedAccountId, aucun paymentIntentId.
 * - Aucun storageKey, aucune URL R2 ni URL présignée.
 * - Aucun oidcSubject / oidcProvider / isPlatformAdmin.
 */
export async function buildPersonalDataCopy(
  db: DbExecutor,
  userId: string,
): Promise<Article15PersonalDataCopy> {
  // 1. Profil utilisateur (sans champs internes/sensibles)
  const [user] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      locale: users.locale,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw new Error('Utilisateur non trouvé.');
  }

  // 2. Réservations avec paiement, lieu, lignes et documents
  const bookingRows = await db
    .select({
      bookingId: bookings.id,
      paymentId: bookings.paymentId,
      status: bookings.status,
      customerStartAt: bookings.customerStartAt,
      customerEndAt: bookings.customerEndAt,
      timezone: bookings.timezone,
      totalAmountMinor: bookings.totalAmountMinor,
      currency: bookings.currency,
      termsAcceptanceSnapshot: bookings.termsAcceptanceSnapshot,
      locationName: locations.name,
      locationAddressLine1: locations.addressLine1,
      locationCity: locations.city,
      locationPostalCode: locations.postalCode,
      locationCountryCode: locations.countryCode,
      paymentStatus: payments.status,
      paymentAmountMinor: payments.amountMinor,
      paymentSucceededAt: payments.succeededAt,
    })
    .from(bookings)
    .innerJoin(locations, eq(bookings.locationId, locations.id))
    .innerJoin(payments, eq(bookings.paymentId, payments.id))
    .where(eq(bookings.customerUserId, userId));

  const bookingIds = bookingRows.map((b) => b.bookingId);
  const paymentIds = bookingRows.map((b) => b.paymentId).filter((id): id is string => Boolean(id));

  // 3. Lignes de réservation (équipements)
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

  // 4. Documents émis — avec consultationPath, jamais de storageKey
  const docRows =
    bookingIds.length > 0
      ? await db
          .select({
            id: documents.id,
            bookingId: documents.bookingId,
            type: documents.type,
            generatedAt: documents.generatedAt,
          })
          .from(documents)
          .where(inArray(documents.bookingId, bookingIds))
      : [];

  const docsByBooking = new Map<
    string,
    Array<{ documentId: string; bookingId: string; type: string; generatedAt: Date }>
  >();
  for (const doc of docRows) {
    const arr = docsByBooking.get(doc.bookingId) ?? [];
    arr.push({
      documentId: doc.id,
      bookingId: doc.bookingId,
      type: doc.type,
      generatedAt: doc.generatedAt,
    });
    docsByBooking.set(doc.bookingId, arr);
  }

  // 5. Remboursements
  const refundRows =
    paymentIds.length > 0
      ? await db
          .select({
            paymentId: refunds.paymentId,
            amountMinor: refunds.amountMinor,
            status: refunds.status,
          })
          .from(refunds)
          .where(inArray(refunds.paymentId, paymentIds))
      : [];

  const refundByPayment = new Map<string, { amountMinor: number; status: string }>();
  for (const r of refundRows) {
    if (r.paymentId) {
      refundByPayment.set(r.paymentId, { amountMinor: r.amountMinor, status: r.status });
    }
  }

  // 6. Assemblage
  return {
    profile: {
      id: user.id,
      displayName: user.displayName,
      locale: user.locale,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    },
    bookings: bookingRows.map((b) => {
      const termsSnapshot = b.termsAcceptanceSnapshot as Record<string, unknown> | null;
      const refund = b.paymentId ? refundByPayment.get(b.paymentId) : undefined;
      return {
        bookingId: b.bookingId,
        status: b.status,
        customerStartAt: b.customerStartAt.toISOString(),
        customerEndAt: b.customerEndAt.toISOString(),
        timezone: b.timezone,
        location: {
          name: b.locationName,
          addressLine1: b.locationAddressLine1 ?? '',
          city: b.locationCity ?? '',
          postalCode: b.locationPostalCode ?? '',
          countryCode: b.locationCountryCode ?? '',
        },
        items: (linesByBooking.get(b.bookingId) ?? []).map((l) => ({
          categoryName: l.categoryName,
          variantLabel: l.variantLabel,
        })),
        payment: {
          amountMinor: b.paymentAmountMinor,
          currency: b.currency,
          status: b.paymentStatus,
          paidAt: b.paymentSucceededAt?.toISOString() ?? null,
          refundAmountMinor: refund?.amountMinor ?? null,
        },
        termsAcceptance: {
          version: (termsSnapshot?.['legalTermsVersion'] as string) ?? 'unknown',
          acceptedAt: (termsSnapshot?.['acceptedAt'] as string) ?? null,
        },
        documents: (docsByBooking.get(b.bookingId) ?? []).map((d) => ({
          documentId: d.documentId,
          bookingId: d.bookingId,
          type: d.type,
          generatedAt: d.generatedAt.toISOString(),
          consultationPath: `/api/account/bookings/${d.bookingId}/documents/${d.documentId}`,
        })),
      };
    }),
  };
}
