/**
 * @uttily/core — Résolution de l'intention tarifaire effective (G7M-C5-A).
 *
 * ADR-023 §6 & G7M-C5-A : lecture canonique tenant-scoped de l'intention tarifaire
 * active sur une réservation pour préserver fidèlement son type (TIME_RANGE / DAY_RANGE) :
 * 1. Depuis `booking_amendment_lines.pricing_snapshot.intentSnapshot` du dernier amendement APPLIED s'il existe ;
 * 2. Sinon depuis `bookings.pricing_intent_type` et `bookings.pricing_intent_snapshot` pour flexible-pricing-v1 ;
 * 3. Sinon dérivation exclusive DAY_RANGE pour une réservation legacy sans snapshot flexible.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { bookings, bookingAmendments, bookingAmendmentLines } from '@uttily/database';
import type { NeutralAmendmentIntent } from './types-amendment';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_LOCAL_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function formatLocalDateInTimeZone(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

function parseIntentObject(raw: unknown): NeutralAmendmentIntent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const snap = raw as Record<string, unknown>;

  if (snap.kind === 'TIME_RANGE') {
    if (
      typeof snap.startAt === 'string' &&
      DATETIME_LOCAL_REGEX.test(snap.startAt) &&
      typeof snap.endAt === 'string' &&
      DATETIME_LOCAL_REGEX.test(snap.endAt) &&
      snap.endAt > snap.startAt
    ) {
      return {
        kind: 'TIME_RANGE',
        startAt: snap.startAt.slice(0, 16),
        endAt: snap.endAt.slice(0, 16),
      };
    }
    return null;
  }

  if (snap.kind === 'DAY_RANGE') {
    if (
      typeof snap.startDate === 'string' &&
      DATE_REGEX.test(snap.startDate) &&
      typeof snap.endDateExclusive === 'string' &&
      DATE_REGEX.test(snap.endDateExclusive) &&
      snap.endDateExclusive > snap.startDate
    ) {
      return {
        kind: 'DAY_RANGE',
        startDate: snap.startDate.slice(0, 10),
        endDateExclusive: snap.endDateExclusive.slice(0, 10),
      };
    }
    return null;
  }

  return null;
}

export type GetEffectivePricingIntentResult =
  | { kind: 'SUCCESS'; intent: NeutralAmendmentIntent }
  | { kind: 'NOT_FOUND' }
  | { kind: 'INVALID_INTENT'; message: string };

/**
 * Résout l'intention tarifaire effective d'une réservation de manière fail-closed et tenant-safe.
 */
export async function getEffectivePricingIntent(
  db: DatabaseClient,
  organizationId: string,
  bookingId: string,
  locationTimeZone: string,
  effectiveCustomerStartAt: Date,
  effectiveCustomerEndAt: Date,
): Promise<GetEffectivePricingIntentResult> {
  // 1. Chercher le dernier amendement APPLIED par amendment_number DESC, puis id DESC
  const appliedAmendments = await db
    .select({
      id: bookingAmendments.id,
      amendmentNumber: bookingAmendments.amendmentNumber,
    })
    .from(bookingAmendments)
    .where(
      and(
        eq(bookingAmendments.bookingId, bookingId),
        eq(bookingAmendments.organizationId, organizationId),
        eq(bookingAmendments.status, 'APPLIED'),
      ),
    )
    .orderBy(desc(bookingAmendments.amendmentNumber), desc(bookingAmendments.id))
    .limit(1);

  if (appliedAmendments.length > 0) {
    const latestAmendment = appliedAmendments[0]!;

    // Charger les lignes actives (non REMOVE) de cet amendement
    const lines = await db
      .select({
        id: bookingAmendmentLines.id,
        action: bookingAmendmentLines.action,
        pricingSnapshot: bookingAmendmentLines.pricingSnapshot,
      })
      .from(bookingAmendmentLines)
      .where(
        and(
          eq(bookingAmendmentLines.amendmentId, latestAmendment.id),
          eq(bookingAmendmentLines.organizationId, organizationId),
        ),
      );

    const activeLines = lines.filter((l) => l.action !== 'REMOVE');
    if (activeLines.length === 0) {
      return {
        kind: 'INVALID_INTENT',
        message: 'Dernier amendement APPLIED sans aucune ligne active.',
      };
    }

    let resolvedIntent: NeutralAmendmentIntent | null = null;

    for (const line of activeLines) {
      if (typeof line.pricingSnapshot !== 'object' || line.pricingSnapshot === null) {
        return {
          kind: 'INVALID_INTENT',
          message: 'Ligne sans pricingSnapshot valide.',
        };
      }
      const rawIntentSnapshot = (line.pricingSnapshot as Record<string, unknown>).intentSnapshot;
      const parsed = parseIntentObject(rawIntentSnapshot);
      if (parsed === null) {
        return {
          kind: 'INVALID_INTENT',
          message: 'Ligne avec intentSnapshot manquant ou invalide.',
        };
      }

      if (resolvedIntent === null) {
        resolvedIntent = parsed;
      } else {
        // Vérifier la cohérence stricte entre toutes les lignes de l'amendement
        if (
          resolvedIntent.kind !== parsed.kind ||
          (resolvedIntent.kind === 'TIME_RANGE' &&
            (resolvedIntent.startAt !== (parsed as typeof resolvedIntent).startAt ||
              resolvedIntent.endAt !== (parsed as typeof resolvedIntent).endAt)) ||
          (resolvedIntent.kind === 'DAY_RANGE' &&
            (resolvedIntent.startDate !== (parsed as typeof resolvedIntent).startDate ||
              resolvedIntent.endDateExclusive !==
                (parsed as typeof resolvedIntent).endDateExclusive))
        ) {
          return {
            kind: 'INVALID_INTENT',
            message: 'Incohérence d intention entre les lignes du dernier amendement APPLIED.',
          };
        }
      }
    }

    return { kind: 'SUCCESS', intent: resolvedIntent! };
  }

  // 2. Aucun amendement APPLIED : lire depuis la réservation originale
  const bookingRows = await db
    .select({
      id: bookings.id,
      pricingSnapshotVersion: bookings.pricingSnapshotVersion,
      pricingIntentType: bookings.pricingIntentType,
      pricingIntentSnapshot: bookings.pricingIntentSnapshot,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.organizationId, organizationId)))
    .limit(1);

  if (bookingRows.length === 0) {
    return { kind: 'NOT_FOUND' };
  }

  const booking = bookingRows[0]!;

  // Réservation avec snapshot flexible v1
  if (booking.pricingSnapshotVersion === 'flexible-pricing-v1') {
    if (booking.pricingIntentType === null || booking.pricingIntentSnapshot === null) {
      return {
        kind: 'INVALID_INTENT',
        message: 'Réservation flexible avec snapshot d intention manquant ou incomplet.',
      };
    }
    const parsed = parseIntentObject(booking.pricingIntentSnapshot);
    if (parsed === null || parsed.kind !== booking.pricingIntentType) {
      return {
        kind: 'INVALID_INTENT',
        message: 'Snapshot d intention flexible malformé ou incohérent avec pricing_intent_type.',
      };
    }
    return { kind: 'SUCCESS', intent: parsed };
  }

  // Réservation legacy (sans flexible pricing snapshot) : dériver uniquement un DAY_RANGE
  const startDate = formatLocalDateInTimeZone(effectiveCustomerStartAt, locationTimeZone);
  const endDateExclusive = formatLocalDateInTimeZone(effectiveCustomerEndAt, locationTimeZone);

  return {
    kind: 'SUCCESS',
    intent: {
      kind: 'DAY_RANGE',
      startDate,
      endDateExclusive,
    },
  };
}
