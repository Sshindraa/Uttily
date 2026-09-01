import Link from 'next/link';
import type { BookingStatus } from '@uttily/core';
import { bookingStatusLabel } from '@/lib/operations-helpers';
import { AmendBookingForm, type AmendBookingFormLineProp } from './amend-booking-form';
import type { NeutralAmendmentIntent } from '@uttily/core';

export interface AmendBookingPageViewProps {
  organizationId: string;
  bookingId: string;
  locationName: string;
  locationTimeZone: string;
  expectedLastAppliedAmendmentNumber: number;
  initialIntent: NeutralAmendmentIntent;
  currentTotalAmountMinor: number;
  lines: AmendBookingFormLineProp[];
}

export function AmendBookingPageView({
  organizationId,
  bookingId,
  locationName,
  locationTimeZone,
  expectedLastAppliedAmendmentNumber,
  initialIntent,
  currentTotalAmountMinor,
  lines,
}: AmendBookingPageViewProps): React.ReactElement {
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
        expectedLastAppliedAmendmentNumber={expectedLastAppliedAmendmentNumber}
        initialIntent={initialIntent}
        currentTotalAmountMinor={currentTotalAmountMinor}
        lines={lines}
      />
    </main>
  );
}

export interface AmendBookingUnavailableViewProps {
  organizationId: string;
  bookingId: string;
  title: string;
  description: string;
}

export function AmendBookingUnavailableView({
  organizationId,
  bookingId,
  title,
  description,
}: AmendBookingUnavailableViewProps): React.ReactElement {
  return (
    <main style={{ maxWidth: '800px', margin: '0 auto', padding: '1.5rem' }}>
      <p>
        <Link href={`/dashboard/${organizationId}/bookings/${bookingId}`}>
          ← Retour à la réservation
        </Link>
      </p>
      <h1>{title}</h1>
      <p>{description}</p>
    </main>
  );
}

export function getAmendmentStatusDescription(status: BookingStatus): string {
  return `Seules les réservations confirmées peuvent être modifiées (statut actuel : ${bookingStatusLabel(status)}).`;
}
