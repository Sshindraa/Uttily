-- Migration 0028 : Lot 6 G5B — Documents transactionnels (modèle de données).
-- Tables : document_render_snapshots, documents, outbox_effects, notification_deliveries.
-- ADR-013 : Schéma PostgreSQL des documents transactionnels et contrats fermés.

-- Enums
DO $$ BEGIN
  CREATE TYPE "document_type" AS ENUM('CONFIRMATION', 'CONTRACT', 'RECEIPT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "outbox_effect_type" AS ENUM('GENERATE_CONFIRMATION', 'GENERATE_CONTRACT', 'GENERATE_RECEIPT', 'SEND_EMAIL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "outbox_effect_status" AS ENUM('PENDING', 'COMPLETED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "notification_delivery_status" AS ENUM('PENDING', 'SENT', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "document_processing_failure_code" AS ENUM('PAYLOAD_MALFORMED', 'STORAGE_PUT_FAILED', 'STORAGE_CHECKSUM_MISMATCH', 'STORAGE_NOT_FOUND', 'RENDER_FAILED', 'EMAIL_SEND_FAILED', 'LEASE_LOST', 'UNKNOWN_ERROR');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Table document_render_snapshots
CREATE TABLE "document_render_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "outbox_event_id" uuid NOT NULL,
  "booking_id" uuid NOT NULL,
  "snapshot" jsonb NOT NULL,
  "template_version" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "document_render_snapshots"
  ADD CONSTRAINT "document_render_snapshots_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "document_render_snapshots"
  ADD CONSTRAINT "document_render_snapshots_outbox_event_id_outbox_events_id_fk"
  FOREIGN KEY ("outbox_event_id") REFERENCES "outbox_events"("id") ON DELETE restrict;

ALTER TABLE "document_render_snapshots"
  ADD CONSTRAINT "document_render_snapshots_booking_id_bookings_id_fk"
  FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE restrict;

ALTER TABLE "document_render_snapshots"
  ADD CONSTRAINT "document_render_snapshots_outbox_event_id_unique"
  UNIQUE ("outbox_event_id");

ALTER TABLE "document_render_snapshots"
  ADD CONSTRAINT "document_render_snapshots_template_version_nonempty"
  CHECK (length(btrim("template_version")) > 0);

ALTER TABLE "document_render_snapshots"
  ADD CONSTRAINT "document_render_snapshots_snapshot_is_object"
  CHECK (jsonb_typeof("snapshot") = 'object');

CREATE INDEX IF NOT EXISTS "document_render_snapshots_org_outbox_event_index"
  ON "document_render_snapshots" USING btree ("organization_id", "outbox_event_id");

-- Trigger de cohérence multi-tenant pour document_render_snapshots :
-- organization_id doit être identique à outbox_events.organization_id et
-- bookings.organization_id.
CREATE OR REPLACE FUNCTION before_check_document_render_snapshot_consistency()
RETURNS TRIGGER AS $$
DECLARE
  outbox_org_id uuid;
  booking_org_id uuid;
BEGIN
  SELECT organization_id INTO outbox_org_id FROM outbox_events WHERE id = NEW.outbox_event_id;
  IF outbox_org_id IS NULL OR outbox_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'document_render_snapshots: l''organisation de l''événement outbox ne correspond pas';
  END IF;
  SELECT organization_id INTO booking_org_id FROM bookings WHERE id = NEW.booking_id;
  IF booking_org_id IS NULL OR booking_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'document_render_snapshots: l''organisation de la réservation ne correspond pas';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_document_render_snapshot
  BEFORE INSERT OR UPDATE OF organization_id, outbox_event_id, booking_id ON "document_render_snapshots"
  FOR EACH ROW EXECUTE FUNCTION before_check_document_render_snapshot_consistency();

-- Trigger append-only : interdit UPDATE et DELETE
CREATE OR REPLACE FUNCTION prevent_document_render_snapshot_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'document_render_snapshots est append-only : UPDATE et DELETE sont interdits';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_update_document_render_snapshots
  BEFORE UPDATE ON "document_render_snapshots"
  FOR EACH ROW EXECUTE FUNCTION prevent_document_render_snapshot_modification();

CREATE TRIGGER no_delete_document_render_snapshots
  BEFORE DELETE ON "document_render_snapshots"
  FOR EACH ROW EXECUTE FUNCTION prevent_document_render_snapshot_modification();

-- Table documents
CREATE TABLE "documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "booking_id" uuid NOT NULL,
  "type" "document_type" NOT NULL,
  "version" integer NOT NULL,
  "storage_key" text NOT NULL,
  "content_type" text NOT NULL,
  "checksum_sha256" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "template_version" text NOT NULL,
  "generated_at" timestamptz NOT NULL,
  "source_outbox_event_id" uuid NOT NULL,
  "render_snapshot_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_booking_id_bookings_id_fk"
  FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE restrict;

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_source_outbox_event_id_outbox_events_id_fk"
  FOREIGN KEY ("source_outbox_event_id") REFERENCES "outbox_events"("id") ON DELETE restrict;

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_render_snapshot_id_document_render_snapshots_id_fk"
  FOREIGN KEY ("render_snapshot_id") REFERENCES "document_render_snapshots"("id") ON DELETE restrict;

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_booking_type_version_unique"
  UNIQUE ("booking_id", "type", "version");

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_storage_key_unique"
  UNIQUE ("storage_key");

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_size_bytes_nonneg"
  CHECK ("size_bytes" >= 0);

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_size_bytes_max_safe"
  CHECK ("size_bytes" <= 9007199254740991);

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_checksum_sha256_hex"
  CHECK ("checksum_sha256" ~ '^[0-9a-f]{64}$');

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_content_type_nonempty"
  CHECK (length(btrim("content_type")) > 0);

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_template_version_nonempty"
  CHECK (length(btrim("template_version")) > 0);

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_storage_key_nonempty"
  CHECK (length(btrim("storage_key")) > 0);

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_idempotency_key_nonempty"
  CHECK (length(btrim("idempotency_key")) > 0);

CREATE INDEX IF NOT EXISTS "documents_org_booking_index"
  ON "documents" USING btree ("organization_id", "booking_id");

CREATE INDEX IF NOT EXISTS "documents_source_outbox_event_index"
  ON "documents" USING btree ("source_outbox_event_id");

-- Trigger de cohérence multi-tenant pour documents :
-- bookings.organization_id, outbox_events.organization_id (source_outbox_event_id),
-- document_render_snapshots.organization_id (render_snapshot_id) doivent tous
-- être identiques à documents.organization_id. De plus, le render_snapshot doit
-- référencer le même outbox_event_id et le même booking_id.
CREATE OR REPLACE FUNCTION before_check_document_consistency()
RETURNS TRIGGER AS $$
DECLARE
  booking_org_id uuid;
  outbox_org_id uuid;
  snapshot_org_id uuid;
  snapshot_outbox_event_id uuid;
  snapshot_booking_id uuid;
BEGIN
  SELECT organization_id INTO booking_org_id FROM bookings WHERE id = NEW.booking_id;
  IF booking_org_id IS NULL OR booking_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'documents: l''organisation de la réservation ne correspond pas';
  END IF;
  SELECT organization_id INTO outbox_org_id FROM outbox_events WHERE id = NEW.source_outbox_event_id;
  IF outbox_org_id IS NULL OR outbox_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'documents: l''organisation de l''événement outbox source ne correspond pas';
  END IF;
  SELECT organization_id, outbox_event_id, booking_id
    INTO snapshot_org_id, snapshot_outbox_event_id, snapshot_booking_id
    FROM document_render_snapshots WHERE id = NEW.render_snapshot_id;
  IF snapshot_org_id IS NULL OR snapshot_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'documents: l''organisation du snapshot de rendu ne correspond pas';
  END IF;
  IF snapshot_outbox_event_id <> NEW.source_outbox_event_id THEN
    RAISE EXCEPTION 'documents: le snapshot de rendu ne référence pas le même événement outbox';
  END IF;
  IF snapshot_booking_id <> NEW.booking_id THEN
    RAISE EXCEPTION 'documents: le snapshot de rendu ne référence pas la même réservation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_document
  BEFORE INSERT OR UPDATE OF organization_id, booking_id, source_outbox_event_id, render_snapshot_id ON "documents"
  FOR EACH ROW EXECUTE FUNCTION before_check_document_consistency();

-- Trigger append-only : interdit UPDATE et DELETE
CREATE OR REPLACE FUNCTION prevent_document_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'documents est append-only : UPDATE et DELETE sont interdits';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_update_documents
  BEFORE UPDATE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION prevent_document_modification();

CREATE TRIGGER no_delete_documents
  BEFORE DELETE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION prevent_document_modification();

-- Table outbox_effects
CREATE TABLE "outbox_effects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "outbox_event_id" uuid NOT NULL,
  "effect_type" "outbox_effect_type" NOT NULL,
  "status" "outbox_effect_status" NOT NULL DEFAULT 'PENDING',
  "document_id" uuid,
  "storage_key" text,
  "idempotency_key" text NOT NULL UNIQUE,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "failure_code" "document_processing_failure_code",
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "outbox_effects"
  ADD CONSTRAINT "outbox_effects_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "outbox_effects"
  ADD CONSTRAINT "outbox_effects_outbox_event_id_outbox_events_id_fk"
  FOREIGN KEY ("outbox_event_id") REFERENCES "outbox_events"("id") ON DELETE restrict;

ALTER TABLE "outbox_effects"
  ADD CONSTRAINT "outbox_effects_document_id_documents_id_fk"
  FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE restrict;

ALTER TABLE "outbox_effects"
  ADD CONSTRAINT "outbox_effects_outbox_event_effect_unique"
  UNIQUE ("outbox_event_id", "effect_type");

ALTER TABLE "outbox_effects"
  ADD CONSTRAINT "outbox_effects_pending_invariants"
  CHECK ("status" <> 'PENDING' OR ("document_id" IS NULL AND "completed_at" IS NULL AND "failure_code" IS NULL));

ALTER TABLE "outbox_effects"
  ADD CONSTRAINT "outbox_effects_completed_invariants"
  CHECK ("status" <> 'COMPLETED' OR ("completed_at" IS NOT NULL AND "failure_code" IS NULL));

ALTER TABLE "outbox_effects"
  ADD CONSTRAINT "outbox_effects_failed_invariants"
  CHECK ("status" <> 'FAILED' OR ("completed_at" IS NOT NULL AND "failure_code" IS NOT NULL));

ALTER TABLE "outbox_effects"
  ADD CONSTRAINT "outbox_effects_send_email_invariants"
  CHECK ("effect_type" <> 'SEND_EMAIL' OR ("document_id" IS NULL AND "storage_key" IS NULL));

ALTER TABLE "outbox_effects"
  ADD CONSTRAINT "outbox_effects_generate_completed_invariants"
  CHECK ("effect_type" NOT IN ('GENERATE_CONFIRMATION', 'GENERATE_CONTRACT', 'GENERATE_RECEIPT') OR "status" <> 'COMPLETED' OR ("document_id" IS NOT NULL AND "storage_key" IS NOT NULL));

ALTER TABLE "outbox_effects"
  ADD CONSTRAINT "outbox_effects_attempt_count_nonneg"
  CHECK ("attempt_count" >= 0);

ALTER TABLE "outbox_effects"
  ADD CONSTRAINT "outbox_effects_idempotency_key_nonempty"
  CHECK (length(btrim("idempotency_key")) > 0);

ALTER TABLE "outbox_effects"
  ADD CONSTRAINT "outbox_effects_storage_key_nonempty"
  CHECK ("storage_key" IS NULL OR length(btrim("storage_key")) > 0);

-- Partial unique index sur storage_key WHERE storage_key IS NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS "outbox_effects_storage_key_unique_partial"
  ON "outbox_effects" USING btree ("storage_key")
  WHERE "outbox_effects"."storage_key" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "outbox_effects_org_outbox_event_index"
  ON "outbox_effects" USING btree ("organization_id", "outbox_event_id");

-- Trigger de cohérence multi-tenant pour outbox_effects :
-- outbox_events.organization_id doit être identique à outbox_effects.organization_id.
-- Si document_id non-null : documents.organization_id doit être identique ET
-- documents.source_outbox_event_id doit être identique à outbox_effects.outbox_event_id.
CREATE OR REPLACE FUNCTION before_check_outbox_effect_consistency()
RETURNS TRIGGER AS $$
DECLARE
  outbox_org_id uuid;
  doc_org_id uuid;
  doc_source_outbox_event_id uuid;
BEGIN
  SELECT organization_id INTO outbox_org_id FROM outbox_events WHERE id = NEW.outbox_event_id;
  IF outbox_org_id IS NULL OR outbox_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'outbox_effects: l''organisation de l''événement outbox ne correspond pas';
  END IF;
  IF NEW.document_id IS NOT NULL THEN
    SELECT organization_id, source_outbox_event_id INTO doc_org_id, doc_source_outbox_event_id
      FROM documents WHERE id = NEW.document_id;
    IF doc_org_id IS NULL OR doc_org_id <> NEW.organization_id THEN
      RAISE EXCEPTION 'outbox_effects: l''organisation du document ne correspond pas';
    END IF;
    IF doc_source_outbox_event_id <> NEW.outbox_event_id THEN
      RAISE EXCEPTION 'outbox_effects: le document ne référence pas le même événement outbox';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_outbox_effect
  BEFORE INSERT OR UPDATE OF organization_id, outbox_event_id, document_id ON "outbox_effects"
  FOR EACH ROW EXECUTE FUNCTION before_check_outbox_effect_consistency();

-- Trigger de mutation contrôlée pour outbox_effects :
-- Colonnes immuables : id, organization_id, outbox_event_id, effect_type,
-- idempotency_key, created_at.
-- Transitions autorisées : PENDING→PENDING, PENDING→COMPLETED, PENDING→FAILED.
-- États terminaux (COMPLETED, FAILED) sont immuables.
-- attempt_count ne peut jamais diminuer.
-- storage_key, une fois renseignée, ne peut jamais changer.
-- document_id ne peut être renseigné qu'au passage à COMPLETED.
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

-- Table notification_deliveries
CREATE TABLE "notification_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "outbox_event_id" uuid NOT NULL,
  "outbox_effect_id" uuid NOT NULL,
  "recipient_email" text NOT NULL,
  "template_key" text NOT NULL,
  "provider_idempotency_key" text NOT NULL UNIQUE,
  "status" "notification_delivery_status" NOT NULL DEFAULT 'PENDING',
  "provider_message_id" text,
  "failure_code" "document_processing_failure_code",
  "sent_at" timestamptz,
  "idempotency_key" text NOT NULL UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_outbox_event_id_outbox_events_id_fk"
  FOREIGN KEY ("outbox_event_id") REFERENCES "outbox_events"("id") ON DELETE restrict;

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_outbox_effect_id_outbox_effects_id_fk"
  FOREIGN KEY ("outbox_effect_id") REFERENCES "outbox_effects"("id") ON DELETE restrict;

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_outbox_effect_unique"
  UNIQUE ("outbox_effect_id");

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_pending_invariants"
  CHECK ("status" <> 'PENDING' OR ("provider_message_id" IS NULL AND "sent_at" IS NULL AND "failure_code" IS NULL));

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_sent_invariants"
  CHECK ("status" <> 'SENT' OR (length(btrim("provider_message_id")) > 0 AND "sent_at" IS NOT NULL AND "failure_code" IS NULL));

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_failed_invariants"
  CHECK ("status" <> 'FAILED' OR ("failure_code" IS NOT NULL AND "sent_at" IS NULL));

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_recipient_email_nonempty"
  CHECK (length(btrim("recipient_email")) > 0);

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_template_key_nonempty"
  CHECK (length(btrim("template_key")) > 0);

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_provider_idempotency_key_nonempty"
  CHECK (length(btrim("provider_idempotency_key")) > 0);

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_idempotency_key_nonempty"
  CHECK (length(btrim("idempotency_key")) > 0);

CREATE INDEX IF NOT EXISTS "notification_deliveries_org_outbox_event_index"
  ON "notification_deliveries" USING btree ("organization_id", "outbox_event_id");

-- Trigger de cohérence multi-tenant pour notification_deliveries :
-- outbox_events.organization_id et outbox_effects.organization_id doivent être
-- identiques à notification_deliveries.organization_id.
-- outbox_effects.outbox_event_id doit être identique à notification_deliveries.outbox_event_id.
-- outbox_effects.effect_type doit être 'SEND_EMAIL'.
CREATE OR REPLACE FUNCTION before_check_notification_delivery_consistency()
RETURNS TRIGGER AS $$
DECLARE
  outbox_org_id uuid;
  effect_org_id uuid;
  effect_outbox_event_id uuid;
  effect_type_val text;
BEGIN
  SELECT organization_id INTO outbox_org_id FROM outbox_events WHERE id = NEW.outbox_event_id;
  IF outbox_org_id IS NULL OR outbox_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'notification_deliveries: l''organisation de l''événement outbox ne correspond pas';
  END IF;
  SELECT organization_id, outbox_event_id, effect_type
    INTO effect_org_id, effect_outbox_event_id, effect_type_val
    FROM outbox_effects WHERE id = NEW.outbox_effect_id;
  IF effect_org_id IS NULL OR effect_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'notification_deliveries: l''organisation de l''effet outbox ne correspond pas';
  END IF;
  IF effect_outbox_event_id <> NEW.outbox_event_id THEN
    RAISE EXCEPTION 'notification_deliveries: l''effet outbox ne référence pas le même événement outbox';
  END IF;
  IF effect_type_val <> 'SEND_EMAIL' THEN
    RAISE EXCEPTION 'notification_deliveries: l''effet outbox doit être de type SEND_EMAIL';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_notification_delivery
  BEFORE INSERT OR UPDATE OF organization_id, outbox_event_id, outbox_effect_id ON "notification_deliveries"
  FOR EACH ROW EXECUTE FUNCTION before_check_notification_delivery_consistency();

-- Trigger de transition pour notification_deliveries :
-- Colonnes immuables : id, organization_id, outbox_event_id, outbox_effect_id,
-- recipient_email, template_key, provider_idempotency_key, idempotency_key, created_at.
-- Transitions autorisées : PENDING→PENDING, PENDING→SENT, PENDING→FAILED.
-- États terminaux (SENT, FAILED) sont immuables.
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

  -- États terminaux : immuables
  IF OLD.status = 'SENT' OR OLD.status = 'FAILED' THEN
    IF NEW.status <> OLD.status
       OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
       OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
       OR NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
      RAISE EXCEPTION 'notification_deliveries: état terminal immuable, aucune modification autorisée';
    END IF;
    RETURN NEW;
  END IF;

  -- OLD.status = 'PENDING'
  IF NEW.status NOT IN ('PENDING', 'SENT', 'FAILED') THEN
    RAISE EXCEPTION 'notification_deliveries: statut cible invalide';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_notification_delivery_transition
  BEFORE UPDATE ON "notification_deliveries"
  FOR EACH ROW EXECUTE FUNCTION before_check_notification_delivery_transition();
