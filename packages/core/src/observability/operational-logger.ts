/**
 * Logger opérationnel serveur fermé et best-effort.
 *
 * Le contrat n'autorise que des codes d'opération, des états, des durées, des
 * compteurs, un code d'erreur normalisé et, si nécessaire, un identifiant de
 * run technique. Les valeurs métier, erreurs brutes et payloads ne peuvent
 * pas être sérialisés par ce helper.
 */

export const OPERATIONAL_OPERATIONS = [
  'notifications',
  'transactional_emails',
  'payment_reconciliation',
  'refunds',
  'cron_expire_holds',
  'cron_reconcile_payments',
  'cron_process_refunds',
  'cron_process_compensations',
  'worker_cycle',
  'worker_documents',
  'worker_emails',
  'worker_email_finalizer',
  'internal_health',
  'unknown_operation',
] as const;

export type OperationalOperation = (typeof OPERATIONAL_OPERATIONS)[number];

export type OperationalOutcome = 'success' | 'degraded' | 'failed';

export type OperationalCountKey =
  | 'claimed'
  | 'processed'
  | 'sent'
  | 'failed'
  | 'pending'
  | 'due'
  | 'reconciled'
  | 'confirmed'
  | 'cancelled'
  | 'rescheduled'
  | 'compensated'
  | 'retried'
  | 'expired'
  | 'submitted'
  | 'alreadyResolved'
  | 'manualReview'
  | 'anomalies'
  | 'activeLeases'
  | 'expiredLeases'
  | 'ignoredLateSuccess'
  | 'skippedExpired';

export interface OperationalLogInput {
  readonly operation: OperationalOperation;
  readonly outcome: OperationalOutcome;
  readonly durationMs?: number | undefined;
  readonly counts?: Partial<Record<OperationalCountKey, number>> | undefined;
  readonly errorCode?: string | undefined;
  readonly runId?: string | undefined;
}

export interface OperationalLogEvent {
  readonly timestamp: string;
  readonly operation: OperationalOperation;
  readonly outcome: OperationalOutcome;
  readonly durationMs?: number;
  readonly counts?: Partial<Record<OperationalCountKey, number>>;
  readonly errorCode?: string;
  readonly runId?: string;
}

export type OperationalLogSink = (serializedEvent: string) => void;

const DEFAULT_SINK: OperationalLogSink = (serializedEvent) => {
  console.info(serializedEvent);
};

const OPERATIONAL_OPERATION_SET = new Set<string>(OPERATIONAL_OPERATIONS);
const OPERATIONAL_COUNT_KEYS = new Set<OperationalCountKey>([
  'claimed',
  'processed',
  'sent',
  'failed',
  'pending',
  'due',
  'reconciled',
  'confirmed',
  'cancelled',
  'rescheduled',
  'compensated',
  'retried',
  'expired',
  'submitted',
  'alreadyResolved',
  'manualReview',
  'anomalies',
  'activeLeases',
  'expiredLeases',
  'ignoredLateSuccess',
  'skippedExpired',
]);

function normalizeOperation(operation: unknown): OperationalOperation {
  return typeof operation === 'string' && OPERATIONAL_OPERATION_SET.has(operation)
    ? (operation as OperationalOperation)
    : 'unknown_operation';
}

function normalizeDuration(durationMs: unknown): number | undefined {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }
  return Math.min(Math.floor(durationMs), Number.MAX_SAFE_INTEGER);
}

function normalizeCounts(
  counts: OperationalLogInput['counts'],
): Partial<Record<OperationalCountKey, number>> | undefined {
  if (!counts || typeof counts !== 'object') return undefined;

  const safeCounts: Partial<Record<OperationalCountKey, number>> = {};
  for (const key of OPERATIONAL_COUNT_KEYS) {
    const value = counts[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      safeCounts[key] = value;
    }
  }
  return Object.keys(safeCounts).length > 0 ? safeCounts : undefined;
}

function normalizeErrorCode(errorCode: unknown): string | undefined {
  if (typeof errorCode !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(errorCode)) {
    return errorCode === undefined ? undefined : 'UNKNOWN_ERROR';
  }
  return errorCode;
}

function normalizeRunId(runId: unknown): string | undefined {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(runId)) return undefined;
  return runId;
}

/**
 * Émet un événement JSON structuré sans jamais laisser une erreur de logging
 * modifier le résultat métier.
 */
export function emitOperationalLog(
  input: OperationalLogInput,
  sink: OperationalLogSink = DEFAULT_SINK,
): void {
  try {
    const event: {
      timestamp: string;
      operation: OperationalOperation;
      outcome: OperationalOutcome;
      durationMs?: number;
      counts?: Partial<Record<OperationalCountKey, number>>;
      errorCode?: string;
      runId?: string;
    } = {
      timestamp: new Date().toISOString(),
      operation: normalizeOperation(input.operation),
      outcome: input.outcome,
    };

    const durationMs = normalizeDuration(input.durationMs);
    if (durationMs !== undefined) event.durationMs = durationMs;

    const counts = normalizeCounts(input.counts);
    if (counts !== undefined) event.counts = counts;

    const errorCode = normalizeErrorCode(input.errorCode);
    if (errorCode !== undefined) event.errorCode = errorCode;

    const runId = normalizeRunId(input.runId);
    if (runId !== undefined) event.runId = runId;

    sink(JSON.stringify(event));
  } catch {
    // L'observabilité est best-effort : un sink défaillant ne doit jamais
    // casser le traitement métier qui vient d'être instrumenté.
  }
}
