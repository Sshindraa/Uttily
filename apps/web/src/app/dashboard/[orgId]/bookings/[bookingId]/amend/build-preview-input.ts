import type { NeutralAmendmentIntent } from '@uttily/core';
import type { PreviewBookingAmendmentInput } from '@/app/actions/booking-amendments';
import type { AmendBookingFormLineProp } from './amend-booking-form';

export interface BuildPreviewInputParams {
  bookingId: string;
  expectedLastAppliedAmendmentNumber: number;
  intentKind: 'DAY_RANGE' | 'TIME_RANGE';
  startDate: string;
  endDateExclusive: string;
  startAt: string;
  endAt: string;
  quantities: Record<string, number>;
  lines: AmendBookingFormLineProp[];
}

export type BuildPreviewInputResult =
  { ok: true; input: PreviewBookingAmendmentInput } | { ok: false; error: string };

/**
 * Construit et valide les paramètres d'entrée pour l'action de prévisualisation (G7M-C5-A).
 * Fonction pure et déterministe, hautement testable sans dépendance au DOM ou au framework.
 */
export function buildPreviewBookingAmendmentInput(
  params: BuildPreviewInputParams,
): BuildPreviewInputResult {
  let resolvedIntent: NeutralAmendmentIntent;
  if (params.intentKind === 'DAY_RANGE') {
    if (!params.startDate || !params.endDateExclusive) {
      return {
        ok: false,
        error: 'Veuillez renseigner des dates de début et de fin valides.',
      };
    }
    if (params.endDateExclusive <= params.startDate) {
      return {
        ok: false,
        error: 'La date de fin doit être strictement postérieure à la date de début.',
      };
    }
    resolvedIntent = {
      kind: 'DAY_RANGE',
      startDate: params.startDate,
      endDateExclusive: params.endDateExclusive,
    };
  } else {
    if (!params.startAt || !params.endAt) {
      return {
        ok: false,
        error: 'Veuillez renseigner des date et heure de début et de fin valides.',
      };
    }
    if (params.endAt <= params.startAt) {
      return {
        ok: false,
        error: 'La date et heure de fin doivent être strictement postérieures au début.',
      };
    }
    resolvedIntent = {
      kind: 'TIME_RANGE',
      startAt: params.startAt,
      endAt: params.endAt,
    };
  }

  const payloadLines = params.lines.map((l) => ({
    logicalLineId: l.logicalLineId,
    variantId: l.variantId,
    quantity: params.quantities[l.logicalLineId] ?? l.currentQuantity,
  }));

  const hasAtLeastOne = payloadLines.some((l) => l.quantity > 0);
  if (!hasAtLeastOne) {
    return {
      ok: false,
      error: 'La réservation doit comporter au moins un article avec une quantité supérieure à 0.',
    };
  }

  return {
    ok: true,
    input: {
      bookingId: params.bookingId,
      expectedLastAppliedAmendmentNumber: params.expectedLastAppliedAmendmentNumber,
      intent: resolvedIntent,
      lines: payloadLines,
    },
  };
}
