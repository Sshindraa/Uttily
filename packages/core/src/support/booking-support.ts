import { asc, eq, inArray, or } from 'drizzle-orm';
import type { DatabaseClient, DbExecutor } from '@uttily/database';
import {
  amendmentPayments,
  bookingAmendments,
  bookingCancellations,
  bookingFulfillmentEvents,
  bookingItems,
  bookingLines,
  bookings,
  conditionReports,
  damageReports,
  inventoryItems,
  locations,
  notifications,
  organizations,
  paymentAttempts,
  payments,
  productVariants,
  products,
  refunds,
  users,
} from '@uttily/database';
import type {
  BookingSupportDetails,
  SupportTimelineEvent,
} from './types';
import { projectCustomerBookingStatus } from '../customer-bookings/get-customer-bookings';

export class SupportBookingNotFoundError extends Error {
  constructor(bookingId: string) {
    super(`Réservation introuvable: ${bookingId}`);
    this.name = 'SupportBookingNotFoundError';
  }
}

/**
 * Récupère le diagnostic 360° d'une réservation pour le support Uttily.
 * Calcule la décomposition financière consolidée et assemble la timeline chronologique.
 */
export async function getBookingSupportDetails(
  db: DatabaseClient | DbExecutor,
  bookingId: string,
): Promise<BookingSupportDetails> {
  // 1. Réservation + Org + Établissement + Client
  const [bookingRow] = await db
    .select({
      id: bookings.id,
      organizationId: bookings.organizationId,
      locationId: bookings.locationId,
      status: bookings.status,
      customerUserId: bookings.customerUserId,
      customerEmail: users.email,
      customerDisplayName: users.displayName,
      totalAmountMinor: bookings.totalAmountMinor,
      currency: bookings.currency,
      customerStartAt: bookings.customerStartAt,
      customerEndAt: bookings.customerEndAt,
      paymentId: bookings.paymentId,
      draftId: bookings.draftId,
      createdAt: bookings.createdAt,
      updatedAt: bookings.updatedAt,
      orgLegalName: organizations.legalName,
      orgSlug: organizations.slug,
      locName: locations.name,
      locCity: locations.city,
      locTimeZone: locations.timeZone,
    })
    .from(bookings)
    .innerJoin(organizations, eq(bookings.organizationId, organizations.id))
    .innerJoin(locations, eq(bookings.locationId, locations.id))
    .innerJoin(users, eq(bookings.customerUserId, users.id))
    .where(eq(bookings.id, bookingId))
    .limit(1);

  if (!bookingRow) {
    throw new SupportBookingNotFoundError(bookingId);
  }

  // 2. Lignes & Allocations physiques
  const lineRows = await db
    .select({
      id: bookingLines.id,
      productId: products.id,
      productName: products.name,
      productVariantId: productVariants.id,
      variantName: productVariants.name,
      quantity: bookingLines.quantity,
      unitPriceMinor: bookingLines.unitPriceAmountMinor,
      totalAmountMinor: bookingLines.lineTotalAmountMinor,
    })
    .from(bookingLines)
    .innerJoin(productVariants, eq(bookingLines.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(bookingLines.bookingId, bookingId));

  const lineIds = lineRows.map((l) => l.id);

  let itemAllocations: {
    bookingLineId: string;
    id: string;
    inventoryItemId: string;
    internalIdentifier: string | null;
    serialNumber: string | null;
    condition: string;
    status: string;
  }[] = [];

  if (lineIds.length > 0) {
    const itemRows = await db
      .select({
        id: bookingItems.id,
        bookingLineId: bookingItems.bookingLineId,
        inventoryItemId: inventoryItems.id,
        internalIdentifier: inventoryItems.internalSku,
        serialNumber: inventoryItems.serialNumber,
        condition: inventoryItems.condition,
        status: inventoryItems.status,
      })
      .from(bookingItems)
      .innerJoin(inventoryItems, eq(bookingItems.inventoryItemId, inventoryItems.id))
      .where(inArray(bookingItems.bookingLineId, lineIds));

    itemAllocations = itemRows;
  }

  const linesData = lineRows.map((line) => ({
    id: line.id,
    productId: line.productId,
    productName: line.productName,
    productVariantId: line.productVariantId,
    variantName: line.variantName,
    quantity: line.quantity,
    unitPriceMinor: line.unitPriceMinor,
    totalAmountMinor: line.totalAmountMinor,
    allocations: itemAllocations
      .filter((item) => item.bookingLineId === line.id)
      .map((item) => ({
        id: item.id,
        inventoryItemId: item.inventoryItemId,
        internalIdentifier: item.internalIdentifier,
        serialNumber: item.serialNumber,
        condition: item.condition,
        status: item.status,
      })),
  }));

  // 3. Paiement initial et tentatives
  const [paymentRow] = await db
    .select({
      id: payments.id,
      status: payments.status,
      amountMinor: payments.amountMinor,
      currency: payments.currency,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(eq(payments.id, bookingRow.paymentId))
    .limit(1);

  let paymentAttemptsData: {
    id: string;
    attemptNumber: number;
    status: string;
    providerPaymentIntentId: string | null;
    providerStatus: string | null;
    lastErrorCode: string | null;
    createdAt: Date;
  }[] = [];

  if (paymentRow) {
    const attempts = await db
      .select({
        id: paymentAttempts.id,
        attemptNumber: paymentAttempts.attemptNumber,
        status: paymentAttempts.status,
        providerPaymentIntentId: paymentAttempts.providerPaymentIntentId,
        providerStatus: paymentAttempts.providerStatus,
        lastErrorCode: paymentAttempts.lastProviderErrorCode,
        createdAt: paymentAttempts.createdAt,
      })
      .from(paymentAttempts)
      .where(eq(paymentAttempts.paymentId, paymentRow.id))
      .orderBy(asc(paymentAttempts.attemptNumber));

    paymentAttemptsData = attempts;
  }

  // 4. Amendements et suppléments
  const amendmentRows = await db
    .select({
      id: bookingAmendments.id,
      amendmentNumber: bookingAmendments.amendmentNumber,
      type: bookingAmendments.type,
      status: bookingAmendments.status,
      financialSnapshotBefore: bookingAmendments.financialSnapshotBefore,
      financialSnapshotAfter: bookingAmendments.financialSnapshotAfter,
      createdAt: bookingAmendments.createdAt,
      appliedAt: bookingAmendments.appliedAt,
    })
    .from(bookingAmendments)
    .where(eq(bookingAmendments.bookingId, bookingId))
    .orderBy(asc(bookingAmendments.amendmentNumber));

  // 5. Annulation
  const [cancellationRow] = await db
    .select({
      id: bookingCancellations.id,
      occurredAt: bookingCancellations.occurredAt,
      actorReason: bookingCancellations.actorReason,
      policyCode: bookingCancellations.policyCode,
      grossPaidMinor: bookingCancellations.grossPaidMinor,
      refundAmountMinor: bookingCancellations.refundAmountMinor,
      retainedAmountMinor: bookingCancellations.retainedAmountMinor,
      finalCommissionMinor: bookingCancellations.finalCommissionMinor,
      finalMerchantRevenueMinor: bookingCancellations.finalMerchantRevenueMinor,
      cancelledByUserId: bookingCancellations.cancelledByUserId,
      refundId: bookingCancellations.refundId,
      userEmail: users.email,
    })
    .from(bookingCancellations)
    .leftJoin(users, eq(bookingCancellations.cancelledByUserId, users.id))
    .where(eq(bookingCancellations.bookingId, bookingId))
    .limit(1);

  // 6. Remboursements
  const amendmentPaymentRows = await db
    .select({ id: amendmentPayments.id })
    .from(amendmentPayments)
    .where(eq(amendmentPayments.bookingId, bookingId));
  const amendmentPaymentIds = amendmentPaymentRows.map((r) => r.id);

  const refundConditions = [];
  if (bookingRow.paymentId) {
    refundConditions.push(eq(refunds.paymentId, bookingRow.paymentId));
  }
  if (cancellationRow?.refundId) {
    refundConditions.push(eq(refunds.id, cancellationRow.refundId));
  }
  if (amendmentPaymentIds.length > 0) {
    refundConditions.push(inArray(refunds.amendmentPaymentId, amendmentPaymentIds));
  }

  const refundRows =
    refundConditions.length > 0
      ? await db
          .select({
            id: refunds.id,
            status: refunds.status,
            amountMinor: refunds.amountMinor,
            currency: refunds.currency,
            reason: refunds.reason,
            providerRefundId: refunds.providerRefundId,
            failureCode: refunds.failureCode,
            createdAt: refunds.createdAt,
          })
          .from(refunds)
          .where(or(...refundConditions))
          .orderBy(asc(refunds.createdAt))
      : [];

  // 7. Événements de fulfillment (opérations)
  const fulfillmentRows = await db
    .select({
      id: bookingFulfillmentEvents.id,
      eventType: bookingFulfillmentEvents.eventType,
      occurredAt: bookingFulfillmentEvents.occurredAt,
      actorUserId: bookingFulfillmentEvents.actorUserId,
      metadata: bookingFulfillmentEvents.metadata,
    })
    .from(bookingFulfillmentEvents)
    .where(eq(bookingFulfillmentEvents.bookingId, bookingId))
    .orderBy(asc(bookingFulfillmentEvents.occurredAt));

  // 8. Rapports d'état et dommages
  const conditionReportRows = await db
    .select({
      id: conditionReports.id,
      phase: conditionReports.phase,
      condition: conditionReports.condition,
      notes: conditionReports.notes,
      createdAt: conditionReports.createdAt,
    })
    .from(conditionReports)
    .where(eq(conditionReports.bookingId, bookingId))
    .orderBy(asc(conditionReports.createdAt));

  const damageReportRows = await db
    .select({
      id: damageReports.id,
      description: damageReports.description,
      createdAt: damageReports.createdAt,
    })
    .from(damageReports)
    .where(eq(damageReports.bookingId, bookingId))
    .orderBy(asc(damageReports.createdAt));

  // 9. Notifications transactionnelles
  const notificationRows = await db
    .select({
      id: notifications.id,
      template: notifications.template,
      recipient: notifications.recipient,
      status: notifications.status,
      attemptCount: notifications.attemptCount,
      scheduledFor: notifications.scheduledFor,
      sentAt: notifications.sentAt,
      failedAt: notifications.failedAt,
      failureCode: notifications.failureCode,
      requiresManualReview: notifications.requiresManualReview,
    })
    .from(notifications)
    .where(eq(notifications.bookingId, bookingId))
    .orderBy(asc(notifications.scheduledFor));

  // Calculs financiers consolidés
  const originalTotal = bookingRow.totalAmountMinor;
  let supplementTotal = 0;
  const processedAmendments = amendmentRows.map((a) => {
    const after = a.financialSnapshotAfter as { totalAmountMinor?: number } | null;
    const before = a.financialSnapshotBefore as { totalAmountMinor?: number } | null;
    const priceDelta = (after?.totalAmountMinor ?? 0) - (before?.totalAmountMinor ?? 0);
    if (a.type === 'SUPPLEMENT' && a.status === 'APPLIED') {
      supplementTotal += Math.max(0, priceDelta);
    }
    return {
      ...a,
      priceDeltaMinor: priceDelta,
    };
  });

  let refundTotal = 0;
  for (const r of refundRows) {
    if (r.status === 'SUCCEEDED' || r.status === 'PENDING') {
      refundTotal += r.amountMinor;
    }
  }

  const grossPaid = originalTotal + supplementTotal;
  const netRetained = Math.max(0, grossPaid - refundTotal);
  const finalCommission = cancellationRow
    ? cancellationRow.finalCommissionMinor
    : Math.round(netRetained * 0.1);
  const finalMerchantRevenue = cancellationRow
    ? cancellationRow.finalMerchantRevenueMinor
    : Math.max(0, netRetained - finalCommission);

  // 10. Assemblage de la timeline métier
  const timeline: SupportTimelineEvent[] = [];

  // Création réservation
  timeline.push({
    id: `booking-created-${bookingRow.id}`,
    timestamp: bookingRow.createdAt,
    label: 'Réservation créée',
    description: `Montant initial: ${(originalTotal / 100).toFixed(2)} ${bookingRow.currency}.`,
    type: 'INFO',
    actorEmail: bookingRow.customerEmail,
  });

  // Tentatives de paiement initial
  for (const a of paymentAttemptsData) {
    timeline.push({
      id: `payment-attempt-${a.id}`,
      timestamp: a.createdAt,
      label: `Tentative de paiement initial #${a.attemptNumber} (${a.status})`,
      description: a.lastErrorCode
        ? `Erreur: ${a.lastErrorCode}`
        : `Statut Stripe: ${a.providerStatus ?? 'OK'}`,
      type: a.status === 'SUCCEEDED' ? 'SUCCESS' : a.status === 'FAILED' ? 'ERROR' : 'WARNING',
    });
  }

  // Amendements
  for (const am of processedAmendments) {
    timeline.push({
      id: `amendment-${am.id}`,
      timestamp: am.appliedAt ?? am.createdAt,
      label: `Avenant #${am.amendmentNumber} (${am.type} - ${am.status})`,
      description: `Variation financière: ${(am.priceDeltaMinor / 100).toFixed(2)} ${bookingRow.currency}.`,
      type: am.status === 'APPLIED' ? 'SUCCESS' : am.status === 'FAILED' ? 'ERROR' : 'INFO',
    });
  }

  // Événements d'exécution (Fulfillment)
  for (const f of fulfillmentRows) {
    const meta = f.metadata as { notes?: string; description?: string } | null;
    const noteText = meta?.notes ?? meta?.description ?? null;
    timeline.push({
      id: `fulfillment-${f.id}`,
      timestamp: f.occurredAt,
      label: `Opération: ${f.eventType}`,
      description: noteText ? `Note: ${noteText}` : `Transition de statut de remise effectuée.`,
      type: 'INFO',
    });
  }

  // Rapports d'état
  for (const cr of conditionReportRows) {
    timeline.push({
      id: `condition-report-${cr.id}`,
      timestamp: cr.createdAt,
      label: `Rapport d'état (${cr.phase})`,
      description: `État: ${cr.condition}${cr.notes ? ` • ${cr.notes}` : ''}`,
      type: cr.condition === 'POOR' || cr.condition === 'BROKEN' ? 'WARNING' : 'INFO',
    });
  }

  // Dommages
  for (const dr of damageReportRows) {
    timeline.push({
      id: `damage-report-${dr.id}`,
      timestamp: dr.createdAt,
      label: 'Signalement dommage',
      description: dr.description,
      type: 'ERROR',
    });
  }

  // Annulation
  if (cancellationRow) {
    timeline.push({
      id: `cancellation-${cancellationRow.id}`,
      timestamp: cancellationRow.occurredAt,
      label: 'Réservation annulée',
      description: `Motif: ${cancellationRow.actorReason} • Politique: ${cancellationRow.policyCode} • Remboursement: ${(cancellationRow.refundAmountMinor / 100).toFixed(2)} EUR.`,
      type: 'WARNING',
      actorEmail: cancellationRow.userEmail ?? null,
    });
  }

  // Remboursements
  for (const r of refundRows) {
    timeline.push({
      id: `refund-${r.id}`,
      timestamp: r.createdAt,
      label: `Remboursement (${r.status})`,
      description: `Montant: ${(r.amountMinor / 100).toFixed(2)} ${r.currency} • Motif: ${r.reason}${r.failureCode ? ` • Erreur: ${r.failureCode}` : ''}`,
      type: r.status === 'SUCCEEDED' ? 'SUCCESS' : r.status === 'FAILED_REQUIRES_MANUAL_ACTION' ? 'ERROR' : 'WARNING',
    });
  }

  // Notifications
  for (const n of notificationRows) {
    if (n.status === 'FAILED') {
      timeline.push({
        id: `notif-${n.id}`,
        timestamp: n.failedAt ?? n.scheduledFor,
        label: `Échec notification: ${n.template}`,
        description: `Destinataire: ${n.recipient} • Erreur: ${n.failureCode ?? 'Inconnue'}`,
        type: 'ERROR',
      });
    } else if (n.status === 'SENT') {
      timeline.push({
        id: `notif-${n.id}`,
        timestamp: n.sentAt ?? n.scheduledFor,
        label: `Notification envoyée: ${n.template}`,
        description: `Destinataire: ${n.recipient}`,
        type: 'SUCCESS',
      });
    }
  }

  // Tri de la timeline
  timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const projectedFulfillmentStatus = projectCustomerBookingStatus(
    bookingRow.status,
    refundRows[0]?.status,
    refundRows[0]?.amountMinor,
  );

  const latestPaymentIntentId = paymentAttemptsData[paymentAttemptsData.length - 1]?.providerPaymentIntentId ?? null;

  return {
    id: bookingRow.id,
    organizationId: bookingRow.organizationId,
    organizationName: bookingRow.orgLegalName,
    organizationSlug: bookingRow.orgSlug,
    locationId: bookingRow.locationId,
    locationName: bookingRow.locName,
    locationCity: bookingRow.locCity ?? '',
    locationTimeZone: bookingRow.locTimeZone,
    customer: {
      id: bookingRow.customerUserId,
      email: bookingRow.customerEmail,
      displayName: bookingRow.customerDisplayName,
    },
    status: bookingRow.status,
    fulfillmentStatus: projectedFulfillmentStatus,
    dates: {
      pickupUtc: bookingRow.customerStartAt,
      returnUtc: bookingRow.customerEndAt,
      pickupLocalIso: bookingRow.customerStartAt.toISOString(),
      returnLocalIso: bookingRow.customerEndAt.toISOString(),
      timeZone: bookingRow.locTimeZone,
    },
    financial: {
      currency: bookingRow.currency,
      grossPaidMinor: grossPaid,
      originalTotalMinor: originalTotal,
      supplementTotalMinor: supplementTotal,
      refundTotalMinor: refundTotal,
      netRetainedMinor: netRetained,
      platformCommissionMinor: finalCommission,
      finalMerchantRevenueMinor: finalMerchantRevenue,
    },
    lines: linesData,
    payment: paymentRow
      ? {
          id: paymentRow.id,
          status: paymentRow.status,
          amountMinor: paymentRow.amountMinor,
          currency: paymentRow.currency,
          providerPaymentIntentId: latestPaymentIntentId,
          createdAt: paymentRow.createdAt,
          attempts: paymentAttemptsData,
        }
      : null,
    cancellation: cancellationRow
      ? {
          id: cancellationRow.id,
          occurredAt: cancellationRow.occurredAt,
          actorReason: cancellationRow.actorReason,
          policyCode: cancellationRow.policyCode,
          grossPaidMinor: cancellationRow.grossPaidMinor,
          refundAmountMinor: cancellationRow.refundAmountMinor,
          retainedAmountMinor: cancellationRow.retainedAmountMinor,
          finalCommissionMinor: cancellationRow.finalCommissionMinor,
          finalMerchantRevenueMinor: cancellationRow.finalMerchantRevenueMinor,
          cancelledByEmail: cancellationRow.userEmail ?? null,
        }
      : null,
    refunds: refundRows.map((r) => ({
      id: r.id,
      status: r.status,
      amountMinor: r.amountMinor,
      currency: r.currency,
      reason: r.reason,
      providerRefundId: r.providerRefundId,
      failureCode: r.failureCode,
      createdAt: r.createdAt,
    })),
    fulfillmentEvents: fulfillmentRows.map((f) => ({
      id: f.id,
      eventType: f.eventType,
      occurredAt: f.occurredAt,
      actorUserId: f.actorUserId,
      notes: (f.metadata as { notes?: string })?.notes ?? null,
    })),
    conditionReports: conditionReportRows.map((cr) => ({
      id: cr.id,
      phase: cr.phase,
      condition: cr.condition,
      notes: cr.notes,
      createdAt: cr.createdAt,
    })),
    damageReports: damageReportRows.map((dr) => ({
      id: dr.id,
      description: dr.description,
      createdAt: dr.createdAt,
    })),
    notifications: notificationRows.map((n) => ({
      id: n.id,
      template: n.template,
      recipient: n.recipient,
      status: n.status,
      attemptCount: n.attemptCount,
      scheduledFor: n.scheduledFor,
      sentAt: n.sentAt,
      failedAt: n.failedAt,
      failureCode: n.failureCode,
      requiresManualReview: n.requiresManualReview ?? false,
    })),
    timeline,
  };
}
