import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { privacyRequests, users } from '@uttily/database';
import type {
  ExtensionComplianceStatus,
  ListPrivacyRequestsFilters,
  ListPrivacyRequestsResult,
  PrivacyRequestUrgency,
  SupportPrivacyRequestItem,
} from './types';

const ACTIVE_STATUSES = [
  'RECEIVED',
  'IDENTITY_CHECK_REQUIRED',
  'IN_REVIEW',
  'DECISION_READY',
] as const;
const CLOSED_STATUSES = ['COMPLETED', 'CANCELLED'] as const;

function computeUrgency(
  effectiveDueAt: Date,
  now: Date,
): { daysRemaining: number; urgency: PrivacyRequestUrgency } {
  const diffMs = effectiveDueAt.getTime() - now.getTime();
  const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  let urgency: PrivacyRequestUrgency;
  if (daysRemaining < 0) {
    urgency = 'DUE_OVERDUE';
  } else if (daysRemaining <= 7) {
    urgency = 'DUE_IMMINENT';
  } else if (daysRemaining <= 15) {
    urgency = 'DUE_WARNING';
  } else {
    urgency = 'DUE_OK';
  }

  return { daysRemaining, urgency };
}

function computeExtensionCompliance(
  extendedUntil: Date | null,
  extensionNotifiedAt: Date | null,
  responseDueAt: Date,
): { isEffective: boolean; compliance: ExtensionComplianceStatus } {
  if (!extendedUntil) {
    return { isEffective: false, compliance: 'NONE' };
  }
  if (!extensionNotifiedAt) {
    return { isEffective: false, compliance: 'PENDING_NOTIFICATION' };
  }
  // Règle d'or Art. 12(3) RGPD : l'information du demandeur doit intervenir dans le 1er mois.
  // Une notification tardive (> responseDueAt) ne régularise pas rétroactivement la prorogation.
  if (extensionNotifiedAt.getTime() <= responseDueAt.getTime()) {
    return { isEffective: true, compliance: 'NOTIFIED_TIMELY' };
  }
  return { isEffective: false, compliance: 'NOTIFIED_LATE' };
}

export async function listPrivacyRequestsSupport(
  db: DatabaseClient,
  filters: ListPrivacyRequestsFilters = {},
): Promise<ListPrivacyRequestsResult> {
  const { tab = 'ACTIVE', requestType, limit = 50, offset = 0 } = filters;
  const now = new Date();

  // 1. Build conditions
  const conditions = [];

  if (tab === 'ACTIVE') {
    conditions.push(inArray(privacyRequests.status, [...ACTIVE_STATUSES]));
  } else if (tab === 'CLOSED') {
    conditions.push(inArray(privacyRequests.status, [...CLOSED_STATUSES]));
  }

  if (requestType && requestType !== 'ALL') {
    conditions.push(
      eq(
        privacyRequests.requestType,
        requestType as (typeof privacyRequests.requestType.enumValues)[number],
      ),
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // 2. Fetch rows with joined user details
  const rows = await db
    .select({
      request: privacyRequests,
      userEmail: users.email,
      userDisplayName: users.displayName,
    })
    .from(privacyRequests)
    .leftJoin(users, eq(privacyRequests.userId, users.id))
    .where(whereClause)
    .orderBy(desc(privacyRequests.receivedAt))
    .limit(limit)
    .offset(offset);

  // 3. Compute counts (SLA effectif uniquement si information notifiée dans le délai initial)
  const countRows = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${inArray(privacyRequests.status, [...ACTIVE_STATUSES])})::int`,
      closed: sql<number>`count(*) filter (where ${inArray(privacyRequests.status, [...CLOSED_STATUSES])})::int`,
      overdue: sql<number>`count(*) filter (where ${inArray(privacyRequests.status, [...ACTIVE_STATUSES])} and (case when ${privacyRequests.extendedUntil} is not null and ${privacyRequests.extensionNotifiedAt} is not null and ${privacyRequests.extensionNotifiedAt} <= ${privacyRequests.responseDueAt} then ${privacyRequests.extendedUntil} else ${privacyRequests.responseDueAt} end) < now())::int`,
    })
    .from(privacyRequests);

  const counts = countRows[0] ?? { total: 0, active: 0, closed: 0, overdue: 0 };

  // 4. Map to SupportPrivacyRequestItem
  const items: SupportPrivacyRequestItem[] = rows.map(({ request, userEmail, userDisplayName }) => {
    const { isEffective, compliance } = computeExtensionCompliance(
      request.extendedUntil,
      request.extensionNotifiedAt,
      request.responseDueAt,
    );
    const effectiveDueAt =
      isEffective && request.extendedUntil ? request.extendedUntil : request.responseDueAt;
    const { daysRemaining, urgency } = computeUrgency(effectiveDueAt, now);

    const responseCompliance =
      request.status === 'COMPLETED' && request.responseNotifiedAt
        ? request.responseNotifiedAt > effectiveDueAt
          ? 'RESPONSE_LATE'
          : 'ON_TIME'
        : null;

    return {
      id: request.id,
      userId: request.userId,
      userEmail: userEmail ?? null,
      userDisplayName: userDisplayName ?? null,
      requestType: request.requestType,
      status: request.status,
      resolution: request.resolution ?? null,
      details: request.details,
      decisionReasonCode: request.decisionReasonCode,
      resolutionNotes: request.resolutionNotes,
      decisionAt: request.decisionAt ?? null,
      decisionByUserId: request.decisionByUserId ?? null,
      responseNotifiedAt: request.responseNotifiedAt ?? null,
      responseNotifiedByUserId: request.responseNotifiedByUserId ?? null,
      receivedAt: request.receivedAt,
      responseDueAt: request.responseDueAt,
      extendedUntil: request.extendedUntil,
      extensionReason: request.extensionReason,
      extendedAt: request.extendedAt,
      extendedByUserId: request.extendedByUserId,
      extensionNotifiedAt: request.extensionNotifiedAt,
      extensionCompliance: compliance,
      effectiveDueAt,
      responseCompliance,
      daysRemaining,
      urgency,
      resolvedAt: request.resolvedAt,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    };
  });

  return {
    items,
    totalCount: counts.total,
    activeCount: counts.active,
    closedCount: counts.closed,
    overdueCount: counts.overdue,
  };
}
