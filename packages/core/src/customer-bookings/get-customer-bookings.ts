import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { DatabaseClient, DbExecutor } from '@uttily/database';
import {
  bookingCancellations,
  bookingLines,
  bookings,
  categories,
  documents,
  locations,
  organizations,
  payments,
  productPhotos,
  products,
  productVariants,
  refunds,
} from '@uttily/database';
import type {
  CustomerBookingCancellationRecord,
  CustomerBookingDetail,
  CustomerBookingDocumentDetail,
  CustomerBookingItemDetail,
  CustomerBookingRefundDetail,
  CustomerBookingStatus,
  CustomerBookingSummary,
  GroupedCustomerBookings,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Projette les statuts autoritatifs Core (bookings, cancellations, refunds)
 * vers les statuts UX orientés locataire.
 */
export function projectCustomerBookingStatus(
  bookingStatus: string,
  refundStatus?: string | null,
  refundAmountMinor?: number | null,
): CustomerBookingStatus {
  switch (bookingStatus) {
    case 'CONFIRMED':
      return 'CONFIRMED';
    case 'READY_FOR_PICKUP':
      return 'READY_FOR_PICKUP';
    case 'ACTIVE':
      return 'ACTIVE';
    case 'RETURNED':
    case 'CLOSED':
      return 'COMPLETED';
    case 'CANCELLED': {
      if (!refundAmountMinor || refundAmountMinor <= 0) {
        return 'CANCELLED_NO_REFUND';
      }
      if (refundStatus === 'SUCCEEDED') {
        return 'CANCELLED_REFUNDED';
      }
      if (refundStatus === 'FAILED_REQUIRES_MANUAL_ACTION') {
        return 'CANCELLED_ACTION_REQUIRED';
      }
      return 'CANCELLED_REFUND_PENDING';
    }
    default:
      return 'CONFIRMED';
  }
}

/**
 * Construit l'adresse textuelle complète d'un établissement pour le locataire.
 */
function formatLocationAddress(loc: {
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
}): string {
  const parts = [
    loc.addressLine1,
    loc.addressLine2,
    `${loc.postalCode ?? ''} ${loc.city ?? ''}`.trim(),
  ].filter((p): p is string => Boolean(p && p.trim().length > 0));
  return parts.join(', ');
}

/**
 * Liste et regroupe toutes les réservations d'un locataire (scope strict).
 */
export async function listCustomerBookings(
  db: DatabaseClient | DbExecutor,
  customerUserId: string,
): Promise<GroupedCustomerBookings> {
  if (!customerUserId || !UUID_RE.test(customerUserId.trim())) {
    return { upcoming: [], active: [], past: [] };
  }

  // 1. Charger les réservations du client
  const bookingRows = await db
    .select({
      id: bookings.id,
      organizationId: bookings.organizationId,
      organizationName: organizations.legalName,
      status: bookings.status,
      customerStartAt: bookings.customerStartAt,
      customerEndAt: bookings.customerEndAt,
      timezone: bookings.timezone,
      totalAmountMinor: bookings.totalAmountMinor,
      currency: bookings.currency,
      confirmedAt: bookings.confirmedAt,
      locationName: locations.name,
      locationAddressLine1: locations.addressLine1,
      locationAddressLine2: locations.addressLine2,
      locationPostalCode: locations.postalCode,
      locationCity: locations.city,
      cancellationRefundAmountMinor: bookingCancellations.refundAmountMinor,
      refundStatus: refunds.status,
    })
    .from(bookings)
    .innerJoin(organizations, eq(bookings.organizationId, organizations.id))
    .innerJoin(locations, eq(bookings.locationId, locations.id))
    .leftJoin(bookingCancellations, eq(bookingCancellations.bookingId, bookings.id))
    .leftJoin(refunds, eq(bookingCancellations.refundId, refunds.id))
    .where(eq(bookings.customerUserId, customerUserId))
    .orderBy(desc(bookings.customerStartAt), desc(bookings.confirmedAt));

  if (bookingRows.length === 0) {
    return { upcoming: [], active: [], past: [] };
  }

  const bookingIds = bookingRows.map((r) => r.id);

  // 2. Charger les lignes et produits principaux pour chaque réservation
  const lineRows = await db
    .select({
      bookingId: bookingLines.bookingId,
      productName: products.name,
      categoryName: categories.name,
      productId: products.id,
    })
    .from(bookingLines)
    .innerJoin(productVariants, eq(bookingLines.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(inArray(bookingLines.bookingId, bookingIds));

  // 3. Charger les photos héro des produits concernés
  const productIds = Array.from(new Set(lineRows.map((l) => l.productId)));
  const photoRows =
    productIds.length > 0
      ? await db
          .select({
            productId: productPhotos.productId,
            publicId: productPhotos.publicId,
            slotType: productPhotos.slotType,
          })
          .from(productPhotos)
          .where(
            and(
              inArray(productPhotos.productId, productIds),
              eq(productPhotos.fileState, 'AVAILABLE'),
              isNull(productPhotos.deletedAt),
            ),
          )
          .orderBy(asc(productPhotos.sortOrder))
      : [];

  const heroPhotoByProductId = new Map<string, string>();
  for (const photo of photoRows) {
    if (!heroPhotoByProductId.has(photo.productId)) {
      heroPhotoByProductId.set(photo.productId, `/api/public/product-photos/${photo.publicId}`);
    }
  }

  const primaryProductByBookingId = new Map<
    string,
    { name: string; categoryName: string | null; heroPhotoUrl: string | null }
  >();

  for (const line of lineRows) {
    if (!primaryProductByBookingId.has(line.bookingId)) {
      primaryProductByBookingId.set(line.bookingId, {
        name: line.productName,
        categoryName: line.categoryName ?? null,
        heroPhotoUrl: heroPhotoByProductId.get(line.productId) ?? null,
      });
    }
  }

  // 4. Mapper et regrouper
  const upcoming: CustomerBookingSummary[] = [];
  const active: CustomerBookingSummary[] = [];
  const past: CustomerBookingSummary[] = [];

  for (const row of bookingRows) {
    const primary = primaryProductByBookingId.get(row.id) ?? {
      name: 'Équipement réservé',
      categoryName: null,
      heroPhotoUrl: null,
    };

    const status = projectCustomerBookingStatus(
      row.status,
      row.refundStatus,
      row.cancellationRefundAmountMinor,
    );

    const summary: CustomerBookingSummary = {
      id: row.id,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      status,
      rawStatus: row.status,
      productName: primary.name,
      heroPhotoUrl: primary.heroPhotoUrl,
      categoryName: primary.categoryName,
      startAt: row.customerStartAt,
      endAt: row.customerEndAt,
      timeZone: row.timezone,
      locationName: row.locationName,
      locationAddress: formatLocationAddress({
        addressLine1: row.locationAddressLine1,
        addressLine2: row.locationAddressLine2,
        postalCode: row.locationPostalCode,
        city: row.locationCity,
      }),
      totalAmountMinor: row.totalAmountMinor,
      currency: row.currency,
      confirmedAt: row.confirmedAt,
    };

    if (status === 'CONFIRMED' || status === 'READY_FOR_PICKUP') {
      upcoming.push(summary);
    } else if (status === 'ACTIVE') {
      active.push(summary);
    } else {
      past.push(summary);
    }
  }

  return { upcoming, active, past };
}

/**
 * Récupère le détail complet d'une réservation pour le locataire.
 * Scope strict : retourne null si la réservation n'existe pas ou n'appartient pas au client.
 */
export async function getCustomerBooking(
  db: DatabaseClient | DbExecutor,
  customerUserId: string,
  bookingId: string,
): Promise<CustomerBookingDetail | null> {
  if (
    !customerUserId ||
    !UUID_RE.test(customerUserId.trim()) ||
    !bookingId ||
    !UUID_RE.test(bookingId.trim())
  ) {
    return null;
  }

  // 1. Charger la réservation principale avec contrôle strict du customerUserId
  const bookingRows = await db
    .select({
      id: bookings.id,
      organizationId: bookings.organizationId,
      organizationName: organizations.legalName,
      customerUserId: bookings.customerUserId,
      paymentId: bookings.paymentId,
      status: bookings.status,
      customerStartAt: bookings.customerStartAt,
      customerEndAt: bookings.customerEndAt,
      timezone: bookings.timezone,
      totalAmountMinor: bookings.totalAmountMinor,
      currency: bookings.currency,
      confirmedAt: bookings.confirmedAt,
      cancellationPolicySnapshot: bookings.cancellationPolicySnapshot,
      locationName: locations.name,
      locationAddressLine1: locations.addressLine1,
      locationAddressLine2: locations.addressLine2,
      locationPostalCode: locations.postalCode,
      locationCity: locations.city,
    })
    .from(bookings)
    .innerJoin(organizations, eq(bookings.organizationId, organizations.id))
    .innerJoin(locations, eq(bookings.locationId, locations.id))
    .where(
      and(eq(bookings.id, bookingId.trim()), eq(bookings.customerUserId, customerUserId.trim())),
    )
    .limit(1);

  if (bookingRows.length === 0) return null;
  const booking = bookingRows[0]!;

  // 2. Charger les lignes de réservation
  const lineRows = await db
    .select({
      lineTotalAmountMinor: bookingLines.lineTotalAmountMinor,
      quantity: bookingLines.quantity,
      variantName: productVariants.name,
      variantAttributes: productVariants.attributes,
      productName: products.name,
      productId: products.id,
      categoryName: categories.name,
    })
    .from(bookingLines)
    .innerJoin(productVariants, eq(bookingLines.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(eq(bookingLines.bookingId, booking.id));

  const items: CustomerBookingItemDetail[] = lineRows.map((line) => {
    const attrs = line.variantAttributes as Record<string, unknown> | null;
    const size = typeof attrs?.['size'] === 'string' ? attrs['size'] : null;

    return {
      productName: line.productName,
      variantName: line.variantName,
      size,
      quantity: line.quantity,
      lineTotalAmountMinor: line.lineTotalAmountMinor,
    };
  });

  const primaryProduct = lineRows[0];

  // 3. Charger la photo héro
  let heroPhotoUrl: string | null = null;
  if (primaryProduct) {
    const photoRows = await db
      .select({ publicId: productPhotos.publicId })
      .from(productPhotos)
      .where(
        and(
          eq(productPhotos.productId, primaryProduct.productId),
          eq(productPhotos.fileState, 'AVAILABLE'),
          isNull(productPhotos.deletedAt),
        ),
      )
      .orderBy(asc(productPhotos.sortOrder))
      .limit(1);

    if (photoRows[0]) {
      heroPhotoUrl = `/api/public/product-photos/${photoRows[0].publicId}`;
    }
  }

  // 4. Charger le paiement
  const paymentRows = await db
    .select({
      amountMinor: payments.amountMinor,
      currency: payments.currency,
      status: payments.status,
      succeededAt: payments.succeededAt,
    })
    .from(payments)
    .where(eq(payments.id, booking.paymentId))
    .limit(1);

  const payment = paymentRows[0]
    ? {
        amountPaidMinor: paymentRows[0].amountMinor,
        currency: paymentRows[0].currency,
        status: (paymentRows[0].status === 'SUCCEEDED'
          ? 'PAID'
          : paymentRows[0].status === 'FAILED'
            ? 'FAILED'
            : 'PENDING') as 'PAID' | 'PENDING' | 'FAILED',
        paidAt: paymentRows[0].succeededAt,
      }
    : {
        amountPaidMinor: booking.totalAmountMinor,
        currency: booking.currency,
        status: 'PAID' as const,
        paidAt: booking.confirmedAt,
      };

  // 5. Charger l'annulation éventuelle
  const cancellationRows = await db
    .select({
      cancelledAt: bookingCancellations.occurredAt,
      actorReason: bookingCancellations.actorReason,
      refundAmountMinor: bookingCancellations.refundAmountMinor,
      retainedAmountMinor: bookingCancellations.retainedAmountMinor,
      explanationCode: bookingCancellations.explanationCode,
      policyCode: bookingCancellations.policyCode,
      refundId: bookingCancellations.refundId,
    })
    .from(bookingCancellations)
    .where(eq(bookingCancellations.bookingId, booking.id))
    .limit(1);

  let cancellationRecord: CustomerBookingCancellationRecord | null = null;
  let refundDetail: CustomerBookingRefundDetail | null = null;

  if (cancellationRows[0]) {
    const c = cancellationRows[0];
    cancellationRecord = {
      cancelledAt: c.cancelledAt,
      actorReason: c.actorReason,
      refundAmountMinor: c.refundAmountMinor,
      retainedAmountMinor: c.retainedAmountMinor,
      explanationCode: c.explanationCode,
      policyCode: c.policyCode,
    };

    if (c.refundId) {
      const refundRows = await db
        .select({
          amountMinor: refunds.amountMinor,
          currency: refunds.currency,
          status: refunds.status,
        })
        .from(refunds)
        .where(eq(refunds.id, c.refundId))
        .limit(1);

      if (refundRows[0]) {
        const r = refundRows[0];
        let refStatus: 'REQUESTED' | 'PROCESSING' | 'REFUNDED' | 'ACTION_REQUIRED' = 'REQUESTED';
        if (r.status === 'SUCCEEDED') refStatus = 'REFUNDED';
        else if (r.status === 'SUBMITTED') refStatus = 'PROCESSING';
        else if (r.status === 'FAILED_REQUIRES_MANUAL_ACTION') refStatus = 'ACTION_REQUIRED';

        refundDetail = {
          amountMinor: r.amountMinor,
          currency: r.currency,
          status: refStatus,
        };
      }
    }
  }

  // 6. Charger les documents
  const docRows = await db
    .select({
      id: documents.id,
      type: documents.type,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(eq(documents.bookingId, booking.id))
    .orderBy(desc(documents.createdAt));

  const docs: CustomerBookingDocumentDetail[] = docRows.map((doc) => {
    let title = 'Document de location';
    if (doc.type === 'CONFIRMATION') title = 'Confirmation de réservation';
    else if (doc.type === 'RECEIPT') title = 'Reçu de paiement';
    else if (doc.type === 'CONTRACT') title = 'Contrat de location';

    return {
      id: doc.id,
      type: doc.type,
      title,
      createdAt: doc.createdAt,
    };
  });

  // 7. Policy code
  const snapshot = booking.cancellationPolicySnapshot as { policy_code?: string } | null;
  const policyCode = snapshot?.policy_code ?? 'FLEXIBLE';

  const status = projectCustomerBookingStatus(
    booking.status,
    refundDetail?.status === 'REFUNDED'
      ? 'SUCCEEDED'
      : refundDetail?.status === 'ACTION_REQUIRED'
        ? 'FAILED_REQUIRES_MANUAL_ACTION'
        : 'PENDING',
    cancellationRecord?.refundAmountMinor,
  );

  return {
    id: booking.id,
    organizationId: booking.organizationId,
    organizationName: booking.organizationName,
    status,
    rawStatus: booking.status,
    productName: primaryProduct?.productName ?? 'Vélo réservé',
    heroPhotoUrl,
    categoryName: primaryProduct?.categoryName ?? null,
    startAt: booking.customerStartAt,
    endAt: booking.customerEndAt,
    timeZone: booking.timezone,
    locationName: booking.locationName,
    locationAddress: formatLocationAddress({
      addressLine1: booking.locationAddressLine1,
      addressLine2: booking.locationAddressLine2,
      postalCode: booking.locationPostalCode,
      city: booking.locationCity,
    }),
    locationCity: booking.locationCity,
    locationPostalCode: booking.locationPostalCode,
    locationInstructions: 'Présentez-vous à l’accueil avec votre pièce d’identité pour le retrait.',
    locationPhone: '+33 4 78 00 00 00',
    locationCoordinates: null,
    totalAmountMinor: booking.totalAmountMinor,
    currency: booking.currency,
    confirmedAt: booking.confirmedAt,
    items,
    payment,
    cancellation: {
      allowed: booking.status === 'CONFIRMED' || booking.status === 'READY_FOR_PICKUP',
      policyCode,
    },
    cancellationRecord,
    refund: refundDetail,
    documents: docs,
  };
}
