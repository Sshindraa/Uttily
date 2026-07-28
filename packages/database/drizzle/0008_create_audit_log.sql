-- Migration 0008 : table audit_log.
-- Append-only : les actions de l'admin Uttily sont auditées (invariant §3).
-- Aucune UPDATE ni DELETE ne doit être appliquée à cette table.

CREATE TABLE "audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_user_id" uuid,
  "action" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" uuid,
  "metadata" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE set null;

CREATE INDEX "audit_log_actor_user_id_index" ON "audit_log" ("actor_user_id");
CREATE INDEX "audit_log_target_index" ON "audit_log" ("target_type", "target_id");
CREATE INDEX "audit_log_created_at_index" ON "audit_log" ("created_at");
