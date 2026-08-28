import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { bookingAmendments, locations, productVariants, products } from '@uttily/database';
import { getEffectiveBooking, getEffectivePricingIntent, type BookingStatus } from '@uttily/core';
import { requireAmendmentManagerOf } from '@/lib/amendment-auth';
import { isValidUuid, bookingStatusLabel } from '@/lib/operations-helpers';
import { AmendBookingForm } from './amend-booking-form';

export default async function AmendBookingPage({
  params,
}: {
  params: Promise<{ orgId: string; bookingId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, bookingId } = await params;

  if (!isValidUuid(bookingId)) notFound();

  let authContext;
  try {
    authContext = await requireAmendmentManagerOf(orgId);
  } catch {
    notFound();
  }

  const { db, organizationId } = authContext;

  const effectiveResult = await getEffectiveBooking(db, organizationId, bookingId);
  if (effectiveResult.kind === 'NOT_FOUND') notFound();

  const effectiveBooking = effectiveResult.booking;

  if (effectiveBooking.booking.status !== 'CONFIRMED') {
    return (
      <main style={{ maxWidth: '800px', margin: '0 auto', padding: '1.5rem' }}>
        <p>
          <Link href={`/dashboard/${organizationId}/bookings/${bookingId}`}>
            ← Retour à la réservation
          </Link>
        </p>
        <h1>Modification impossible</h1>
        <p>
          Seules les réservations confirmées peuvent être modifiées (statut actuel :{' '}
          {bookingStatusLabel(effectiveBooking.booking.status as BookingStatus)}).
        </p>
      </main>
    );
  }

  const activeAmendmentRows = await db
    .select({ id: bookingAmendments.id })
    .from(bookingAmendments)
    .where(
      and(
        eq(bookingAmendments.bookingId, bookingId),
        eq(bookingAmendments.organizationId, organizationId),
        inArray(bookingAmendments.status, ['HOLD_PENDING', 'READY_TO_APPLY']),
      ),
    )
    .limit(1);

  if (activeAmendmentRows.length > 0) {
    return (
      <main style={{ maxWidth: '800px', margin: '0 auto', padding: '1.5rem' }}>
        <p>
          <Link href={`/dashboard/${organizationId}/bookings/${bookingId}`}>
            ← Retour à la réservation
          </Link>
        </p>
        <h1>Modification en cours</h1>
        <p>
          Une modification est déjà active sur cette réservation. Veuillez finaliser ou annuler
          l'amendement en cours avant d'en initier un nouveau.
        </p>
      </main>
    );
  }

  const locRows = await db
    .select({
      name: locations.name,
      timeZone: locations.timeZone,
    })
    .from(locations)
    .where(and(eq(locations.id, effectiveBooking.booking.locationId), isNull(locations.deletedAt)))
    .limit(1);

  if (locRows.length === 0) {
    notFound();
  }

  const locationName = locRows[0]!.name;
  const locationTimeZone = locRows[0]!.timeZone;

  // Résolution canonique de l'intention effective faisant autorité (ADR-023 / G7M-C5-A)
  const intentResult = await getEffectivePricingIntent(
    db,
    organizationId,
    bookingId,
    locationTimeZone,
    effectiveBooking.effectiveCustomerStartAt,
    effectiveBooking.effectiveCustomerEndAt,
  );

  if (intentResult.kind === 'NOT_FOUND' || intentResult.kind === 'INVALID_INTENT') {
    notFound();
  }

  const initialIntent = intentResult.intent;

  // Chargement strict des variantes et produits sans fallback inventé
  const variantIds = effectiveBooking.lines.map((l) => l.variantId);
  const variantMap = new Map<string, { productName: string; variantName: string }>();

  if (variantIds.length > 0) {
    const variantRows = await db
      .select({
        variantId: productVariants.id,
        variantName: productVariants.name,
        productName: products.name,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(
        and(inArray(productVariants.id, variantIds), eq(products.organizationId, organizationId)),
      );

    for (const r of variantRows) {
      variantMap.set(r.variantId, {
        productName: r.productName,
        variantName: r.variantName,
      });
    }

    for (const line of effectiveBooking.lines) {
      if (!variantMap.has(line.variantId)) {
        notFound();
      }
    }
  }

  const lines = effectiveBooking.lines.map((l) => {
    const names = variantMap.get(l.variantId)!;
    return {
      logicalLineId: l.logicalLineId,
      variantId: l.variantId,
      productName: names.productName,
      variantName: names.variantName,
      currentQuantity: l.quantity,
      unitPriceAmountMinor: l.unitPriceAmountMinor,
      lineTotalAmountMinor: l.lineTotalAmountMinor,
    };
  });

  return (
    <main style={{ maxWidth: '800px', margin: '0 auto', padding: '1.5rem' }}>
      <p>
        <Link href={`/dashboard/${organizationId}/bookings/${bookingId}`}>
          ← Retour à la réservation
        </Link>
      </p>

      <h1>Modifier la réservation</h1>

      <AmendBookingForm
        organizationId={organizationId}
        bookingId={bookingId}
        locationName={locationName}
        locationTimeZone={locationTimeZone}
        expectedLastAppliedAmendmentNumber={effectiveBooking.lastAppliedAmendmentNumber}
        initialIntent={initialIntent}
        currentTotalAmountMinor={effectiveBooking.effectiveTotalAmountMinor}
        lines={lines}
      />
    </main>
  );
}
