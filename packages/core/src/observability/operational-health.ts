import { sql } from 'drizzle-orm';
import type { DatabaseClient, DbExecutor } from '@uttily/database';

export type OperationalHealthStatus = 'OK' | 'À surveiller' | 'Action requise';

export type OperationalHealthSignalKey =
  'notifications' | 'transactionalEmails' | 'paymentReconciliation' | 'refunds' | 'outbox';

export interface OperationalHealthCounts {
  readonly pendingCount: number;
  readonly dueCount: number;
  readonly failedCount: number;
  readonly manualReviewCount: number;
  readonly activeLeaseCount: number;
  readonly expiredLeaseCount: number;
}

export interface OperationalHealthSignal {
  readonly key: OperationalHealthSignalKey;
  readonly label: string;
  readonly status: OperationalHealthStatus;
  readonly counts: OperationalHealthCounts;
}

export interface OperationalHealth {
  readonly readAt: string;
  readonly signals: readonly OperationalHealthSignal[];
}

interface OperationalHealthRow {
  read_at: Date | string;
  notifications_pending: number | string | bigint;
  notifications_due: number | string | bigint;
  notifications_failed: number | string | bigint;
  notifications_manual_review: number | string | bigint;
  notifications_active_leases: number | string | bigint;
  notifications_expired_leases: number | string | bigint;
  transactional_emails_pending: number | string | bigint;
  transactional_emails_due: number | string | bigint;
  transactional_emails_failed: number | string | bigint;
  transactional_emails_manual_review: number | string | bigint;
  transactional_emails_active_leases: number | string | bigint;
  transactional_emails_expired_leases: number | string | bigint;
  payments_pending: number | string | bigint;
  payments_due: number | string | bigint;
  payments_failed: number | string | bigint;
  payments_manual_review: number | string | bigint;
  payments_active_leases: number | string | bigint;
  payments_expired_leases: number | string | bigint;
  refunds_pending: number | string | bigint;
  refunds_due: number | string | bigint;
  refunds_failed: number | string | bigint;
  refunds_manual_review: number | string | bigint;
  refunds_active_leases: number | string | bigint;
  refunds_expired_leases: number | string | bigint;
  outbox_pending: number | string | bigint;
  outbox_due: number | string | bigint;
  outbox_failed: number | string | bigint;
  outbox_manual_review: number | string | bigint;
  outbox_active_leases: number | string | bigint;
  outbox_expired_leases: number | string | bigint;
}

const NON_TERMINAL_PAYMENT_ATTEMPT_STATUSES = [
  'PENDING_PROVIDER',
  'REQUIRES_PAYMENT_METHOD',
  'REQUIRES_ACTION',
  'PROCESSING',
] as const;

const NON_TERMINAL_PAYMENT_STATUSES_SQL = sql.join(
  NON_TERMINAL_PAYMENT_ATTEMPT_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

function parseCount(value: number | string | bigint): number {
  const count = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('OPERATIONAL_HEALTH_COUNT_INVALID');
  }
  return count;
}

function parseReadAt(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('OPERATIONAL_HEALTH_TIMESTAMP_INVALID');
  return date.toISOString();
}

export function classifyOperationalHealthSignal(
  counts: OperationalHealthCounts,
): OperationalHealthStatus {
  // Une ligne pending ou un lease actif est normal. Seules les lignes dues
  // selon leur timestamp métier, les échecs et les revues manuelles escaladent.
  if (counts.failedCount > 0 || counts.manualReviewCount > 0 || counts.dueCount > 0) {
    return 'Action requise';
  }
  if (counts.expiredLeaseCount > 0) return 'À surveiller';
  return 'OK';
}

function makeSignal(
  key: OperationalHealthSignalKey,
  label: string,
  counts: OperationalHealthCounts,
): OperationalHealthSignal {
  return { key, label, status: classifyOperationalHealthSignal(counts), counts };
}

function mapCounts(
  row: OperationalHealthRow,
  prefix: 'notifications' | 'transactional_emails' | 'payments' | 'refunds' | 'outbox',
): OperationalHealthCounts {
  return {
    pendingCount: parseCount(row[`${prefix}_pending`]),
    dueCount: parseCount(row[`${prefix}_due`]),
    failedCount: parseCount(row[`${prefix}_failed`]),
    manualReviewCount: parseCount(row[`${prefix}_manual_review`]),
    activeLeaseCount: parseCount(row[`${prefix}_active_leases`]),
    expiredLeaseCount: parseCount(row[`${prefix}_expired_leases`]),
  };
}

export function buildOperationalHealth(row: OperationalHealthRow): OperationalHealth {
  return {
    readAt: parseReadAt(row.read_at),
    signals: [
      makeSignal('notifications', 'Notifications', mapCounts(row, 'notifications')),
      makeSignal(
        'transactionalEmails',
        'Emails transactionnels',
        mapCounts(row, 'transactional_emails'),
      ),
      makeSignal(
        'paymentReconciliation',
        'Réconciliation des paiements',
        mapCounts(row, 'payments'),
      ),
      makeSignal('refunds', 'Remboursements', mapCounts(row, 'refunds')),
      makeSignal('outbox', 'Outbox critique', mapCounts(row, 'outbox')),
    ],
  };
}

/**
 * Projection read-only des files persistées critiques.
 *
 * Les bornes sont celles des colonnes métier existantes : scheduled_for /
 * next_attempt_at, available_at et reconcile_after. Aucun seuil arbitraire ne
 * transforme un pending récent en incident.
 */
export async function getOperationalHealth(
  db: DatabaseClient | DbExecutor,
): Promise<OperationalHealth> {
  const rows = await db.execute(sql`
    WITH clock AS (
      SELECT transaction_timestamp() AS read_at
    ),
    payment_attempt_rows AS (
      SELECT pa.status, pa.reconcile_after, pa.reconcile_lease_until
      FROM payment_attempts pa
      UNION ALL
      SELECT apa.status, apa.reconcile_after, apa.reconcile_lease_until
      FROM amendment_payment_attempts apa
    )
    SELECT
      clock.read_at,

      (SELECT count(*) FROM notifications n
       WHERE n.status IN ('PENDING', 'SENDING')) AS notifications_pending,
      (SELECT count(*) FROM notifications n
       WHERE (n.status = 'PENDING'
              AND n.scheduled_for <= clock.read_at
              AND (n.next_attempt_at IS NULL OR n.next_attempt_at <= clock.read_at))
          OR (n.status = 'SENDING'
              AND (n.lease_until IS NULL OR n.lease_until <= clock.read_at))) AS notifications_due,
      (SELECT count(*) FROM notifications n
       WHERE n.status = 'FAILED') AS notifications_failed,
      (SELECT count(*) FROM notifications n
       WHERE n.requires_manual_review = true) AS notifications_manual_review,
      (SELECT count(*) FROM notifications n
       WHERE n.status = 'SENDING' AND n.lease_until > clock.read_at) AS notifications_active_leases,
      (SELECT count(*) FROM notifications n
       WHERE n.status = 'SENDING' AND n.lease_until <= clock.read_at) AS notifications_expired_leases,

      (SELECT count(*)
       FROM notification_deliveries nd
       WHERE nd.status = 'PENDING') AS transactional_emails_pending,
      (SELECT count(*)
       FROM notification_deliveries nd
       JOIN outbox_events oe ON oe.id = nd.outbox_event_id
       WHERE nd.status = 'PENDING'
         AND oe.status IN ('PENDING', 'PROCESSING')
         AND oe.available_at <= clock.read_at
         AND (oe.lease_until IS NULL OR oe.lease_until <= clock.read_at)) AS transactional_emails_due,
      (SELECT count(*)
       FROM notification_deliveries nd
       WHERE nd.status = 'FAILED') AS transactional_emails_failed,
      (SELECT count(*)
       FROM notification_deliveries nd
       WHERE nd.status = 'REQUIRES_MANUAL_REVIEW') AS transactional_emails_manual_review,
      (SELECT count(*)
       FROM notification_deliveries nd
       JOIN outbox_events oe ON oe.id = nd.outbox_event_id
       WHERE nd.status = 'PENDING'
         AND oe.status = 'PROCESSING'
         AND oe.lease_until > clock.read_at) AS transactional_emails_active_leases,
      (SELECT count(*)
       FROM notification_deliveries nd
       JOIN outbox_events oe ON oe.id = nd.outbox_event_id
       WHERE nd.status = 'PENDING'
         AND oe.status = 'PROCESSING'
         AND oe.lease_until <= clock.read_at) AS transactional_emails_expired_leases,

      (SELECT count(*) FROM payment_attempt_rows pa
       WHERE pa.status IN (${NON_TERMINAL_PAYMENT_STATUSES_SQL})) AS payments_pending,
      (SELECT count(*) FROM payment_attempt_rows pa
       WHERE pa.status IN (${NON_TERMINAL_PAYMENT_STATUSES_SQL})
         AND pa.reconcile_after IS NOT NULL
         AND pa.reconcile_after <= clock.read_at
         AND (pa.reconcile_lease_until IS NULL OR pa.reconcile_lease_until <= clock.read_at)) AS payments_due,
      (SELECT count(*) FROM payment_attempt_rows pa
       WHERE pa.status = 'FAILED') AS payments_failed,
      0 AS payments_manual_review,
      (SELECT count(*) FROM payment_attempt_rows pa
       WHERE pa.status IN (${NON_TERMINAL_PAYMENT_STATUSES_SQL})
         AND pa.reconcile_lease_until > clock.read_at) AS payments_active_leases,
      (SELECT count(*) FROM payment_attempt_rows pa
       WHERE pa.status IN (${NON_TERMINAL_PAYMENT_STATUSES_SQL})
         AND pa.reconcile_lease_until <= clock.read_at) AS payments_expired_leases,

      (SELECT count(*) FROM refunds r
       WHERE r.status IN ('PENDING', 'SUBMITTED')) AS refunds_pending,
      (SELECT count(*)
       FROM refunds r
       WHERE r.status = 'PENDING'
         AND EXISTS (
           SELECT 1 FROM outbox_events oe
           WHERE oe.aggregate_type = 'REFUND'
             AND oe.aggregate_id = r.id
             AND oe.event_type = 'REFUND_REQUESTED'
             AND oe.status IN ('PENDING', 'PROCESSING')
             AND oe.available_at <= clock.read_at
             AND (oe.lease_until IS NULL OR oe.lease_until <= clock.read_at)
         )) AS refunds_due,
      (SELECT count(*) FROM refunds r
       WHERE r.status IN ('FAILED', 'FAILED_REQUIRES_MANUAL_ACTION')) AS refunds_failed,
      (SELECT count(*) FROM refunds r
       WHERE r.status = 'FAILED_REQUIRES_MANUAL_ACTION') AS refunds_manual_review,
      (SELECT count(*)
       FROM refunds r
       WHERE r.status = 'PENDING'
         AND EXISTS (
           SELECT 1 FROM outbox_events oe
           WHERE oe.aggregate_type = 'REFUND'
             AND oe.aggregate_id = r.id
             AND oe.event_type = 'REFUND_REQUESTED'
             AND oe.status = 'PROCESSING'
             AND oe.lease_until > clock.read_at
         )) AS refunds_active_leases,
      (SELECT count(*)
       FROM refunds r
       WHERE r.status = 'PENDING'
         AND EXISTS (
           SELECT 1 FROM outbox_events oe
           WHERE oe.aggregate_type = 'REFUND'
             AND oe.aggregate_id = r.id
             AND oe.event_type = 'REFUND_REQUESTED'
             AND oe.status = 'PROCESSING'
             AND oe.lease_until <= clock.read_at
         )) AS refunds_expired_leases,

      (SELECT count(*) FROM outbox_events oe
       WHERE oe.status IN ('PENDING', 'PROCESSING')) AS outbox_pending,
      (SELECT count(*) FROM outbox_events oe
       WHERE oe.status IN ('PENDING', 'PROCESSING')
         AND oe.available_at <= clock.read_at
         AND (oe.lease_until IS NULL OR oe.lease_until <= clock.read_at)) AS outbox_due,
      (SELECT count(*) FROM outbox_events oe
       WHERE oe.status = 'FAILED') AS outbox_failed,
      0 AS outbox_manual_review,
      (SELECT count(*) FROM outbox_events oe
       WHERE oe.status = 'PROCESSING' AND oe.lease_until > clock.read_at) AS outbox_active_leases,
      (SELECT count(*) FROM outbox_events oe
       WHERE oe.status = 'PROCESSING' AND oe.lease_until <= clock.read_at) AS outbox_expired_leases
    FROM clock
  `);

  const row = (rows as unknown as OperationalHealthRow[])[0];
  if (!row) throw new Error('OPERATIONAL_HEALTH_ROW_MISSING');
  return buildOperationalHealth(row);
}
