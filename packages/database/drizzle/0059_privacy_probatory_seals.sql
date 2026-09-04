-- 0059_privacy_probatory_seals.sql
-- Lot 21-P2 — RGPD Droit à l'effacement : registre des scellements probatoires.
-- Conforme RGPD article 17, DPO-003, DPO-004, Code civil Art. 2224, Code de commerce Art. L. 123-22, ADR-039.

CREATE TABLE IF NOT EXISTS "privacy_probatory_seals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "sealed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "civil_retention_until" timestamp with time zone NOT NULL,
  "accounting_retention_until" timestamp with time zone NOT NULL,
  "sealed_bookings_count" integer NOT NULL DEFAULT 0,
  "sealed_payments_count" integer NOT NULL DEFAULT 0,
  "sealed_documents_count" integer NOT NULL DEFAULT 0,
  "trigger_source" text NOT NULL,
  "privacy_request_id" uuid REFERENCES "privacy_requests"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Contraintes d'intégrité structurelle

-- 1. Unicité du scellement par utilisateur (un seul scellé probatoire d'effacement par user_id)
CREATE UNIQUE INDEX IF NOT EXISTS "privacy_probatory_seals_user_id_idx"
  ON "privacy_probatory_seals" ("user_id");

-- 2. Cohérence des dates d'échéance légale
-- La prescription civile (+5 ans) et la rétention comptable (+10 ans) doivent être strictement postérieures à la date de scellement
ALTER TABLE "privacy_probatory_seals"
  ADD CONSTRAINT "privacy_probatory_seals_dates_consistency"
    CHECK (
      "civil_retention_until" > "sealed_at"
      AND "accounting_retention_until" >= "civil_retention_until"
    );

-- 3. Source du déclenchement non vide
ALTER TABLE "privacy_probatory_seals"
  ADD CONSTRAINT "privacy_probatory_seals_trigger_source_not_empty"
    CHECK (length(btrim("trigger_source")) > 0);
