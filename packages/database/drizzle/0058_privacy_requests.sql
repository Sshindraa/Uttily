-- 0058_privacy_requests.sql
-- Lot 21-P1 — Fondation RGPD : registre des demandes de droits des personnes.
-- Conforme RGPD articles 12-23, decision-registry DPO-003 / DPO-004.

-- Enum: types de demandes RGPD
DO $$ BEGIN
  CREATE TYPE "privacy_request_type" AS ENUM (
    'ACCESS',
    'PORTABILITY',
    'RECTIFICATION',
    'ERASURE',
    'OPPOSITION',
    'RESTRICTION'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Enum: statuts du cycle de traitement opérationnel (workflow)
DO $$ BEGIN
  CREATE TYPE "privacy_request_status" AS ENUM (
    'RECEIVED',
    'IDENTITY_CHECK_REQUIRED',
    'IN_REVIEW',
    'DECISION_READY',
    'COMPLETED',
    'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Enum: statuts de résolution juridique de la demande
DO $$ BEGIN
  CREATE TYPE "privacy_resolution_status" AS ENUM (
    'FULFILLED',
    'PARTIALLY_FULFILLED',
    'REFUSED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Enum: motifs de refus (valeurs fermées)
DO $$ BEGIN
  CREATE TYPE "privacy_decision_reason" AS ENUM (
    'LEGAL_RETENTION_OBLIGATION',
    'LITIGATION_HOLD',
    'IDENTITY_NOT_VERIFIED',
    'THIRD_PARTY_RIGHTS',
    'MANIFESTLY_UNFOUNDED',
    'ALREADY_FULFILLED',
    'TECHNICALLY_IMPOSSIBLE'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "privacy_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "request_type" "privacy_request_type" NOT NULL,
  "status" "privacy_request_status" NOT NULL DEFAULT 'RECEIVED',
  "resolution" "privacy_resolution_status",
  "details" text,
  "decision_reason_code" "privacy_decision_reason",
  "resolution_notes" text,
  "decision_at" timestamp with time zone,
  "decision_by_user_id" uuid REFERENCES "users"("id"),
  "response_notified_at" timestamp with time zone,
  "response_notified_by_user_id" uuid REFERENCES "users"("id"),
  "received_at" timestamp with time zone NOT NULL DEFAULT now(),
  "response_due_at" timestamp with time zone NOT NULL,
  "extended_until" timestamp with time zone,
  "extension_reason" text,
  "extended_at" timestamp with time zone,
  "extended_by_user_id" uuid REFERENCES "users"("id"),
  "extension_notified_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Contraintes d'intégrité structurelle

-- 1. Invariant Décision interne vs Réponse notifiée vs Clôture
ALTER TABLE "privacy_requests"
  ADD CONSTRAINT "privacy_requests_decision_consistency"
    CHECK (
      (
        "status" IN ('RECEIVED', 'IDENTITY_CHECK_REQUIRED', 'IN_REVIEW')
        AND "resolution" IS NULL
        AND "decision_at" IS NULL
        AND "decision_by_user_id" IS NULL
        AND "response_notified_at" IS NULL
        AND "response_notified_by_user_id" IS NULL
        AND "resolved_at" IS NULL
      )
      OR
      (
        "status" = 'DECISION_READY'
        AND "resolution" IS NOT NULL
        AND "decision_at" IS NOT NULL
        AND "decision_by_user_id" IS NOT NULL
        AND "response_notified_at" IS NULL
        AND "response_notified_by_user_id" IS NULL
        AND "resolved_at" IS NULL
        AND ("resolution" != 'REFUSED' OR "decision_reason_code" IS NOT NULL)
      )
      OR
      (
        "status" = 'COMPLETED'
        AND "resolution" IS NOT NULL
        AND "decision_at" IS NOT NULL
        AND "decision_by_user_id" IS NOT NULL
        AND "response_notified_at" IS NOT NULL
        AND "response_notified_by_user_id" IS NOT NULL
        AND "resolved_at" IS NOT NULL
        AND "response_notified_at" >= "decision_at"
        AND ("resolution" != 'REFUSED' OR "decision_reason_code" IS NOT NULL)
      )
      OR
      (
        "status" = 'CANCELLED'
        AND "response_notified_at" IS NULL
      )
    );

-- 2. Invariant Prorogation de délai (+2 mois calendaires max Art. 12.3 RGPD)
ALTER TABLE "privacy_requests"
  ADD CONSTRAINT "privacy_requests_extension_consistency"
    CHECK (
      (
        "extended_until" IS NULL
        AND "extended_at" IS NULL
        AND "extension_reason" IS NULL
        AND "extended_by_user_id" IS NULL
        AND "extension_notified_at" IS NULL
      )
      OR
      (
        "extended_until" IS NOT NULL
        AND "extended_at" IS NOT NULL
        AND "extension_reason" IS NOT NULL
        AND "extended_by_user_id" IS NOT NULL
        AND "extended_until" > "response_due_at"
        AND "extended_until" <= ("response_due_at" + interval '2 months')
        AND ("extension_notified_at" IS NULL OR "extension_notified_at" >= "extended_at")
      )
    );

-- Index pour le suivi client (page /account/privacy)
CREATE INDEX IF NOT EXISTS "privacy_requests_user_status_idx"
  ON "privacy_requests" ("user_id", "status");

-- Trigger pour updated_at automatique
CREATE OR REPLACE FUNCTION privacy_requests_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "privacy_requests_updated_at_trigger" ON "privacy_requests";
CREATE TRIGGER "privacy_requests_updated_at_trigger"
  BEFORE UPDATE ON "privacy_requests"
  FOR EACH ROW
  EXECUTE FUNCTION privacy_requests_set_updated_at();
