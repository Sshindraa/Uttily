import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { DbExecutor } from '@uttily/database';
import { bookings, locations, payments } from '@uttily/database';
import { CatalogError } from '../catalog/errors';
import {
  calculateSplitCancellationRefund,
  parseMarketplaceFeeSnapshot,
} from '../marketplace-fees';
import type { MarketplaceFeeDeltaSnapshot } from '../marketplace-fees/types';
import type {
  CancellationActorReason,
  CancellationPolicySnapshot,
  CancellationPreviewResult,
} from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PreviewCancellationOptions {
  actorReason?: CancellationActorReason | undefined;
  now?: Date | undefined;
}

export function computeCancellationPreviewFingerprint(params: {
  bookingId: string;
  actorReason: CancellationActorReason;
  policyCode: string;
  refundAmountMinor: number;
  retainedAmountMinor: number;
  commissionRefundedMinor: number;
  finalMerchantRevenueMinor: number;
  explanationCode: string;
}): string {
  const payload = JSON.stringify({
    b: params.bookingId,
    r: params.actorReason,
    p: params.policyCode,
    rf: params.refundAmountMinor,
    rt: params.retainedAmountMinor,
    cr: params.commissionRefundedMinor,
    fm: params.finalMerchantRevenueMinor,
    e: params.explanationCode,
  });
  return createHash('sha256').update(payload).digest('hex');
}

export async function previewBookingCancellation(
  db: DbExecutor,
  organizationId: string,
  bookingId: string,
  options?: PreviewCancellationOptions,
): Promise<CancellationPreviewResult> {
  if (!UUID_REGEX.test(organizationId)) {
    throw new CatalogError('VALIDATION', 'organizationId doit être un UUID valide.');
  }
  if (!UUID_REGEX.test(bookingId)) {
    throw new CatalogError('VALIDATION', 'bookingId doit être un UUID valide.');
  }

  const actorReason: CancellationActorReason = options?.actorReason ?? 'MERCHANT_CANCELLATION';
  const now = options?.now ?? new Date();

  // 1. Lire la réservation avec son paiement et son lieu
  const rows = await db
    .select({
      bookingId: bookings.id,
      organizationId: bookings.organizationId,
      status: bookings.status,
      customerStartAt: bookings.customerStartAt,
      customerEndAt: bookings.customerEndAt,
      confirmedAt: bookings.confirmedAt,
      totalAmountMinor: bookings.totalAmountMinor,
      customerTotalAmountMinor: bookings.customerTotalAmountMinor,
      commissionAmountMinor: bookings.commissionAmountMinor,
      cancellationPolicySnapshot: bookings.cancellationPolicySnapshot,
      paymentId: bookings.paymentId,
      paymentAmountMinor: payments.amountMinor,
      paymentCommissionMinor: payments.commissionAmountMinor,
      paymentMarketplaceFeeSnapshot: payments.marketplaceFeeSnapshot,
      marketplaceFeeSnapshot: bookings.marketplaceFeeSnapshot,
      locationTimeZone: locations.timeZone,
    })
    .from(bookings)
    .innerJoin(locations, eq(bookings.locationId, locations.id))
    .leftJoin(payments, eq(bookings.paymentId, payments.id))
    .where(and(eq(bookings.id, bookingId), eq(bookings.organizationId, organizationId)));

  if (rows.length === 0) {
    throw new CatalogError('NOT_FOUND', 'Réservation introuvable.');
  }

  const booking = rows[0]!;

  // 2. Vérification de l'éligibilité au statut
  if (booking.status !== 'CONFIRMED' && booking.status !== 'READY_FOR_PICKUP') {
    return {
      allowed: false,
      reasonDisallowed: `Impossible d'annuler une réservation avec le statut ${booking.status}. Seules les réservations confirmées ou prêtes peuvent être annulées.`,
      bookingId,
      paidAmountMinor: booking.totalAmountMinor,
      refundAmountMinor: 0,
      retainedAmountMinor: 0,
      originalCommissionMinor: 0,
      commissionRefundedMinor: 0,
      finalCommissionMinor: 0,
      finalMerchantRevenueMinor: 0,
      currency: 'EUR',
      policyCode: 'UNKNOWN',
      explanationCode: 'STATUS_NOT_ELIGIBLE',
      explanationLabel: `Statut actuel "${booking.status}" non éligible à l'annulation.`,
      inventoryWillBeReleased: false,
      customerStartAt: booking.customerStartAt,
      locationTimeZone: booking.locationTimeZone,
      previewFingerprint: '',
    };
  }

  // 3. Extraction de la politique d'annulation figée dans le snapshot
  const rawSnapshot = booking.cancellationPolicySnapshot as
    CancellationPolicySnapshot | null | undefined;
  const policyCode = (rawSnapshot?.policy_code ?? 'FLEXIBLE').toUpperCase();

  // 4. Calcul du pourcentage et code d'explication selon la politique contractuelle
  let refundPercentage = 100;
  let explanationCode = 'FULL_REFUND_MERCHANT';
  let explanationLabel =
    'Annulation initiée par le loueur : remboursement intégral du locataire et restitution de la commission.';

  if (actorReason === 'CUSTOMER_CANCELLATION') {
    const diffMs = booking.customerStartAt.getTime() - now.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    const diffDays = diffHours / 24;

    const confirmedAt = booking.confirmedAt ?? now;
    const bookedInAdvanceDays =
      (booking.customerStartAt.getTime() - confirmedAt.getTime()) / (1000 * 60 * 60 * 24);
    const timeSinceConfirmationHours = (now.getTime() - confirmedAt.getTime()) / (1000 * 60 * 60);

    // Fenêtre de grâce 24h (réservé ≥ 7 jours à l'avance et annulé dans les 24h suivant la réservation)
    if (bookedInAdvanceDays >= 7 && timeSinceConfirmationHours <= 24 && diffHours > 0) {
      refundPercentage = 100;
      explanationCode = 'GRACE_WINDOW_24H';
      explanationLabel = 'Fenêtre de grâce 24h après réservation : remboursement intégral à 100 %.';
    } else if (policyCode === 'FLEXIBLE') {
      if (diffHours >= 24) {
        refundPercentage = 100;
        explanationCode = 'FLEXIBLE_GE_24H';
        explanationLabel = 'Politique Flexible (≥ 24h avant le départ) : remboursement à 100 %.';
      } else {
        refundPercentage = 0;
        explanationCode = 'FLEXIBLE_LT_24H';
        explanationLabel =
          'Politique Flexible (< 24h avant le départ) : aucun remboursement, frais retenus à 100 %.';
      }
    } else if (policyCode === 'MODERATE') {
      if (diffDays >= 5) {
        refundPercentage = 100;
        explanationCode = 'MODERATE_GE_5D';
        explanationLabel = 'Politique Modérée (≥ 5 jours avant le départ) : remboursement à 100 %.';
      } else if (diffHours >= 24) {
        refundPercentage = 50;
        explanationCode = 'MODERATE_24H_5D';
        explanationLabel =
          'Politique Modérée (entre 24h et 5 jours avant le départ) : remboursement à 50 %.';
      } else {
        refundPercentage = 0;
        explanationCode = 'MODERATE_LT_24H';
        explanationLabel =
          'Politique Modérée (< 24h avant le départ) : aucun remboursement, frais retenus à 100 %.';
      }
    } else if (policyCode === 'FIRM') {
      if (diffDays >= 14) {
        refundPercentage = 100;
        explanationCode = 'FIRM_GE_14D';
        explanationLabel = 'Politique Ferme (≥ 14 jours avant le départ) : remboursement à 100 %.';
      } else if (diffDays >= 7) {
        refundPercentage = 50;
        explanationCode = 'FIRM_7D_14D';
        explanationLabel =
          'Politique Ferme (entre 7 et 14 jours avant le départ) : remboursement à 50 %.';
      } else {
        refundPercentage = 0;
        explanationCode = 'FIRM_LT_7D';
        explanationLabel =
          'Politique Ferme (< 7 jours avant le départ) : aucun remboursement, frais retenus à 100 %.';
      }
    } else {
      // Fallback par défaut si code inconnu
      refundPercentage = diffHours >= 24 ? 100 : 0;
      explanationCode = 'DEFAULT_POLICY';
      explanationLabel = 'Politique par défaut appliquée.';
    }
  }

  // 5. Calcul précis des montants en centimes (arithmétique sûre)
  const rawSplitSnapshot =
    booking.marketplaceFeeSnapshot ?? booking.paymentMarketplaceFeeSnapshot;
  let paidAmountMinor: number;
  let refundAmountMinor: number;
  let retainedAmountMinor: number;
  let originalCommissionMinor: number;
  let commissionRefundedMinor: number;
  let finalCommissionMinor: number;
  let finalMerchantRevenueMinor: number;
  let marketplaceFeeDelta: MarketplaceFeeDeltaSnapshot | undefined;

  if (rawSplitSnapshot !== null && rawSplitSnapshot !== undefined) {
    // Modèle Split 13/7 (ADR-029, ADR-030)
    const splitSnapshot = parseMarketplaceFeeSnapshot(rawSplitSnapshot);
    const splitRefund = calculateSplitCancellationRefund({
      oldSnapshot: splitSnapshot,
      refundPercentage,
    });

    paidAmountMinor = splitSnapshot.customerTotalAmountMinor;
    refundAmountMinor = splitRefund.customerRefundAmountMinor;
    retainedAmountMinor = splitRefund.customerRetainedAmountMinor;
    originalCommissionMinor = splitSnapshot.platformApplicationFeeAmountMinor;
    commissionRefundedMinor = splitRefund.platformFeeRefundedMinor;
    finalCommissionMinor = splitRefund.finalPlatformFeeMinor;
    finalMerchantRevenueMinor = splitRefund.finalMerchantRevenueMinor;
    marketplaceFeeDelta = splitRefund.deltaSnapshot;
  } else {
    // Modèle legacy historique
    paidAmountMinor = booking.totalAmountMinor;
    originalCommissionMinor =
      booking.commissionAmountMinor ?? booking.paymentCommissionMinor ?? 0;
    refundAmountMinor = Math.round((paidAmountMinor * refundPercentage) / 100);
    retainedAmountMinor = paidAmountMinor - refundAmountMinor;

    if (refundPercentage === 100) {
      commissionRefundedMinor = originalCommissionMinor;
      finalCommissionMinor = 0;
      finalMerchantRevenueMinor = 0;
    } else if (refundPercentage === 0) {
      commissionRefundedMinor = 0;
      finalCommissionMinor = originalCommissionMinor;
      finalMerchantRevenueMinor = retainedAmountMinor - finalCommissionMinor;
    } else {
      finalCommissionMinor = Math.round(
        (originalCommissionMinor * retainedAmountMinor) / paidAmountMinor,
      );
      commissionRefundedMinor = originalCommissionMinor - finalCommissionMinor;
      finalMerchantRevenueMinor = retainedAmountMinor - finalCommissionMinor;
    }
  }

  const previewFingerprint = computeCancellationPreviewFingerprint({
    bookingId,
    actorReason,
    policyCode,
    refundAmountMinor,
    retainedAmountMinor,
    commissionRefundedMinor,
    finalMerchantRevenueMinor,
    explanationCode,
  });

  return {
    allowed: true,
    bookingId,
    paidAmountMinor,
    refundAmountMinor,
    retainedAmountMinor,
    originalCommissionMinor,
    commissionRefundedMinor,
    finalCommissionMinor,
    finalMerchantRevenueMinor,
    currency: 'EUR',
    policyCode,
    explanationCode,
    explanationLabel,
    inventoryWillBeReleased: true,
    customerStartAt: booking.customerStartAt,
    locationTimeZone: booking.locationTimeZone,
    previewFingerprint,
    ...(marketplaceFeeDelta ? { marketplaceFeeDelta } : {}),
  };
}
