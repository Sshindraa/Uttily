-- Migration 0027 : Lot 6 — Fulfillment opérationnel (modèle de données).
-- Tables : booking_fulfillment_events, condition_reports, damage_reports.
-- ADR-012 : Accepté (périmètre Lot 6 groupe G2, modèle de données fulfillment).

-- Enums
DO $$ BEGIN
  CREATE TYPE "fulfillment_event_type" AS ENUM('PREPARED', 'PICKED_UP', 'RETURNED', 'CLOSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "condition_report_phase" AS ENUM('PICKUP', 'RETURN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Table booking_fulfillment_events
CREATE TABLE "booking_fulfillment_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "booking_id" uuid NOT NULL,
  "event_type" "fulfillment_event_type" NOT NULL,
  "previous_status" "booking_status" NOT NULL,
  "next_status" "booking_status" NOT NULL,
  "actor_user_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "booking_fulfillment_events"
  ADD CONSTRAINT "booking_fulfillment_events_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "booking_fulfillment_events"
  ADD CONSTRAINT "booking_fulfillment_events_booking_id_bookings_id_fk"
  FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE restrict;

ALTER TABLE "booking_fulfillment_events"
  ADD CONSTRAINT "booking_fulfillment_events_actor_user_id_users_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE restrict;

ALTER TABLE "booking_fulfillment_events"
  ADD CONSTRAINT "booking_fulfillment_events_org_idempotency_key_unique"
  UNIQUE ("organization_id", "idempotency_key");

ALTER TABLE "booking_fulfillment_events"
  ADD CONSTRAINT "booking_fulfillment_events_status_change"
  CHECK ("previous_status" <> "next_status");

ALTER TABLE "booking_fulfillment_events"
  ADD CONSTRAINT "booking_fulfillment_events_prepared"
  CHECK (("event_type" = 'PREPARED' AND "previous_status" = 'CONFIRMED' AND "next_status" = 'READY_FOR_PICKUP') OR "event_type" <> 'PREPARED');

ALTER TABLE "booking_fulfillment_events"
  ADD CONSTRAINT "booking_fulfillment_events_picked_up"
  CHECK (("event_type" = 'PICKED_UP' AND "previous_status" = 'READY_FOR_PICKUP' AND "next_status" = 'ACTIVE') OR "event_type" <> 'PICKED_UP');

ALTER TABLE "booking_fulfillment_events"
  ADD CONSTRAINT "booking_fulfillment_events_returned"
  CHECK (("event_type" = 'RETURNED' AND "previous_status" = 'ACTIVE' AND "next_status" = 'RETURNED') OR "event_type" <> 'RETURNED');

ALTER TABLE "booking_fulfillment_events"
  ADD CONSTRAINT "booking_fulfillment_events_closed"
  CHECK (("event_type" = 'CLOSED' AND "previous_status" = 'RETURNED' AND "next_status" = 'CLOSED') OR "event_type" <> 'CLOSED');

ALTER TABLE "booking_fulfillment_events"
  ADD CONSTRAINT "booking_fulfillment_events_idempotency_key_nonempty"
  CHECK (length(btrim("idempotency_key")) > 0);

-- Trigger de cohérence multi-tenant : le booking doit appartenir à la même
-- organisation que l'événement fulfillment.
CREATE OR REPLACE FUNCTION before_check_fulfillment_event_consistency()
RETURNS TRIGGER AS $$
DECLARE
  booking_org_id uuid;
BEGIN
  SELECT organization_id INTO booking_org_id FROM bookings WHERE id = NEW.booking_id;
  IF booking_org_id IS NULL OR booking_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'La réservation n''appartient pas à la même organisation que l''événement fulfillment';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_fulfillment_event
  BEFORE INSERT OR UPDATE OF booking_id, organization_id ON "booking_fulfillment_events"
  FOR EACH ROW EXECUTE FUNCTION before_check_fulfillment_event_consistency();

-- Trigger append-only : interdit UPDATE et DELETE
CREATE OR REPLACE FUNCTION prevent_fulfillment_event_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'booking_fulfillment_events est append-only : UPDATE et DELETE sont interdits';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_update_fulfillment_events
  BEFORE UPDATE ON "booking_fulfillment_events"
  FOR EACH ROW EXECUTE FUNCTION prevent_fulfillment_event_modification();

CREATE TRIGGER no_delete_fulfillment_events
  BEFORE DELETE ON "booking_fulfillment_events"
  FOR EACH ROW EXECUTE FUNCTION prevent_fulfillment_event_modification();

-- Table condition_reports
CREATE TABLE "condition_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "booking_id" uuid NOT NULL,
  "booking_item_id" uuid NOT NULL,
  "inventory_item_id" uuid NOT NULL,
  "phase" "condition_report_phase" NOT NULL,
  "condition" "inventory_condition" NOT NULL,
  "notes" text,
  "reporter_user_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "condition_reports"
  ADD CONSTRAINT "condition_reports_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "condition_reports"
  ADD CONSTRAINT "condition_reports_booking_id_bookings_id_fk"
  FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE restrict;

ALTER TABLE "condition_reports"
  ADD CONSTRAINT "condition_reports_booking_item_id_booking_items_id_fk"
  FOREIGN KEY ("booking_item_id") REFERENCES "booking_items"("id") ON DELETE restrict;

ALTER TABLE "condition_reports"
  ADD CONSTRAINT "condition_reports_inventory_item_id_inventory_items_id_fk"
  FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE restrict;

ALTER TABLE "condition_reports"
  ADD CONSTRAINT "condition_reports_reporter_user_id_users_id_fk"
  FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE restrict;

ALTER TABLE "condition_reports"
  ADD CONSTRAINT "condition_reports_org_idempotency_key_unique"
  UNIQUE ("organization_id", "idempotency_key");

ALTER TABLE "condition_reports"
  ADD CONSTRAINT "condition_reports_idempotency_key_nonempty"
  CHECK (length(btrim("idempotency_key")) > 0);

-- Trigger de cohérence multi-tenant : le booking_item doit appartenir au booking,
-- référencer le même inventory_item, et toutes les entités doivent être de la
-- même organisation.
CREATE OR REPLACE FUNCTION before_check_condition_report_consistency()
RETURNS TRIGGER AS $$
DECLARE
  booking_org_id uuid;
  booking_item_booking_id uuid;
  booking_item_inventory_id uuid;
  inv_org_id uuid;
BEGIN
  -- 1. Le booking doit appartenir à la même organisation
  SELECT organization_id INTO booking_org_id FROM bookings WHERE id = NEW.booking_id;
  IF booking_org_id IS NULL OR booking_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'La réservation n''appartient pas à la même organisation que le rapport d''état';
  END IF;
  -- 2. Le booking_item doit appartenir au booking et référencer le bon inventory_item
  SELECT booking_id, inventory_item_id INTO booking_item_booking_id, booking_item_inventory_id
    FROM booking_items WHERE id = NEW.booking_item_id;
  IF booking_item_booking_id IS NULL OR booking_item_booking_id <> NEW.booking_id THEN
    RAISE EXCEPTION 'L''élément de réservation n''appartient pas à la réservation indiquée';
  END IF;
  IF booking_item_inventory_id <> NEW.inventory_item_id THEN
    RAISE EXCEPTION 'L''exemplaire du rapport ne correspond pas à l''élément de réservation';
  END IF;
  -- 3. L'exemplaire doit appartenir à la même organisation
  SELECT organization_id INTO inv_org_id FROM inventory_items WHERE id = NEW.inventory_item_id;
  IF inv_org_id IS NULL OR inv_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'L''exemplaire n''appartient pas à la même organisation que le rapport d''état';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_condition_report
  BEFORE INSERT OR UPDATE OF booking_id, booking_item_id, inventory_item_id, organization_id ON "condition_reports"
  FOR EACH ROW EXECUTE FUNCTION before_check_condition_report_consistency();

-- Trigger append-only : interdit UPDATE et DELETE
CREATE OR REPLACE FUNCTION prevent_condition_report_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'condition_reports est append-only : UPDATE et DELETE sont interdits';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_update_condition_reports
  BEFORE UPDATE ON "condition_reports"
  FOR EACH ROW EXECUTE FUNCTION prevent_condition_report_modification();

CREATE TRIGGER no_delete_condition_reports
  BEFORE DELETE ON "condition_reports"
  FOR EACH ROW EXECUTE FUNCTION prevent_condition_report_modification();

-- Table damage_reports
CREATE TABLE "damage_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "booking_id" uuid NOT NULL,
  "booking_item_id" uuid NOT NULL,
  "inventory_item_id" uuid NOT NULL,
  "description" text NOT NULL,
  "reporter_user_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "damage_reports"
  ADD CONSTRAINT "damage_reports_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "damage_reports"
  ADD CONSTRAINT "damage_reports_booking_id_bookings_id_fk"
  FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE restrict;

ALTER TABLE "damage_reports"
  ADD CONSTRAINT "damage_reports_booking_item_id_booking_items_id_fk"
  FOREIGN KEY ("booking_item_id") REFERENCES "booking_items"("id") ON DELETE restrict;

ALTER TABLE "damage_reports"
  ADD CONSTRAINT "damage_reports_inventory_item_id_inventory_items_id_fk"
  FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE restrict;

ALTER TABLE "damage_reports"
  ADD CONSTRAINT "damage_reports_reporter_user_id_users_id_fk"
  FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE restrict;

ALTER TABLE "damage_reports"
  ADD CONSTRAINT "damage_reports_org_idempotency_key_unique"
  UNIQUE ("organization_id", "idempotency_key");

ALTER TABLE "damage_reports"
  ADD CONSTRAINT "damage_reports_description_nonempty"
  CHECK (length(btrim("description")) > 0);

ALTER TABLE "damage_reports"
  ADD CONSTRAINT "damage_reports_idempotency_key_nonempty"
  CHECK (length(btrim("idempotency_key")) > 0);

-- Trigger de cohérence multi-tenant : identique à condition_reports
CREATE OR REPLACE FUNCTION before_check_damage_report_consistency()
RETURNS TRIGGER AS $$
DECLARE
  booking_org_id uuid;
  booking_item_booking_id uuid;
  booking_item_inventory_id uuid;
  inv_org_id uuid;
BEGIN
  -- 1. Le booking doit appartenir à la même organisation
  SELECT organization_id INTO booking_org_id FROM bookings WHERE id = NEW.booking_id;
  IF booking_org_id IS NULL OR booking_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'La réservation n''appartient pas à la même organisation que la déclaration de dommage';
  END IF;
  -- 2. Le booking_item doit appartenir au booking et référencer le bon inventory_item
  SELECT booking_id, inventory_item_id INTO booking_item_booking_id, booking_item_inventory_id
    FROM booking_items WHERE id = NEW.booking_item_id;
  IF booking_item_booking_id IS NULL OR booking_item_booking_id <> NEW.booking_id THEN
    RAISE EXCEPTION 'L''élément de réservation n''appartient pas à la réservation indiquée';
  END IF;
  IF booking_item_inventory_id <> NEW.inventory_item_id THEN
    RAISE EXCEPTION 'L''exemplaire de la déclaration ne correspond pas à l''élément de réservation';
  END IF;
  -- 3. L'exemplaire doit appartenir à la même organisation
  SELECT organization_id INTO inv_org_id FROM inventory_items WHERE id = NEW.inventory_item_id;
  IF inv_org_id IS NULL OR inv_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'L''exemplaire n''appartient pas à la même organisation que la déclaration de dommage';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_damage_report
  BEFORE INSERT OR UPDATE OF booking_id, booking_item_id, inventory_item_id, organization_id ON "damage_reports"
  FOR EACH ROW EXECUTE FUNCTION before_check_damage_report_consistency();

-- Trigger append-only : interdit UPDATE et DELETE
CREATE OR REPLACE FUNCTION prevent_damage_report_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'damage_reports est append-only : UPDATE et DELETE sont interdits';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_update_damage_reports
  BEFORE UPDATE ON "damage_reports"
  FOR EACH ROW EXECUTE FUNCTION prevent_damage_report_modification();

CREATE TRIGGER no_delete_damage_reports
  BEFORE DELETE ON "damage_reports"
  FOR EACH ROW EXECUTE FUNCTION prevent_damage_report_modification();

-- Index
CREATE INDEX "booking_fulfillment_events_org_booking_index"
  ON "booking_fulfillment_events" ("organization_id", "booking_id");

CREATE INDEX "booking_fulfillment_events_org_occurred_at_index"
  ON "booking_fulfillment_events" ("organization_id", "occurred_at");

CREATE INDEX "condition_reports_org_booking_index"
  ON "condition_reports" ("organization_id", "booking_id");

CREATE INDEX "condition_reports_org_booking_item_index"
  ON "condition_reports" ("organization_id", "booking_item_id");

CREATE INDEX "damage_reports_org_booking_index"
  ON "damage_reports" ("organization_id", "booking_id");

CREATE INDEX "damage_reports_org_booking_item_index"
  ON "damage_reports" ("organization_id", "booking_item_id");
