import { desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { DatabaseClient, DbExecutor } from '@uttily/database';
import {
  bookings,
  locations,
  organizations,
  paymentAttempts,
  payments,
  refunds,
  users,
} from '@uttily/database';
import type { SupportSearchItem, SupportSearchResult } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SearchSupportOptions {
  readonly limit?: number;
}

/**
 * Moteur de recherche globale pour le back-office Uttily.
 * Recherche multi-entités rapide et tolérante (UUID, email, nom, slug, référence).
 */
export async function searchSupport(
  db: DatabaseClient | DbExecutor,
  rawQuery: string,
  options?: SearchSupportOptions,
): Promise<SupportSearchResult> {
  const query = (rawQuery ?? '').trim();
  const limit = Math.max(1, Math.min(options?.limit ?? 10, 50));

  if (!query) {
    return {
      query: '',
      totalMatches: 0,
      items: [],
      byCategory: {
        organizations: [],
        locations: [],
        bookings: [],
        users: [],
        payments: [],
        refunds: [],
      },
    };
  }

  const isUuid = UUID_RE.test(query);
  const pattern = `%${query}%`;

  const [orgRows, locRows, bookingRows, userRows, paymentRows, refundRows] = await Promise.all([
    // 1. Organisations
    db
      .select({
        id: organizations.id,
        legalName: organizations.legalName,
        slug: organizations.slug,
        publicDisplayName: organizations.publicDisplayName,
        status: organizations.status,
      })
      .from(organizations)
      .where(
        isUuid
          ? or(
              eq(organizations.id, query),
              ilike(organizations.legalName, pattern),
              ilike(organizations.slug, pattern),
            )
          : or(
              ilike(organizations.legalName, pattern),
              ilike(organizations.slug, pattern),
              ilike(organizations.publicDisplayName, pattern),
            ),
      )
      .limit(limit),

    // 2. Établissements
    db
      .select({
        id: locations.id,
        name: locations.name,
        city: locations.city,
        postalCode: locations.postalCode,
        organizationId: locations.organizationId,
        orgLegalName: organizations.legalName,
      })
      .from(locations)
      .innerJoin(organizations, eq(locations.organizationId, organizations.id))
      .where(
        isUuid
          ? or(
              eq(locations.id, query),
              ilike(locations.name, pattern),
              ilike(locations.city, pattern),
            )
          : or(
              ilike(locations.name, pattern),
              ilike(locations.city, pattern),
              ilike(locations.postalCode, pattern),
            ),
      )
      .limit(limit),

    // 3. Réservations
    db
      .select({
        id: bookings.id,
        organizationId: bookings.organizationId,
        status: bookings.status,
        customerEmail: users.email,
        customerName: users.displayName,
        totalAmountMinor: bookings.totalAmountMinor,
        currency: bookings.currency,
        createdAt: bookings.createdAt,
        orgLegalName: organizations.legalName,
      })
      .from(bookings)
      .innerJoin(organizations, eq(bookings.organizationId, organizations.id))
      .innerJoin(users, eq(bookings.customerUserId, users.id))
      .where(
        isUuid
          ? eq(bookings.id, query)
          : or(
              sql`${bookings.id}::text ILIKE ${pattern}`,
              ilike(users.email, pattern),
              ilike(users.displayName, pattern),
            ),
      )
      .orderBy(desc(bookings.createdAt))
      .limit(limit),

    // 4. Utilisateurs / Comptes
    db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        isPlatformAdmin: users.isPlatformAdmin,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(
        isUuid
          ? or(eq(users.id, query), ilike(users.email, pattern))
          : or(ilike(users.email, pattern), ilike(users.displayName, pattern)),
      )
      .limit(limit),

    // 5. Paiements
    db
      .select({
        id: payments.id,
        organizationId: payments.organizationId,
        draftId: payments.draftId,
        status: payments.status,
        amountMinor: payments.amountMinor,
        currency: payments.currency,
        providerPaymentIntentId: paymentAttempts.providerPaymentIntentId,
        createdAt: payments.createdAt,
        orgLegalName: organizations.legalName,
      })
      .from(payments)
      .innerJoin(organizations, eq(payments.organizationId, organizations.id))
      .leftJoin(paymentAttempts, eq(paymentAttempts.paymentId, payments.id))
      .where(
        isUuid
          ? or(eq(payments.id, query), eq(payments.draftId, query))
          : or(
              sql`${payments.id}::text ILIKE ${pattern}`,
              ilike(paymentAttempts.providerPaymentIntentId, pattern),
            ),
      )
      .orderBy(desc(payments.createdAt))
      .limit(limit),

    // 6. Remboursements
    db
      .select({
        id: refunds.id,
        paymentId: refunds.paymentId,
        organizationId: refunds.organizationId,
        status: refunds.status,
        amountMinor: refunds.amountMinor,
        currency: refunds.currency,
        providerRefundId: refunds.providerRefundId,
        reason: refunds.reason,
        createdAt: refunds.createdAt,
        orgLegalName: organizations.legalName,
      })
      .from(refunds)
      .innerJoin(organizations, eq(refunds.organizationId, organizations.id))
      .where(
        isUuid
          ? or(eq(refunds.id, query), eq(refunds.paymentId, query))
          : or(sql`${refunds.id}::text ILIKE ${pattern}`, ilike(refunds.providerRefundId, pattern)),
      )
      .orderBy(desc(refunds.createdAt))
      .limit(limit),
  ]);

  const orgItems: SupportSearchItem[] = orgRows.map((r) => ({
    id: r.id,
    entityType: 'ORGANIZATION',
    title: r.publicDisplayName || r.legalName,
    subtitle: `Slug: ${r.slug} • Statut: ${r.status}`,
    url: `/internal/organizations/${r.id}`,
    badge: {
      label: r.status,
      variant: r.status === 'ACTIVE' ? 'success' : 'warning',
    },
    metadata: { slug: r.slug, legalName: r.legalName },
  }));

  const locItems: SupportSearchItem[] = locRows.map((r) => ({
    id: r.id,
    entityType: 'LOCATION',
    title: r.name,
    subtitle: `${r.postalCode ?? ''} ${r.city ?? ''} • Org: ${r.orgLegalName}`.trim(),
    url: `/internal/organizations/${r.organizationId}#location-${r.id}`,
    badge: {
      label: 'Établissement',
      variant: 'info',
    },
    metadata: { city: r.city, orgId: r.organizationId },
  }));

  const bookingItems: SupportSearchItem[] = bookingRows.map((r) => {
    const email = r.customerEmail || 'Sans email';
    const amountStr = `${(r.totalAmountMinor / 100).toFixed(2)} ${r.currency}`;
    return {
      id: r.id,
      entityType: 'BOOKING',
      title: `Réservation ${r.id.slice(0, 8)}… (${amountStr})`,
      subtitle: `Client: ${email} • Org: ${r.orgLegalName}`,
      url: `/internal/bookings/${r.id}`,
      badge: {
        label: r.status,
        variant:
          r.status === 'CONFIRMED' || r.status === 'ACTIVE'
            ? 'success'
            : r.status === 'CANCELLED'
              ? 'danger'
              : 'default',
      },
      metadata: { customerEmail: email, orgId: r.organizationId },
    };
  });

  const userItems: SupportSearchItem[] = userRows.map((r) => ({
    id: r.id,
    entityType: 'USER',
    title: r.displayName || r.email,
    subtitle: `Email: ${r.email}${r.isPlatformAdmin ? ' • [Admin Uttily]' : ''}`,
    url: `/internal?query=${encodeURIComponent(r.email)}`,
    badge: r.isPlatformAdmin
      ? { label: 'Admin Uttily', variant: 'warning' }
      : { label: 'Utilisateur', variant: 'default' },
    metadata: { email: r.email, isPlatformAdmin: r.isPlatformAdmin },
  }));

  const paymentItems: SupportSearchItem[] = paymentRows.map((r) => {
    const amountStr = `${(r.amountMinor / 100).toFixed(2)} ${r.currency}`;
    return {
      id: r.id,
      entityType: 'PAYMENT',
      title: `Paiement ${r.id.slice(0, 8)}… (${amountStr})`,
      subtitle: `Statut: ${r.status} • Intent: ${r.providerPaymentIntentId ?? 'N/A'} • Org: ${r.orgLegalName}`,
      url: `/internal/payments#payment-${r.id}`,
      badge: {
        label: r.status,
        variant:
          r.status === 'SUCCEEDED' ? 'success' : r.status === 'FAILED' ? 'danger' : 'warning',
      },
      metadata: { intentId: r.providerPaymentIntentId, orgId: r.organizationId },
    };
  });

  const refundItems: SupportSearchItem[] = refundRows.map((r) => {
    const amountStr = `${(r.amountMinor / 100).toFixed(2)} ${r.currency}`;
    return {
      id: r.id,
      entityType: 'REFUND',
      title: `Remboursement ${r.id.slice(0, 8)}… (${amountStr})`,
      subtitle: `Statut: ${r.status} • Motif: ${r.reason} • Org: ${r.orgLegalName}`,
      url: `/internal/payments#refund-${r.id}`,
      badge: {
        label: r.status,
        variant:
          r.status === 'SUCCEEDED'
            ? 'success'
            : r.status === 'FAILED_REQUIRES_MANUAL_ACTION'
              ? 'danger'
              : 'warning',
      },
      metadata: { paymentId: r.paymentId, orgId: r.organizationId },
    };
  });

  const allItems = [
    ...orgItems,
    ...locItems,
    ...bookingItems,
    ...userItems,
    ...paymentItems,
    ...refundItems,
  ];

  return {
    query,
    totalMatches: allItems.length,
    items: allItems,
    byCategory: {
      organizations: orgItems,
      locations: locItems,
      bookings: bookingItems,
      users: userItems,
      payments: paymentItems,
      refunds: refundItems,
    },
  };
}
