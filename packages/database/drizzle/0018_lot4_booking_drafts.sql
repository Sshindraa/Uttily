-- Migration 0018 : Lot 4 — Prix, brouillon de réservation, allocations et idempotence.
-- Tables : booking_drafts, booking_draft_lines, allocations, idempotency_records.
-- Colonnes ajoutées : product_variants (prix), locations (marges), organizations (politique annulation).
-- ADR-009 : Accepté (périmètre Lot 4 technique).

-- Enums
DO $$ BEGIN
  CREATE TYPE "booking_draft_status" AS ENUM('DRAFT', 'HELD', 'PAYMENT_PROCESSING', 'EXPIRED', 'CANCELLED', 'CONVERTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "tax_status" AS ENUM('UNDETERMINED', 'NOT_APPLICABLE', 'APPLIED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "allocation_status" AS ENUM('ALLOCATED', 'RELEASED', 'CONVERTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "cancellation_policy_code" AS ENUM('FLEXIBLE', 'MODERATE', 'FIRM');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- organizations : politique d'annulation par défaut
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "default_cancellation_policy_code" "cancellation_policy_code" NOT NULL DEFAULT 'FLEXIBLE';

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_default_cancellation_policy_code_valid"
  CHECK ("default_cancellation_policy_code" IN ('FLEXIBLE', 'MODERATE', 'FIRM'));

-- locations : marges opérationnelles
ALTER TABLE "locations"
  ADD COLUMN IF NOT EXISTS "prep_buffer_minutes" integer NOT NULL DEFAULT 30;

ALTER TABLE "locations"
  ADD COLUMN IF NOT EXISTS "cleanup_buffer_minutes" integer NOT NULL DEFAULT 30;

ALTER TABLE "locations"
  ADD CONSTRAINT "locations_prep_buffer_nonneg"
  CHECK ("prep_buffer_minutes" >= 0);

ALTER TABLE "locations"
  ADD CONSTRAINT "locations_cleanup_buffer_nonneg"
  CHECK ("cleanup_buffer_minutes" >= 0);

-- product_variants : prix par jour civil
ALTER TABLE "product_variants"
  ADD COLUMN IF NOT EXISTS "daily_price_amount_minor" bigint;

ALTER TABLE "product_variants"
  ADD COLUMN IF NOT EXISTS "currency" text NOT NULL DEFAULT 'EUR';

ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_daily_price_positive"
  CHECK ("daily_price_amount_minor" IS NULL OR "daily_price_amount_minor" > 0);

ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_daily_price_max"
  CHECK ("daily_price_amount_minor" IS NULL OR "daily_price_amount_minor" <= 9007199254740991);

ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_currency_eur"
  CHECK ("currency" = 'EUR');

-- Table booking_drafts
CREATE TABLE "booking_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "customer_user_id" uuid NOT NULL,
  "status" "booking_draft_status" NOT NULL DEFAULT 'DRAFT',
  "customer_start_at" timestamptz NOT NULL,
  "customer_end_at" timestamptz NOT NULL,
  "blocked_start_at" timestamptz NOT NULL,
  "blocked_end_at" timestamptz NOT NULL,
  "timezone" text NOT NULL,
  "prep_buffer_minutes" integer NOT NULL,
  "cleanup_buffer_minutes" integer NOT NULL,
  "currency" text NOT NULL DEFAULT 'EUR',
  "subtotal_amount_minor" bigint NOT NULL,
  "mandatory_fees_amount_minor" bigint NOT NULL DEFAULT 0,
  "total_amount_minor" bigint NOT NULL,
  "tax_status" "tax_status" NOT NULL DEFAULT 'UNDETERMINED',
  "tax_amount_minor" bigint,
  "tax_rate_bps" integer,
  "commission_amount_minor" bigint,
  "billable_unit" text NOT NULL DEFAULT 'DAY',
  "billable_unit_count" integer NOT NULL,
  "cancellation_policy_snapshot" jsonb NOT NULL,
  "expires_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_location_id_locations_id_fk"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE restrict;

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_customer_user_id_users_id_fk"
  FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE restrict;

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_customer_period_valid"
  CHECK ("customer_end_at" > "customer_start_at");

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_blocked_includes_customer"
  CHECK ("blocked_start_at" <= "customer_start_at" AND "blocked_end_at" >= "customer_end_at");

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_total_nonneg"
  CHECK ("total_amount_minor" >= 0);

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_subtotal_nonneg"
  CHECK ("subtotal_amount_minor" >= 0);

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_mandatory_fees_nonneg"
  CHECK ("mandatory_fees_amount_minor" >= 0);

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_total_max_safe"
  CHECK ("total_amount_minor" <= 9007199254740991);

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_tax_undetermined_null"
  CHECK ("tax_status" <> 'UNDETERMINED' OR "tax_amount_minor" IS NULL);

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_tax_not_applicable_zero"
  CHECK ("tax_status" <> 'NOT_APPLICABLE' OR "tax_amount_minor" = 0);

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_tax_applied_not_null"
  CHECK ("tax_status" <> 'APPLIED' OR "tax_amount_minor" IS NOT NULL);

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_subtotal_max_safe"
  CHECK ("subtotal_amount_minor" <= 9007199254740991);

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_mandatory_fees_max_safe"
  CHECK ("mandatory_fees_amount_minor" <= 9007199254740991);

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_tax_max_safe"
  CHECK ("tax_amount_minor" IS NULL OR "tax_amount_minor" <= 9007199254740991);

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_commission_max_safe"
  CHECK ("commission_amount_minor" IS NULL OR "commission_amount_minor" <= 9007199254740991);

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_total_equals_subtotal_plus_fees"
  CHECK ("total_amount_minor" = "subtotal_amount_minor" + "mandatory_fees_amount_minor");

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_billable_count_positive"
  CHECK ("billable_unit_count" > 0);

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_billable_unit_day"
  CHECK ("billable_unit" = 'DAY');

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_currency_eur"
  CHECK ("currency" = 'EUR');

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_held_requires_expires_at"
  CHECK ("status" NOT IN ('HELD', 'PAYMENT_PROCESSING') OR "expires_at" IS NOT NULL);

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_tax_nonneg"
  CHECK ("tax_amount_minor" IS NULL OR "tax_amount_minor" >= 0);

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_commission_nonneg"
  CHECK ("commission_amount_minor" IS NULL OR "commission_amount_minor" >= 0);

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_tax_rate_bps_undetermined_null"
  CHECK ("tax_status" <> 'UNDETERMINED' OR "tax_rate_bps" IS NULL);

-- Trigger de cohérence multi-tenant : l'établissement doit appartenir
-- à la même organisation que le brouillon.
CREATE OR REPLACE FUNCTION check_booking_draft_org_consistency()
RETURNS TRIGGER AS $$
DECLARE
  loc_org_id uuid;
BEGIN
  SELECT organization_id INTO loc_org_id FROM locations WHERE id = NEW.location_id;
  IF loc_org_id IS NULL OR loc_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'L''établissement n''appartient pas à la même organisation que le brouillon';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_booking_draft_org
  BEFORE INSERT OR UPDATE OF location_id, organization_id ON "booking_drafts"
  FOR EACH ROW EXECUTE FUNCTION check_booking_draft_org_consistency();

-- Table booking_draft_lines
CREATE TABLE "booking_draft_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "draft_id" uuid NOT NULL,
  "variant_id" uuid NOT NULL,
  "quantity" integer NOT NULL,
  "unit_price_amount_minor" bigint NOT NULL,
  "billable_unit_count" integer NOT NULL,
  "line_total_amount_minor" bigint NOT NULL,
  "currency" text NOT NULL DEFAULT 'EUR',
  "variant_snapshot" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_draft_id_booking_drafts_id_fk"
  FOREIGN KEY ("draft_id") REFERENCES "booking_drafts"("id") ON DELETE cascade;

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_variant_id_product_variants_id_fk"
  FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE restrict;

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_billable_count_positive"
  CHECK ("billable_unit_count" > 0);

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_unit_price_nonneg"
  CHECK ("unit_price_amount_minor" >= 0);

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_line_total_nonneg"
  CHECK ("line_total_amount_minor" >= 0);

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_line_total_max_safe"
  CHECK ("line_total_amount_minor" <= 9007199254740991);

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_unit_price_max_safe"
  CHECK ("unit_price_amount_minor" <= 9007199254740991);

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_currency_eur"
  CHECK ("currency" = 'EUR');

-- Trigger de cohérence multi-tenant : la variante d'une ligne doit appartenir
-- à la même organisation que le brouillon parent.
CREATE OR REPLACE FUNCTION check_booking_draft_line_org_consistency()
RETURNS TRIGGER AS $$
DECLARE
  draft_org_id uuid;
  variant_org_id uuid;
BEGIN
  SELECT organization_id INTO draft_org_id FROM booking_drafts WHERE id = NEW.draft_id;
  SELECT p.organization_id INTO variant_org_id
  FROM product_variants pv
  JOIN products p ON pv.product_id = p.id
  WHERE pv.id = NEW.variant_id;
  IF draft_org_id IS NULL OR variant_org_id IS NULL OR draft_org_id <> variant_org_id THEN
    RAISE EXCEPTION 'La variante n''appartient pas à la même organisation que le brouillon';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_booking_draft_line_org
  BEFORE INSERT OR UPDATE OF draft_id, variant_id ON "booking_draft_lines"
  FOR EACH ROW EXECUTE FUNCTION check_booking_draft_line_org_consistency();

-- Table allocations
CREATE TABLE "allocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "draft_line_id" uuid NOT NULL,
  "inventory_block_id" uuid NOT NULL,
  "status" "allocation_status" NOT NULL DEFAULT 'ALLOCATED',
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "allocations"
  ADD CONSTRAINT "allocations_draft_line_id_booking_draft_lines_id_fk"
  FOREIGN KEY ("draft_line_id") REFERENCES "booking_draft_lines"("id") ON DELETE cascade;

ALTER TABLE "allocations"
  ADD CONSTRAINT "allocations_inventory_block_id_inventory_blocks_id_fk"
  FOREIGN KEY ("inventory_block_id") REFERENCES "inventory_blocks"("id") ON DELETE restrict;

ALTER TABLE "allocations"
  ADD CONSTRAINT "allocations_draft_line_block_unique"
  UNIQUE ("draft_line_id", "inventory_block_id");

ALTER TABLE "allocations"
  ADD CONSTRAINT "allocations_inventory_block_unique"
  UNIQUE ("inventory_block_id");

-- Trigger de cohérence : le bloc d'une allocation doit appartenir à la même
-- organisation que le brouillon parent (via draft_line_id → draft_id), et
-- le bloc doit être lié au même brouillon (inventory_blocks.source_id = draft_id).
-- Le bloc doit être de type HOLD.
CREATE OR REPLACE FUNCTION check_allocation_consistency()
RETURNS TRIGGER AS $$
DECLARE
  draft_id uuid;
  draft_org_id uuid;
  draft_status text;
  line_variant_id uuid;
  block_org_id uuid;
  block_source_id uuid;
  block_type text;
  block_status text;
  block_item_variant_id uuid;
BEGIN
  SELECT dl.draft_id, dl.variant_id
  INTO draft_id, line_variant_id
  FROM booking_draft_lines dl
  WHERE dl.id = NEW.draft_line_id;

  SELECT bd.organization_id, bd.status::text
  INTO draft_org_id, draft_status
  FROM booking_drafts bd
  WHERE bd.id = draft_id;

  SELECT ib.organization_id, ib.source_id, ib.type::text, ib.status::text
  INTO block_org_id, block_source_id, block_type, block_status
  FROM inventory_blocks ib
  WHERE ib.id = NEW.inventory_block_id;

  SELECT ii.product_variant_id
  INTO block_item_variant_id
  FROM inventory_blocks ib
  JOIN inventory_items ii ON ib.inventory_item_id = ii.id
  WHERE ib.id = NEW.inventory_block_id;

  IF draft_org_id IS NULL OR block_org_id IS NULL OR draft_org_id <> block_org_id THEN
    RAISE EXCEPTION 'Le bloc n''appartient pas à la même organisation que le brouillon';
  END IF;
  IF block_source_id IS NULL OR block_source_id <> draft_id THEN
    RAISE EXCEPTION 'Le bloc n''est pas lié au brouillon parent (source_id mismatch)';
  END IF;
  IF block_type <> 'HOLD' THEN
    RAISE EXCEPTION 'Le bloc alloué doit être de type HOLD';
  END IF;
  IF block_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Le bloc alloué doit être au statut ACTIVE';
  END IF;
  IF draft_status <> 'HELD' THEN
    RAISE EXCEPTION 'Le brouillon doit être au statut HELD pour accepter une allocation';
  END IF;
  IF block_item_variant_id IS NULL OR block_item_variant_id <> line_variant_id THEN
    RAISE EXCEPTION 'L''exemplaire du bloc ne correspond pas à la variante de la ligne';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_allocation_consistency
  BEFORE INSERT OR UPDATE OF draft_line_id, inventory_block_id ON "allocations"
  FOR EACH ROW EXECUTE FUNCTION check_allocation_consistency();

-- Table idempotency_records
CREATE TABLE "idempotency_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "operation" text NOT NULL,
  "key" text NOT NULL,
  "request_fingerprint" text NOT NULL,
  "status" text NOT NULL,
  "resource_id" uuid,
  "response_status_code" integer,
  "response_body" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "pending_timeout_at" timestamptz
);

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_org_operation_key_unique"
  UNIQUE ("organization_id", "operation", "key");

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_status_valid"
  CHECK ("status" IN ('PENDING', 'COMPLETED', 'FAILED'));

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_fingerprint_hex"
  CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$');

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_pending_has_timeout"
  CHECK ("status" <> 'PENDING' OR "pending_timeout_at" IS NOT NULL);

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_pending_no_response"
  CHECK ("status" <> 'PENDING' OR ("resource_id" IS NULL AND "response_status_code" IS NULL AND "response_body" IS NULL AND "completed_at" IS NULL));

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_completed_has_resource"
  CHECK ("status" <> 'COMPLETED' OR ("resource_id" IS NOT NULL AND "response_status_code" IS NOT NULL AND "response_body" IS NOT NULL AND "completed_at" IS NOT NULL));

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_failed_has_response"
  CHECK ("status" <> 'FAILED' OR ("response_status_code" IS NOT NULL AND "response_body" IS NOT NULL AND "completed_at" IS NOT NULL AND "resource_id" IS NULL));

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_status_code_range"
  CHECK ("response_status_code" IS NULL OR ("response_status_code" >= 100 AND "response_status_code" <= 599));

-- Index
CREATE INDEX "booking_drafts_customer_user_id_index" ON "booking_drafts" ("customer_user_id");
CREATE INDEX "booking_drafts_organization_id_index" ON "booking_drafts" ("organization_id");
CREATE INDEX "booking_drafts_expires_at_index" ON "booking_drafts" ("expires_at") WHERE "status" = 'HELD';
CREATE INDEX "allocations_draft_line_id_index" ON "allocations" ("draft_line_id");
-- Index pour le traitement par brouillon (recherche de tous les blocs d'un brouillon donné).
-- Ajouté ici car le besoin est apparu avec le Lot 4 (source_id utilisé pour lier les blocs aux drafts).
CREATE INDEX "inventory_blocks_source_id_index" ON "inventory_blocks" ("source_id") WHERE "deleted_at" IS NULL;
CREATE INDEX "idempotency_records_pending_timeout_index" ON "idempotency_records" ("status", "pending_timeout_at") WHERE "status" = 'PENDING';
