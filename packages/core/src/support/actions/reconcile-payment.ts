import { eq, and, inArray } from 'drizzle-orm';
import type { DatabaseClient, DbExecutor } from '@uttily/database';
import { paymentAttempts, payments } from '@uttily/database';
import { writeAuditEntry } from '../../identity/audit';

export interface ReconcilePaymentSupportInput {
  readonly paymentId: string;
  readonly actorUserId: string;
  readonly reason: string;
}

/**
 * Force la réconciliation d'un paiement en remettant ses tentatives en attente
 * de vérification immédiate par le worker de réconciliation.
 * Action consignée dans l'audit trail.
 */
export async function reconcilePaymentSupport(
  db: DatabaseClient | DbExecutor,
  input: ReconcilePaymentSupportInput,
): Promise<{ id: string; status: string }> {
  if (!input.reason || input.reason.trim().length === 0) {
    throw new Error('Un motif d’action support est obligatoire.');
  }

  const [payment] = await db
    .select({
      id: payments.id,
      organizationId: payments.organizationId,
      status: payments.status,
    })
    .from(payments)
    .where(eq(payments.id, input.paymentId))
    .limit(1);

  if (!payment) {
    throw new Error(`Paiement introuvable: ${input.paymentId}`);
  }

  // Marque les tentatives non-terminales pour réconciliation immédiate
  await db
    .update(paymentAttempts)
    .set({
      reconcileAfter: new Date(),
      reconcileLeaseUntil: null,
      reconcileLeaseToken: null,
    })
    .where(
      and(
        eq(paymentAttempts.paymentId, input.paymentId),
        inArray(paymentAttempts.status, [
          'PENDING_PROVIDER',
          'REQUIRES_PAYMENT_METHOD',
          'REQUIRES_ACTION',
          'PROCESSING',
        ]),
      ),
    );

  await writeAuditEntry(db, {
    actorUserId: input.actorUserId,
    action: 'SUPPORT_PAYMENT_RECONCILE_SCHEDULED',
    targetType: 'PAYMENT',
    targetId: payment.id,
    metadata: {
      organizationId: payment.organizationId,
      reason: input.reason.trim(),
      previousStatus: payment.status,
    },
  });

  return {
    id: payment.id,
    status: payment.status,
  };
}
