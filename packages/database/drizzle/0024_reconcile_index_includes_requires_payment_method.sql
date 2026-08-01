-- Inclure REQUIRES_PAYMENT_METHOD dans l'index de réconciliation.
-- L'index actuel exclut ce statut, alors qu'il doit être réconcilié
-- après l'échéance (ADR-010 §12).
DROP INDEX IF EXISTS "payment_attempts_reconcile_index";
CREATE INDEX "payment_attempts_reconcile_index"
  ON "payment_attempts" ("status", "reconcile_after", "reconcile_lease_until")
  WHERE "status" IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING');
