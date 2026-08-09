-- Migration 0030 : G5J-B — Renforcement de l'invariant append-only de audit_log.
-- ADR-016 (Accepted) : Option A — FK ON DELETE RESTRICT + trigger bloquant UPDATE/DELETE.
-- PostgreSQL ne permet pas de modifier l'action référentielle d'une FK existante
-- avec un simple ALTER de la contrainte : la FK est supprimée puis recréée.
-- Le runner Drizzle 0.36.4 enveloppe les migrations dans une transaction commune,
-- garantissant l'atomicité du DROP + ADD CONSTRAINT + CREATE FUNCTION + CREATE TRIGGER.
-- Aucune donnée n'est modifiée. Aucun TRUNCATE trigger n'est créé (TRUNCATE reste
-- une opération privilégiée hors contrat applicatif, cf. ADR-016 §2.1).

ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actor_user_id_users_id_fk";

ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE restrict;

-- Trigger : append-only (UPDATE et DELETE interdits).
CREATE OR REPLACE FUNCTION "prevent_audit_log_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log est append-only : UPDATE et DELETE interdits.';
END;
$$;

CREATE TRIGGER "prevent_update_delete_audit_log"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW
  EXECUTE FUNCTION "prevent_audit_log_mutation"();
