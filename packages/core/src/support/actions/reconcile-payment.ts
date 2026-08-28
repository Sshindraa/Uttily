import { eq, and, inArray, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { auditLog, paymentAttempts, payments } from '@uttily/database';

export interface ReconcilePaymentSupportInput {
  readonly paymentId: string;
  readonly actorUserId: string;
  readonly reason: string;
}

export class PaymentReconcileActionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PaymentReconcileActionError';
    this.code = code;
  }
}

const ELIGIBLE_RECONCILE_STATUSES: Array<
  'PENDING_PROVIDER' | 'REQUIRES_PAYMENT_METHOD' | 'REQUIRES_ACTION' | 'PROCESSING'
> = ['PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING'];

/**
 * Use case Support : Force la réconciliation d'un paiement en rendant ses tentatives éligibles
 * (Chantier 16.1, fencing durci en 16.1.1).
 *
 * Invariants :
 * 1. Transaction PostgreSQL atomique : lecture -> lock -> update -> audit.
 * 2. Si l'audit échoue, rollback complet : aucune trace mensongère, état initial intact.
 * 3. Utilise returning() pour connaître le nombre réel de tentatives reprogrammées.
 * 4. Si updatedCount === 0 : refuse avec SUPPORT_ACTION_INVALID_STATE et aucun faux audit n'est créé.
 * 5. Ne modifie aucun état financier authoritative.
 * 6. Lease fencing (16.1.1) : seules les tentatives non-terminales sans lease actif
 *    (`reconcile_lease_until IS NULL OR reconcile_lease_until <= transaction_timestamp()`)
 *    sont sélectionnées. Une tentative sous lease actif (worker de réconciliation en vol)
 *    n'est JAMAIS sélectionnée ni modifiée : ni `reconcile_lease_token`, ni
 *    `reconcile_lease_until`, ni `reconcile_after`. Si aucune autre tentative n'est
 *    éligible, l'action est refusée avec SUPPORT_ACTION_INVALID_STATE et sans audit.
 *    L'éligibilité est décidée par l'horloge PostgreSQL (`transaction_timestamp()`),
 *    jamais par l'horloge JS. `FOR UPDATE` est conservé.
 */
export async function reconcilePaymentSupport(
  db: DatabaseClient,
  input: ReconcilePaymentSupportInput,
): Promise<{ id: string; status: string; reconciledCount: number }> {
  if (!input.reason || input.reason.trim().length === 0) {
    throw new PaymentReconcileActionError(
      'SUPPORT_ACTION_INVALID_STATE',
      'Un motif explicite est obligatoire pour demander la réconciliation d’un paiement.',
    );
  }

  return db.transaction(async (tx) => {
    // 1. Lecture / Validation du paiement
    const [payment] = await tx
      .select({
        id: payments.id,
        organizationId: payments.organizationId,
        status: payments.status,
      })
      .from(payments)
      .where(eq(payments.id, input.paymentId))
      .limit(1);

    if (!payment) {
      throw new PaymentReconcileActionError(
        'NOT_FOUND',
        `Paiement introuvable: ${input.paymentId}`,
      );
    }

    // 2. Sélection / Lock FOR UPDATE des tentatives non-terminales ÉLIGIBLES uniquement.
    //    Le filtre de lease est évalué par PostgreSQL (transaction_timestamp()) : toute
    //    tentative sous lease actif reste hors de portée de cette action (fencing).
    const eligibleAttempts = await tx
      .select({ id: paymentAttempts.id })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.paymentId, input.paymentId),
          inArray(paymentAttempts.status, ELIGIBLE_RECONCILE_STATUSES),
          sql`(${paymentAttempts.reconcileLeaseUntil} IS NULL OR ${paymentAttempts.reconcileLeaseUntil} <= transaction_timestamp())`,
        ),
      )
      .for('update');

    if (eligibleAttempts.length === 0) {
      // Diagnostic truthful (aucune écriture) : lease en vol vs aucune tentative.
      const [nonTerminalAttempt] = await tx
        .select({ id: paymentAttempts.id })
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.paymentId, input.paymentId),
            inArray(paymentAttempts.status, ELIGIBLE_RECONCILE_STATUSES),
          ),
        )
        .limit(1);

      throw new PaymentReconcileActionError(
        'SUPPORT_ACTION_INVALID_STATE',
        nonTerminalAttempt
          ? 'Réconciliation refusée : la tentative non-terminale est sous lease de réconciliation actif (worker en vol). Aucun lease, token ou reconcile_after n’a été modifié.'
          : 'Aucune tentative de paiement non-terminale éligible à la réconciliation pour ce paiement.',
      );
    }

    const attemptIds = eligibleAttempts.map((a) => a.id);

    // 3. Mise à jour atomique avec returning(), horloge PostgreSQL
    const updatedAttempts = await tx
      .update(paymentAttempts)
      .set({
        reconcileAfter: sql`transaction_timestamp()`,
        reconcileLeaseUntil: null,
        reconcileLeaseToken: null,
        updatedAt: sql`transaction_timestamp()`,
      })
      .where(inArray(paymentAttempts.id, attemptIds))
      .returning({ id: paymentAttempts.id });

    if (updatedAttempts.length === 0) {
      throw new PaymentReconcileActionError(
        'SUPPORT_ACTION_INVALID_STATE',
        'Aucune tentative mise à jour pour la réconciliation.',
      );
    }

    // 4. Audit dans la même transaction
    await tx.insert(auditLog).values({
      actorUserId: input.actorUserId,
      action: 'SUPPORT_PAYMENT_RECONCILE_SCHEDULED',
      targetType: 'PAYMENT',
      targetId: payment.id,
      metadata: {
        organizationId: payment.organizationId,
        reason: input.reason.trim(),
        previousStatus: payment.status,
        reconciledAttemptIds: updatedAttempts.map((a) => a.id),
        reconciledCount: updatedAttempts.length,
      },
    });

    return {
      id: payment.id,
      status: payment.status,
      reconciledCount: updatedAttempts.length,
    };
  });
}
