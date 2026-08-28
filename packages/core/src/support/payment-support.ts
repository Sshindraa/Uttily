import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { DatabaseClient, DbExecutor } from '@uttily/database';
import { bookings, organizations, paymentAttempts, payments, users } from '@uttily/database';
import type { PaymentSupportListItem } from './types';

export interface ListPaymentsSupportOptions {
  readonly status?: string | undefined;
  readonly organizationId?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  readonly requiresAttentionOnly?: boolean | undefined;
}

/**
 * Liste les paiements avec diagnostics pour la console support.
 */
export async function listPaymentsSupport(
  db: DatabaseClient | DbExecutor,
  options?: ListPaymentsSupportOptions,
): Promise<readonly PaymentSupportListItem[]> {
  const limit = Math.max(1, Math.min(options?.limit ?? 50, 100));
  const offset = Math.max(0, options?.offset ?? 0);

  const conditions = [];

  if (options?.status) {
    conditions.push(
      eq(payments.status, options.status as (typeof payments.$inferSelect)['status']),
    );
  }
  if (options?.organizationId) {
    conditions.push(eq(payments.organizationId, options.organizationId));
  }
  if (options?.requiresAttentionOnly) {
    conditions.push(
      sql`${payments.status} IN ('FAILED', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION')`,
    );
  }

  const query = db
    .select({
      id: payments.id,
      organizationId: payments.organizationId,
      draftId: payments.draftId,
      status: payments.status,
      amountMinor: payments.amountMinor,
      currency: payments.currency,
      createdAt: payments.createdAt,
      orgLegalName: organizations.legalName,
    })
    .from(payments)
    .innerJoin(organizations, eq(payments.organizationId, organizations.id))
    .orderBy(desc(payments.createdAt))
    .limit(limit)
    .offset(offset);

  const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;

  if (rows.length === 0) {
    return [];
  }

  const paymentIds = rows.map((r) => r.id);
  const paymentIntentMap: Record<string, string | null> = {};
  const lastErrors: Record<string, string | null> = {};
  const bookingMap: Record<string, { id: string; customerEmail: string | null }> = {};

  if (paymentIds.length > 0) {
    const attempts = await db
      .select({
        paymentId: paymentAttempts.paymentId,
        providerPaymentIntentId: paymentAttempts.providerPaymentIntentId,
        errorCode: paymentAttempts.lastProviderErrorCode,
      })
      .from(paymentAttempts)
      .where(inArray(paymentAttempts.paymentId, paymentIds))
      .orderBy(desc(paymentAttempts.createdAt));

    for (const a of attempts) {
      if (!paymentIntentMap[a.paymentId] && a.providerPaymentIntentId) {
        paymentIntentMap[a.paymentId] = a.providerPaymentIntentId;
      }
    }

    for (const a of attempts) {
      if (!lastErrors[a.paymentId] && a.errorCode) {
        lastErrors[a.paymentId] = a.errorCode;
      }
    }

    const draftIds = rows.map((r) => r.draftId).filter(Boolean) as string[];
    const bConditions = [inArray(bookings.paymentId, paymentIds)];
    if (draftIds.length > 0) {
      bConditions.push(inArray(bookings.draftId, draftIds));
    }

    const bRows = await db
      .select({
        id: bookings.id,
        paymentId: bookings.paymentId,
        draftId: bookings.draftId,
        customerEmail: users.email,
      })
      .from(bookings)
      .innerJoin(users, eq(bookings.customerUserId, users.id))
      .where(or(...bConditions));

    for (const b of bRows) {
      if (b.paymentId) {
        bookingMap[b.paymentId] = {
          id: b.id,
          customerEmail: b.customerEmail ?? null,
        };
      }
      if (b.draftId) {
        bookingMap[b.draftId] = {
          id: b.id,
          customerEmail: b.customerEmail ?? null,
        };
      }
    }
  }

  return rows.map((r) => {
    const bk = bookingMap[r.id] ?? (r.draftId ? bookingMap[r.draftId] : undefined);
    const isError =
      r.status === 'FAILED' ||
      r.status === 'REQUIRES_PAYMENT_METHOD' ||
      r.status === 'REQUIRES_ACTION';
    return {
      id: r.id,
      organizationId: r.organizationId,
      organizationName: r.orgLegalName,
      bookingId: bk?.id ?? null,
      customerEmail: bk?.customerEmail ?? null,
      amountMinor: r.amountMinor,
      currency: r.currency,
      status: r.status,
      providerPaymentIntentId: paymentIntentMap[r.id] ?? null,
      createdAt: r.createdAt,
      lastError: lastErrors[r.id] ?? null,
      requiresAttention: isError,
    };
  });
}
