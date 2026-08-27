import { and, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  bookings,
  bookingItems,
  connectedAccountPayouts,
  inventoryItems,
  locations,
  payments,
  products,
  productVariants,
  refunds,
  users,
} from '@uttily/database';
import { CatalogError } from '../catalog/errors';
import type {
  MerchantFinanceActivityItem,
  MerchantFinanceFilterOptions,
  MerchantFinanceOverview,
} from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getMerchantFinanceOverview(
  db: DatabaseClient,
  organizationId: string,
  options?: MerchantFinanceFilterOptions,
): Promise<MerchantFinanceOverview> {
  if (!UUID_REGEX.test(organizationId)) {
    throw new CatalogError('VALIDATION', 'organizationId doit être un UUID valide.');
  }

  // 1. Fenêtre temporelle : par défaut le mois calendaire courant
  const now = new Date();
  let from = options?.from;
  let to = options?.to;

  if (!from || !to) {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    from = from ?? startOfMonth;
    to = to ?? endOfMonth;
  }

  const periodLabel = from.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const formattedPeriodLabel = periodLabel.charAt(0).toUpperCase() + periodLabel.slice(1);

  // 2. Requête des Paiements et Réservations associés
  const paymentRows = await db
    .select({
      paymentId: payments.id,
      paymentStatus: payments.status,
      amountMinor: payments.amountMinor,
      commissionAmountMinor: payments.commissionAmountMinor,
      currency: payments.currency,
      succeededAt: payments.succeededAt,
      createdAt: payments.createdAt,
      bookingId: bookings.id,
      bookingStatus: bookings.status,
      customerStartAt: bookings.customerStartAt,
      customerEndAt: bookings.customerEndAt,
      customerEmail: users.email,
      locationId: locations.id,
      locationName: locations.name,
      productName: products.name,
      variantName: productVariants.name,
    })
    .from(payments)
    .innerJoin(bookings, eq(bookings.paymentId, payments.id))
    .innerJoin(users, eq(payments.customerUserId, users.id))
    .innerJoin(locations, eq(bookings.locationId, locations.id))
    .leftJoin(bookingItems, eq(bookingItems.bookingId, bookings.id))
    .leftJoin(inventoryItems, eq(bookingItems.inventoryItemId, inventoryItems.id))
    .leftJoin(productVariants, eq(inventoryItems.productVariantId, productVariants.id))
    .leftJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(payments.organizationId, organizationId),
        gte(payments.createdAt, from),
        lte(payments.createdAt, to),
        options?.locationId ? eq(bookings.locationId, options.locationId) : undefined,
      ),
    )
    .orderBy(desc(payments.createdAt));

  // Dédoublonnage par paymentId (au cas où plusieurs bookingItems sont rattachés)
  const uniquePaymentsMap = new Map<string, (typeof paymentRows)[0]>();
  for (const row of paymentRows) {
    if (!uniquePaymentsMap.has(row.paymentId)) {
      uniquePaymentsMap.set(row.paymentId, row);
    }
  }
  const uniquePayments = Array.from(uniquePaymentsMap.values());

  // 3. Requête des Remboursements (Refunds)
  const refundRows = await db
    .select({
      refundId: refunds.id,
      refundStatus: refunds.status,
      amountMinor: refunds.amountMinor,
      currency: refunds.currency,
      reason: refunds.reason,
      succeededAt: refunds.succeededAt,
      createdAt: refunds.createdAt,
      paymentId: refunds.paymentId,
      bookingId: bookings.id,
      customerEmail: users.email,
      productName: products.name,
    })
    .from(refunds)
    .leftJoin(payments, eq(refunds.paymentId, payments.id))
    .leftJoin(bookings, eq(bookings.paymentId, payments.id))
    .leftJoin(users, eq(payments.customerUserId, users.id))
    .leftJoin(bookingItems, eq(bookingItems.bookingId, bookings.id))
    .leftJoin(inventoryItems, eq(bookingItems.inventoryItemId, inventoryItems.id))
    .leftJoin(productVariants, eq(inventoryItems.productVariantId, productVariants.id))
    .leftJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(refunds.organizationId, organizationId),
        gte(refunds.createdAt, from),
        lte(refunds.createdAt, to),
      ),
    )
    .orderBy(desc(refunds.createdAt));

  const uniqueRefundsMap = new Map<string, (typeof refundRows)[0]>();
  for (const r of refundRows) {
    if (!uniqueRefundsMap.has(r.refundId)) {
      uniqueRefundsMap.set(r.refundId, r);
    }
  }
  const uniqueRefunds = Array.from(uniqueRefundsMap.values());

  // 4. Requête des Versements Bancaires (Payouts)
  const payoutRows = await db
    .select()
    .from(connectedAccountPayouts)
    .where(
      and(
        eq(connectedAccountPayouts.organizationId, organizationId),
        isNull(connectedAccountPayouts.deletedAt),
      ),
    )
    .orderBy(desc(connectedAccountPayouts.createdAt));

  // 5. Calcul des agrégats financiers
  let succeededGrossAmountMinor = 0;
  let pendingAmountMinor = 0;
  let platformCommissionMinor = 0;
  let bookingCount = 0;

  for (const p of uniquePayments) {
    if (p.paymentStatus === 'SUCCEEDED') {
      succeededGrossAmountMinor += p.amountMinor;
      platformCommissionMinor += p.commissionAmountMinor;
      bookingCount++;
    } else if (
      p.paymentStatus === 'PENDING_PROVIDER' ||
      p.paymentStatus === 'REQUIRES_PAYMENT_METHOD' ||
      p.paymentStatus === 'REQUIRES_ACTION' ||
      p.paymentStatus === 'PROCESSING'
    ) {
      pendingAmountMinor += p.amountMinor;
    }
  }

  let totalRefundedMinor = 0;
  for (const r of uniqueRefunds) {
    if (r.refundStatus === 'SUCCEEDED') {
      totalRefundedMinor += r.amountMinor;
    }
  }

  const netAfterCommissionMinor =
    succeededGrossAmountMinor - platformCommissionMinor - totalRefundedMinor;

  // Calcul Versements
  let totalPaidAmountMinor = 0;
  let inTransitAmountMinor = 0;
  let lastPayout: MerchantFinanceOverview['payouts']['lastPayout'] = null;

  for (const po of payoutRows) {
    if (po.status === 'PAID') {
      totalPaidAmountMinor += po.amountMinor;
      if (!lastPayout) {
        lastPayout = {
          amountMinor: po.amountMinor,
          arrivalDate: po.arrivalDate ?? po.paidAt ?? po.createdAt,
          status: po.status,
        };
      }
    } else if (po.status === 'IN_TRANSIT') {
      inTransitAmountMinor += po.amountMinor;
    }
  }

  // 6. Construction de l'activité financière unifiée
  const activityItems: MerchantFinanceActivityItem[] = [];

  for (const p of uniquePayments) {
    const isSucceeded = p.paymentStatus === 'SUCCEEDED';
    const ref = p.bookingId
      ? `#UT-${p.bookingId.slice(0, 6).toUpperCase()}`
      : `#PA-${p.paymentId.slice(0, 6).toUpperCase()}`;

    activityItems.push({
      id: `pay_${p.paymentId}`,
      type: 'PAYMENT',
      bookingId: p.bookingId ?? undefined,
      bookingReference: ref,
      productName: p.productName
        ? `${p.productName} (${p.variantName ?? 'Standard'})`
        : 'Location équipement',
      customerEmail: p.customerEmail ?? undefined,
      grossAmountMinor: p.amountMinor,
      commissionAmountMinor: p.commissionAmountMinor,
      netAmountMinor: p.amountMinor - p.commissionAmountMinor,
      currency: 'EUR',
      status: p.paymentStatus,
      statusLabel: isSucceeded ? '✓ Paiement confirmé' : '⏳ En attente',
      payoutStatus: isSucceeded ? 'PENDING' : 'NOT_APPLICABLE',
      date: p.succeededAt ?? p.createdAt,
    });
  }

  for (const r of uniqueRefunds) {
    const ref = r.bookingId
      ? `#UT-${r.bookingId.slice(0, 6).toUpperCase()}`
      : `#REF-${r.refundId.slice(0, 6).toUpperCase()}`;

    activityItems.push({
      id: `ref_${r.refundId}`,
      type: 'REFUND',
      bookingId: r.bookingId ?? undefined,
      bookingReference: ref,
      productName: r.productName ?? 'Remboursement réservation',
      customerEmail: r.customerEmail ?? undefined,
      grossAmountMinor: -r.amountMinor,
      commissionAmountMinor: 0,
      netAmountMinor: -r.amountMinor,
      currency: 'EUR',
      status: r.refundStatus,
      statusLabel: '↩ Remboursement',
      payoutStatus: 'NOT_APPLICABLE',
      date: r.succeededAt ?? r.createdAt,
    });
  }

  for (const po of payoutRows) {
    if (po.createdAt >= from && po.createdAt <= to) {
      activityItems.push({
        id: `payout_${po.id}`,
        type: 'PAYOUT',
        bookingReference: `Versement ${po.providerPayoutId.slice(0, 10)}`,
        productName: 'Virement bancaire vers votre compte',
        grossAmountMinor: po.amountMinor,
        commissionAmountMinor: 0,
        netAmountMinor: po.amountMinor,
        currency: 'EUR',
        status: po.status,
        statusLabel: po.status === 'PAID' ? '✓ Versé sur votre compte' : '⏳ En cours de transfert',
        payoutStatus: po.status === 'PAID' ? 'PAID' : 'IN_TRANSIT',
        date: po.arrivalDate ?? po.paidAt ?? po.createdAt,
      });
    }
  }

  // Tri antichronologique
  activityItems.sort((a, b) => b.date.getTime() - a.date.getTime());

  // Filtrage par type et recherche
  let filteredActivity = activityItems;
  if (options?.type && options.type !== 'ALL') {
    if (options.type === 'PAYMENTS') {
      filteredActivity = filteredActivity.filter((a) => a.type === 'PAYMENT');
    } else if (options.type === 'REFUNDS') {
      filteredActivity = filteredActivity.filter((a) => a.type === 'REFUND');
    } else if (options.type === 'PAYOUTS') {
      filteredActivity = filteredActivity.filter((a) => a.type === 'PAYOUT');
    }
  }

  if (options?.query && options.query.trim().length > 0) {
    const q = options.query.toLowerCase().trim();
    filteredActivity = filteredActivity.filter(
      (a) =>
        a.bookingReference.toLowerCase().includes(q) ||
        (a.productName && a.productName.toLowerCase().includes(q)) ||
        (a.customerEmail && a.customerEmail.toLowerCase().includes(q)),
    );
  }

  return {
    currency: 'EUR',
    period: {
      from,
      to,
      label: formattedPeriodLabel,
    },
    sales: {
      grossAmountMinor: succeededGrossAmountMinor,
      bookingCount,
    },
    payments: {
      succeededAmountMinor: succeededGrossAmountMinor,
      pendingAmountMinor,
      refundedAmountMinor: totalRefundedMinor,
    },
    commissions: {
      platformAmountMinor: platformCommissionMinor,
    },
    merchant: {
      netAfterCommissionMinor,
    },
    payouts: {
      totalPaidAmountMinor,
      inTransitAmountMinor,
      lastPayout,
      nextPayoutSchedule: 'Automatique selon calendrier bancaire Stripe',
    },
    activity: filteredActivity,
  };
}
