-- Migration 0029 : Lot 6 G5H-C2A — Fondation PostgreSQL de la politique email fail-closed.
-- ADR-013 §13 : remplacement transactionnel des enums + colonne provider_first_attempt_started_at
-- + CHECK constraints REQUIRES_MANUAL_REVIEW + triggers de transition et d'immutabilité + index partiels.
-- Stratégie : remplacement transactionnel des enums (PAS de ALTER TYPE ADD VALUE) car le runner
-- Drizzle 0.36.4 exécute toutes les migrations en attente dans une transaction commune.

-- -------------------------------------------------------------------------
-- Étape 1 — Supprimer les objets dépendants de notification_delivery_status
-- -------------------------------------------------------------------------
DROP TRIGGER IF EXISTS before_check_notification_delivery_transition ON "notification_deliveries";
DROP FUNCTION IF EXISTS before_check_notification_delivery_transition();
ALTER TABLE "notification_deliveries" DROP CONSTRAINT IF EXISTS "notification_deliveries_pending_invariants";
ALTER TABLE "notification_deliveries" DROP CONSTRAINT IF EXISTS "notification_deliveries_sent_invariants";
ALTER TABLE "notification_deliveries" DROP CONSTRAINT IF EXISTS "notification_deliveries_failed_invariants";

-- -------------------------------------------------------------------------
-- Étape 2 — Supprimer les CHECK constraints dépendantes de document_processing_failure_code
-- -------------------------------------------------------------------------
ALTER TABLE "outbox_effects" DROP CONSTRAINT IF EXISTS "outbox_effects_pending_invariants";
ALTER TABLE "outbox_effects" DROP CONSTRAINT IF EXISTS "outbox_effects_completed_invariants";
ALTER TABLE "outbox_effects" DROP CONSTRAINT IF EXISTS "outbox_effects_failed_invariants";

-- -------------------------------------------------------------------------
-- Étape 3 — Supprimer le trigger de transition outbox_effects
-- -------------------------------------------------------------------------
DROP TRIGGER IF EXISTS before_check_outbox_effect_transition ON "outbox_effects";
DROP FUNCTION IF EXISTS before_check_outbox_effect_transition();

-- -------------------------------------------------------------------------
-- Étape 4 — Remplacement transactionnel de notification_delivery_status
-- -------------------------------------------------------------------------
ALTER TYPE "notification_delivery_status" RENAME TO "notification_delivery_status_old";
CREATE TYPE "notification_delivery_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'REQUIRES_MANUAL_REVIEW');
ALTER TABLE "notification_deliveries" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "notification_deliveries" ALTER COLUMN "status" TYPE "notification_delivery_status" USING "status"::text::"notification_delivery_status";
ALTER TABLE "notification_deliveries" ALTER COLUMN "status" SET DEFAULT 'PENDING';
DROP TYPE "notification_delivery_status_old";

-- -------------------------------------------------------------------------
-- Étape 5 — Remplacement transactionnel de document_processing_failure_code
-- -------------------------------------------------------------------------
ALTER TYPE "document_processing_failure_code" RENAME TO "document_processing_failure_code_old";
CREATE TYPE "document_processing_failure_code" AS ENUM('PAYLOAD_MALFORMED', 'STORAGE_PUT_FAILED', 'STORAGE_CHECKSUM_MISMATCH', 'STORAGE_NOT_FOUND', 'RENDER_FAILED', 'EMAIL_SEND_FAILED', 'LEASE_LOST', 'UNKNOWN_ERROR', 'PROVIDER_RESULT_UNCERTAIN', 'EMAIL_RETRY_WINDOW_EXPIRED');
ALTER TABLE "outbox_effects" ALTER COLUMN "failure_code" TYPE "document_processing_failure_code" USING "failure_code"::text::"document_processing_failure_code";
ALTER TABLE "notification_deliveries" ALTER COLUMN "failure_code" TYPE "document_processing_failure_code" USING "failure_code"::text::"document_processing_failure_code";
DROP TYPE "document_processing_failure_code_old";

-- -------------------------------------------------------------------------
-- Étape 6 — Ajouter la colonne provider_first_attempt_started_at
-- -------------------------------------------------------------------------
ALTER TABLE "notification_deliveries" ADD COLUMN "provider_first_attempt_started_at" timestamptz;

-- -------------------------------------------------------------------------
-- Étape 7 — Recréer les CHECK constraints (avec REQUIRES_MANUAL_REVIEW)
-- -------------------------------------------------------------------------
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_pending_invariants"
  CHECK ("status" <> 'PENDING' OR ("provider_message_id" IS NULL AND "sent_at" IS NULL AND "failure_code" IS NULL));

ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_sent_invariants"
  CHECK ("status" <> 'SENT' OR (length(btrim("provider_message_id")) > 0 AND "sent_at" IS NOT NULL AND "failure_code" IS NULL));

ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_failed_invariants"
  CHECK ("status" <> 'FAILED' OR ("failure_code" IS NOT NULL AND "sent_at" IS NULL));

ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_requires_manual_review_invariants"
  CHECK ("status" <> 'REQUIRES_MANUAL_REVIEW' OR ("provider_message_id" IS NULL AND "sent_at" IS NULL AND "failure_code" IS NOT NULL AND "failure_code" IN ('PROVIDER_RESULT_UNCERTAIN', 'EMAIL_RETRY_WINDOW_EXPIRED')));

ALTER TABLE "outbox_effects" ADD CONSTRAINT "outbox_effects_pending_invariants"
  CHECK ("status" <> 'PENDING' OR ("document_id" IS NULL AND "completed_at" IS NULL AND "failure_code" IS NULL));

ALTER TABLE "outbox_effects" ADD CONSTRAINT "outbox_effects_completed_invariants"
  CHECK ("status" <> 'COMPLETED' OR ("completed_at" IS NOT NULL AND "failure_code" IS NULL));

ALTER TABLE "outbox_effects" ADD CONSTRAINT "outbox_effects_failed_invariants"
  CHECK ("status" <> 'FAILED' OR ("completed_at" IS NOT NULL AND "failure_code" IS NOT NULL));

-- -------------------------------------------------------------------------
-- Étape 8 — Recréer la fonction et le trigger de transition outbox_effects
-- (identique à 0028:367-422)
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION before_check_outbox_effect_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- Colonnes immuables
  IF NEW.id <> OLD.id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.outbox_event_id <> OLD.outbox_event_id
     OR NEW.effect_type <> OLD.effect_type
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'outbox_effects: colonnes immuables modifiées';
  END IF;

  -- États terminaux : immuables
  IF OLD.status = 'COMPLETED' OR OLD.status = 'FAILED' THEN
    IF NEW.status <> OLD.status
       OR NEW.document_id IS DISTINCT FROM OLD.document_id
       OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
      RAISE EXCEPTION 'outbox_effects: état terminal immuable, aucune modification autorisée';
    END IF;
    RETURN NEW;
  END IF;

  -- OLD.status = 'PENDING'
  -- Aucune transition vers COMPLETED ou FAILED depuis un état non-PENDING
  -- (déjà couvert par le bloc terminal ci-dessus).
  -- Transitions autorisées : PENDING→PENDING, PENDING→COMPLETED, PENDING→FAILED.
  IF NEW.status NOT IN ('PENDING', 'COMPLETED', 'FAILED') THEN
    RAISE EXCEPTION 'outbox_effects: statut cible invalide';
  END IF;

  -- attempt_count ne peut jamais diminuer
  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'outbox_effects: attempt_count ne peut pas diminuer';
  END IF;

  -- storage_key, une fois renseignée, ne peut jamais changer
  IF OLD.storage_key IS NOT NULL AND (NEW.storage_key IS NULL OR NEW.storage_key <> OLD.storage_key) THEN
    RAISE EXCEPTION 'outbox_effects: storage_key ne peut pas changer une fois renseignée';
  END IF;

  -- document_id ne peut être renseigné qu'au passage à COMPLETED
  IF NEW.document_id IS NOT NULL AND NEW.status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'outbox_effects: document_id ne peut être renseigné qu''au passage à COMPLETED';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_outbox_effect_transition
  BEFORE UPDATE ON "outbox_effects"
  FOR EACH ROW EXECUTE FUNCTION before_check_outbox_effect_transition();

-- -------------------------------------------------------------------------
-- Étape 9 — Recréer la fonction et le trigger de transition notification_deliveries (MIS À JOUR)
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION before_check_notification_delivery_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- Colonnes immuables
  IF NEW.id <> OLD.id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.outbox_event_id <> OLD.outbox_event_id
     OR NEW.outbox_effect_id <> OLD.outbox_effect_id
     OR NEW.recipient_email <> OLD.recipient_email
     OR NEW.template_key <> OLD.template_key
     OR NEW.provider_idempotency_key <> OLD.provider_idempotency_key
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'notification_deliveries: colonnes immuables modifiées';
  END IF;

  -- États terminaux SENT et FAILED : immuables
  IF OLD.status = 'SENT' OR OLD.status = 'FAILED' THEN
    IF NEW.status <> OLD.status
       OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
       OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
       OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
       OR NEW.provider_first_attempt_started_at IS DISTINCT FROM OLD.provider_first_attempt_started_at THEN
      RAISE EXCEPTION 'notification_deliveries: état terminal immuable, aucune modification autorisée';
    END IF;
    RETURN NEW;
  END IF;

  -- REQUIRES_MANUAL_REVIEW : immuable par le worker (résolution humaine uniquement via futur use case)
  IF OLD.status = 'REQUIRES_MANUAL_REVIEW' THEN
    IF NEW.status NOT IN ('SENT', 'FAILED') THEN
      RAISE EXCEPTION 'notification_deliveries: REQUIRES_MANUAL_REVIEW ne peut évoluer que vers SENT ou FAILED (résolution humaine)';
    END IF;
    RETURN NEW;
  END IF;

  -- OLD.status = 'PENDING'
  IF NEW.status NOT IN ('PENDING', 'SENT', 'FAILED', 'REQUIRES_MANUAL_REVIEW') THEN
    RAISE EXCEPTION 'notification_deliveries: statut cible invalide';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_notification_delivery_transition
  BEFORE UPDATE ON "notification_deliveries"
  FOR EACH ROW EXECUTE FUNCTION before_check_notification_delivery_transition();

-- -------------------------------------------------------------------------
-- Étape 10 — Trigger d'immutabilité du timestamp fournisseur
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION before_check_notification_delivery_provider_timestamp_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.provider_first_attempt_started_at IS NOT NULL
     AND NEW.provider_first_attempt_started_at IS DISTINCT FROM OLD.provider_first_attempt_started_at THEN
    RAISE EXCEPTION 'notification_deliveries: provider_first_attempt_started_at est immuable une fois renseignée';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_notification_delivery_provider_timestamp
  BEFORE UPDATE ON "notification_deliveries"
  FOR EACH ROW EXECUTE FUNCTION before_check_notification_delivery_provider_timestamp_immutability();

-- -------------------------------------------------------------------------
-- Étape 11 — Index partiels ADR-013
-- -------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "notification_deliveries_requires_manual_review_index"
  ON "notification_deliveries" USING btree ("status")
  WHERE "notification_deliveries"."status" = 'REQUIRES_MANUAL_REVIEW';

CREATE INDEX IF NOT EXISTS "notification_deliveries_provider_first_attempt_index"
  ON "notification_deliveries" USING btree ("provider_first_attempt_started_at")
  WHERE "notification_deliveries"."provider_first_attempt_started_at" IS NOT NULL;
