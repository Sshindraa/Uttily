-- Migration 0019 : Lot 5 — Paiement Stripe Connect, confirmation et réconciliation.
-- Tables : organization_payment_accounts, payments, payment_attempts,
--          payment_webhook_events, bookings, booking_lines, booking_items,
--          outbox_events, refunds.
-- ADR-010 : Accepté (périmètre Lot 5 technique, Stripe TEST).

-- Enums
DO $$ BEGIN
  CREATE TYPE "payment_provider" AS ENUM('STRIPE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "payment_environment" AS ENUM('TEST', 'LIVE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "account_api_generation" AS ENUM('ACCOUNTS_V2', 'ACCOUNTS_V1_CONTROLLER_PROPERTIES');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "onboarding_status" AS ENUM('PENDING', 'SUBMITTED', 'ENABLED', 'DISABLED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "capability_status" AS ENUM('ACTIVE', 'INACTIVE', 'PENDING', 'UNREQUESTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "settlement_merchant_mode" AS ENUM('PLATFORM', 'CONNECTED_ACCOUNT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "charge_model" AS ENUM('DESTINATION');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "payment_status" AS ENUM('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "payment_attempt_status" AS ENUM('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "webhook_event_status" AS ENUM('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "booking_status" AS ENUM('CONFIRMED', 'READY_FOR_PICKUP', 'ACTIVE', 'RETURNED', 'CLOSED', 'CANCELLED', 'REFUNDED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "outbox_event_status" AS ENUM('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "refund_reason" AS ENUM('LATE_PAYMENT_NO_BOOKING');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "refund_status" AS ENUM('PENDING', 'SUBMITTED', 'SUCCEEDED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Table organization_payment_accounts
CREATE TABLE "organization_payment_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "provider" "payment_provider" NOT NULL DEFAULT 'STRIPE',
  "environment" "payment_environment" NOT NULL,
  "provider_account_id" text NOT NULL,
  "account_api_generation" "account_api_generation" NOT NULL,
  "onboarding_status" "onboarding_status" NOT NULL,
  "charges_enabled" boolean NOT NULL DEFAULT false,
  "payouts_enabled" boolean NOT NULL DEFAULT false,
  "transfers_capability_status" "capability_status" NOT NULL,
  "settlement_merchant_mode" "settlement_merchant_mode" NOT NULL,
  "controller_configuration_snapshot" jsonb NOT NULL,
  "requirements_snapshot" jsonb NOT NULL,
  "last_provider_event_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "organization_payment_accounts"
  ADD CONSTRAINT "organization_payment_accounts_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "organization_payment_accounts"
  ADD CONSTRAINT "organization_payment_accounts_org_provider_env_unique"
  UNIQUE ("organization_id", "provider", "environment");

ALTER TABLE "organization_payment_accounts"
  ADD CONSTRAINT "organization_payment_accounts_provider_env_account_unique"
  UNIQUE ("provider", "environment", "provider_account_id");

ALTER TABLE "organization_payment_accounts"
  ADD CONSTRAINT "organization_payment_accounts_provider_stripe"
  CHECK ("provider" = 'STRIPE');

-- Table payments
CREATE TABLE "payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "draft_id" uuid NOT NULL,
  "customer_user_id" uuid NOT NULL,
  "status" "payment_status" NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL DEFAULT 'EUR',
  "tax_status" "tax_status" NOT NULL,
  "tax_amount_minor" bigint,
  "tax_rate_bps" integer,
  "tax_rule_snapshot" jsonb,
  "commission_amount_minor" bigint NOT NULL,
  "commission_rule_snapshot" jsonb,
  "financial_terms_version" text NOT NULL,
  "legal_terms_version" text NOT NULL,
  "terms_acceptance_snapshot" jsonb NOT NULL,
  "connected_account_id" text NOT NULL,
  "on_behalf_of_account_id" text,
  "charge_model" "charge_model" NOT NULL DEFAULT 'DESTINATION',
  "settlement_merchant_mode" "settlement_merchant_mode" NOT NULL,
  "processing_started_at" timestamptz,
  "processing_deadline_at" timestamptz,
  "succeeded_at" timestamptz,
  "failed_at" timestamptz,
  "cancelled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_draft_id_booking_drafts_id_fk"
  FOREIGN KEY ("draft_id") REFERENCES "booking_drafts"("id") ON DELETE restrict;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_customer_user_id_users_id_fk"
  FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE restrict;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_draft_id_unique"
  UNIQUE ("draft_id");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_currency_eur"
  CHECK ("currency" = 'EUR');

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_nonneg"
  CHECK ("amount_minor" >= 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_max_safe"
  CHECK ("amount_minor" <= 9007199254740991);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_commission_nonneg"
  CHECK ("commission_amount_minor" >= 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_commission_max_safe"
  CHECK ("commission_amount_minor" <= 9007199254740991);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_commission_lte_amount"
  CHECK ("commission_amount_minor" <= "amount_minor");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_tax_not_undetermined"
  CHECK ("tax_status" <> 'UNDETERMINED');

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_tax_not_applicable_zero"
  CHECK ("tax_status" <> 'NOT_APPLICABLE' OR "tax_amount_minor" = 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_tax_applied_not_null"
  CHECK ("tax_status" <> 'APPLIED' OR "tax_amount_minor" IS NOT NULL);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_tax_nonneg"
  CHECK ("tax_amount_minor" IS NULL OR "tax_amount_minor" >= 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_tax_max_safe"
  CHECK ("tax_amount_minor" IS NULL OR "tax_amount_minor" <= 9007199254740991);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_charge_model_destination"
  CHECK ("charge_model" = 'DESTINATION');

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_succeeded_has_timestamp"
  CHECK ("status" <> 'SUCCEEDED' OR "succeeded_at" IS NOT NULL);

-- Trigger de cohérence multi-tenant : le paiement doit appartenir à la même
-- organisation que le brouillon référencé (via draft_id).
CREATE OR REPLACE FUNCTION before_check_payment_org_consistency()
RETURNS TRIGGER AS $$
DECLARE
  draft_org_id uuid;
BEGIN
  SELECT organization_id INTO draft_org_id FROM booking_drafts WHERE id = NEW.draft_id;
  IF draft_org_id IS NULL OR draft_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'Le paiement n''appartient pas à la même organisation que le brouillon';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_payment_org
  BEFORE INSERT OR UPDATE OF draft_id, organization_id ON "payments"
  FOR EACH ROW EXECUTE FUNCTION before_check_payment_org_consistency();

-- Table payment_attempts
CREATE TABLE "payment_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "payment_id" uuid NOT NULL,
  "attempt_number" integer NOT NULL,
  "status" "payment_attempt_status" NOT NULL,
  "provider_payment_intent_id" text,
  "provider_latest_charge_id" text,
  "provider_idempotency_key" text NOT NULL,
  "provider_status" text NOT NULL,
  "last_provider_error_code" text,
  "reconcile_after" timestamptz,
  "reconcile_lease_until" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "payment_attempts"
  ADD CONSTRAINT "payment_attempts_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "payment_attempts"
  ADD CONSTRAINT "payment_attempts_payment_id_payments_id_fk"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE restrict;

ALTER TABLE "payment_attempts"
  ADD CONSTRAINT "payment_attempts_payment_attempt_number_unique"
  UNIQUE ("payment_id", "attempt_number");

ALTER TABLE "payment_attempts"
  ADD CONSTRAINT "payment_attempts_provider_payment_intent_id_unique"
  UNIQUE ("provider_payment_intent_id");

ALTER TABLE "payment_attempts"
  ADD CONSTRAINT "payment_attempts_provider_idempotency_key_unique"
  UNIQUE ("provider_idempotency_key");

ALTER TABLE "payment_attempts"
  ADD CONSTRAINT "payment_attempts_attempt_number_positive"
  CHECK ("attempt_number" > 0);

ALTER TABLE "payment_attempts"
  ADD CONSTRAINT "payment_attempts_idempotency_key_nonempty"
  CHECK (length(btrim("provider_idempotency_key")) > 0);

-- Trigger de cohérence multi-tenant : la tentative doit appartenir à la même
-- organisation que le paiement référencé (via payment_id).
CREATE OR REPLACE FUNCTION before_check_payment_attempt_org_consistency()
RETURNS TRIGGER AS $$
DECLARE
  payment_org_id uuid;
BEGIN
  SELECT organization_id INTO payment_org_id FROM payments WHERE id = NEW.payment_id;
  IF payment_org_id IS NULL OR payment_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'La tentative n''appartient pas à la même organisation que le paiement';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_payment_attempt_org
  BEFORE INSERT OR UPDATE OF payment_id, organization_id ON "payment_attempts"
  FOR EACH ROW EXECUTE FUNCTION before_check_payment_attempt_org_consistency();

-- Table payment_webhook_events
-- Note : organization_id est résolue avant l'insertion à partir de la tentative
-- ou du compte connecté. Aucun trigger de cohérence multi-tenant n'est nécessaire
-- car l'organisation est déterminée applicativement avant l'insertion.
CREATE TABLE "payment_webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "provider" "payment_provider" NOT NULL DEFAULT 'STRIPE',
  "environment" "payment_environment" NOT NULL,
  "provider_event_id" text NOT NULL,
  "provider_event_created_at" bigint NOT NULL,
  "event_type" text NOT NULL,
  "provider_object_id" text NOT NULL,
  "provider_account_id" text,
  "api_version" text NOT NULL,
  "payload_sha256" text NOT NULL,
  "normalized_payload" jsonb NOT NULL,
  "status" "webhook_event_status" NOT NULL DEFAULT 'RECEIVED',
  "processed_at" timestamptz,
  "failure_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "payment_webhook_events"
  ADD CONSTRAINT "payment_webhook_events_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "payment_webhook_events"
  ADD CONSTRAINT "payment_webhook_events_provider_env_event_unique"
  UNIQUE ("provider", "environment", "provider_event_id");

ALTER TABLE "payment_webhook_events"
  ADD CONSTRAINT "payment_webhook_events_provider_stripe"
  CHECK ("provider" = 'STRIPE');

ALTER TABLE "payment_webhook_events"
  ADD CONSTRAINT "payment_webhook_events_payload_sha256_hex"
  CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN "payment_webhook_events"."normalized_payload" IS 'Allow-list des champs utiles uniquement. Le corps brut du webhook et les données de carte NE DOIVENT PAS être persistés ici (ADR-010).';

-- Table bookings
CREATE TABLE "bookings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "customer_user_id" uuid NOT NULL,
  "draft_id" uuid NOT NULL,
  "payment_id" uuid NOT NULL,
  "status" "booking_status" NOT NULL DEFAULT 'CONFIRMED',
  "customer_start_at" timestamptz NOT NULL,
  "customer_end_at" timestamptz NOT NULL,
  "blocked_start_at" timestamptz NOT NULL,
  "blocked_end_at" timestamptz NOT NULL,
  "prep_buffer_minutes" integer NOT NULL,
  "cleanup_buffer_minutes" integer NOT NULL,
  "currency" text NOT NULL DEFAULT 'EUR',
  "subtotal_amount_minor" bigint NOT NULL,
  "mandatory_fees_amount_minor" bigint NOT NULL DEFAULT 0,
  "tax_status" "tax_status" NOT NULL,
  "tax_amount_minor" bigint,
  "tax_rate_bps" integer,
  "tax_rule_snapshot" jsonb,
  "commission_amount_minor" bigint NOT NULL,
  "commission_rule_snapshot" jsonb,
  "total_amount_minor" bigint NOT NULL,
  "cancellation_policy_snapshot" jsonb NOT NULL,
  "terms_acceptance_snapshot" jsonb NOT NULL,
  "confirmed_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_location_id_locations_id_fk"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE restrict;

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_customer_user_id_users_id_fk"
  FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE restrict;

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_draft_id_booking_drafts_id_fk"
  FOREIGN KEY ("draft_id") REFERENCES "booking_drafts"("id") ON DELETE restrict;

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_payment_id_payments_id_fk"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE restrict;

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_draft_id_unique"
  UNIQUE ("draft_id");

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_payment_id_unique"
  UNIQUE ("payment_id");

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_currency_eur"
  CHECK ("currency" = 'EUR');

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_customer_period_valid"
  CHECK ("customer_end_at" > "customer_start_at");

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_total_nonneg"
  CHECK ("total_amount_minor" >= 0);

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_total_max_safe"
  CHECK ("total_amount_minor" <= 9007199254740991);

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_subtotal_nonneg"
  CHECK ("subtotal_amount_minor" >= 0);

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_mandatory_fees_nonneg"
  CHECK ("mandatory_fees_amount_minor" >= 0);

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_tax_not_undetermined"
  CHECK ("tax_status" <> 'UNDETERMINED');

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_tax_not_applicable_zero"
  CHECK ("tax_status" <> 'NOT_APPLICABLE' OR "tax_amount_minor" = 0);

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_tax_applied_not_null"
  CHECK ("tax_status" <> 'APPLIED' OR "tax_amount_minor" IS NOT NULL);

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_total_equals_subtotal_plus_fees"
  CHECK ("total_amount_minor" = "subtotal_amount_minor" + "mandatory_fees_amount_minor");

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_commission_nonneg"
  CHECK ("commission_amount_minor" >= 0);

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_commission_lte_total"
  CHECK ("commission_amount_minor" <= "total_amount_minor");

-- Trigger de cohérence multi-tenant : la réservation doit appartenir à la même
-- organisation que le brouillon référencé (via draft_id) et que le paiement
-- référencé (via payment_id).
CREATE OR REPLACE FUNCTION before_check_booking_org_consistency()
RETURNS TRIGGER AS $$
DECLARE
  draft_org_id uuid;
  payment_org_id uuid;
BEGIN
  SELECT organization_id INTO draft_org_id FROM booking_drafts WHERE id = NEW.draft_id;
  SELECT organization_id INTO payment_org_id FROM payments WHERE id = NEW.payment_id;
  IF draft_org_id IS NULL OR draft_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'La réservation n''appartient pas à la même organisation que le brouillon';
  END IF;
  IF payment_org_id IS NULL OR payment_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'La réservation n''appartient pas à la même organisation que le paiement';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_booking_org
  BEFORE INSERT OR UPDATE OF draft_id, payment_id, organization_id ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION before_check_booking_org_consistency();

-- Table booking_lines
CREATE TABLE "booking_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "booking_id" uuid NOT NULL,
  "variant_id" uuid NOT NULL,
  "quantity" integer NOT NULL,
  "unit_price_amount_minor" bigint NOT NULL,
  "billable_unit_count" integer NOT NULL,
  "line_total_amount_minor" bigint NOT NULL,
  "currency" text NOT NULL DEFAULT 'EUR',
  "variant_snapshot" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_booking_id_bookings_id_fk"
  FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE cascade;

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_variant_id_product_variants_id_fk"
  FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE restrict;

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_booking_variant_unique"
  UNIQUE ("booking_id", "variant_id");

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_billable_count_positive"
  CHECK ("billable_unit_count" > 0);

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_unit_price_nonneg"
  CHECK ("unit_price_amount_minor" >= 0);

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_line_total_nonneg"
  CHECK ("line_total_amount_minor" >= 0);

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_line_total_max_safe"
  CHECK ("line_total_amount_minor" <= 9007199254740991);

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_unit_price_max_safe"
  CHECK ("unit_price_amount_minor" <= 9007199254740991);

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_currency_eur"
  CHECK ("currency" = 'EUR');

-- Trigger de cohérence multi-tenant : la variante d'une ligne de réservation
-- doit appartenir à la même organisation que la réservation parente.
CREATE OR REPLACE FUNCTION before_check_booking_line_org_consistency()
RETURNS TRIGGER AS $$
DECLARE
  booking_org_id uuid;
  variant_org_id uuid;
BEGIN
  SELECT organization_id INTO booking_org_id FROM bookings WHERE id = NEW.booking_id;
  SELECT p.organization_id INTO variant_org_id
  FROM product_variants pv
  JOIN products p ON pv.product_id = p.id
  WHERE pv.id = NEW.variant_id;
  IF booking_org_id IS NULL OR variant_org_id IS NULL OR booking_org_id <> variant_org_id THEN
    RAISE EXCEPTION 'La variante n''appartient pas à la même organisation que la réservation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_booking_line_org
  BEFORE INSERT OR UPDATE OF booking_id, variant_id ON "booking_lines"
  FOR EACH ROW EXECUTE FUNCTION before_check_booking_line_org_consistency();

-- Table booking_items
CREATE TABLE "booking_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "booking_id" uuid NOT NULL,
  "booking_line_id" uuid NOT NULL,
  "inventory_item_id" uuid NOT NULL,
  "source_hold_block_id" uuid,
  "booking_block_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "booking_items"
  ADD CONSTRAINT "booking_items_booking_id_bookings_id_fk"
  FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE cascade;

ALTER TABLE "booking_items"
  ADD CONSTRAINT "booking_items_booking_line_id_booking_lines_id_fk"
  FOREIGN KEY ("booking_line_id") REFERENCES "booking_lines"("id") ON DELETE cascade;

ALTER TABLE "booking_items"
  ADD CONSTRAINT "booking_items_inventory_item_id_inventory_items_id_fk"
  FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE restrict;

ALTER TABLE "booking_items"
  ADD CONSTRAINT "booking_items_source_hold_block_id_inventory_blocks_id_fk"
  FOREIGN KEY ("source_hold_block_id") REFERENCES "inventory_blocks"("id") ON DELETE restrict;

ALTER TABLE "booking_items"
  ADD CONSTRAINT "booking_items_booking_block_id_inventory_blocks_id_fk"
  FOREIGN KEY ("booking_block_id") REFERENCES "inventory_blocks"("id") ON DELETE restrict;

ALTER TABLE "booking_items"
  ADD CONSTRAINT "booking_items_booking_inventory_item_unique"
  UNIQUE ("booking_id", "inventory_item_id");

ALTER TABLE "booking_items"
  ADD CONSTRAINT "booking_items_booking_block_unique"
  UNIQUE ("booking_block_id");

-- Trigger de cohérence : le bloc source hold et le bloc booking doivent
-- appartenir à la même organisation que la réservation parente.
CREATE OR REPLACE FUNCTION before_check_booking_item_consistency()
RETURNS TRIGGER AS $$
DECLARE
  booking_org_id uuid;
  source_block_org_id uuid;
  booking_block_org_id uuid;
BEGIN
  SELECT organization_id INTO booking_org_id FROM bookings WHERE id = NEW.booking_id;
  SELECT organization_id INTO source_block_org_id FROM inventory_blocks WHERE id = NEW.source_hold_block_id;
  SELECT organization_id INTO booking_block_org_id FROM inventory_blocks WHERE id = NEW.booking_block_id;
  IF booking_org_id IS NULL OR booking_block_org_id IS NULL OR booking_org_id <> booking_block_org_id THEN
    RAISE EXCEPTION 'Le bloc de réservation n''appartient pas à la même organisation que la réservation';
  END IF;
  IF source_block_org_id IS NOT NULL AND source_block_org_id <> booking_org_id THEN
    RAISE EXCEPTION 'Le bloc hold source n''appartient pas à la même organisation que la réservation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_booking_item
  BEFORE INSERT OR UPDATE OF booking_id, source_hold_block_id, booking_block_id ON "booking_items"
  FOR EACH ROW EXECUTE FUNCTION before_check_booking_item_consistency();

-- Table outbox_events
-- Note : organization_id est résolue applicativement à partir de l'agrégat.
-- Aucun trigger de cohérence multi-tenant n'est nécessaire car l'organisation
-- est déterminée par l'applicatif avant l'insertion.
CREATE TABLE "outbox_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "aggregate_type" text NOT NULL,
  "aggregate_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "event_version" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" "outbox_event_status" NOT NULL DEFAULT 'PENDING',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "available_at" timestamptz NOT NULL,
  "processed_at" timestamptz,
  "idempotency_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_idempotency_key_unique"
  UNIQUE ("idempotency_key");

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_attempt_count_nonneg"
  CHECK ("attempt_count" >= 0);

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_idempotency_key_nonempty"
  CHECK (length(btrim("idempotency_key")) > 0);

-- Table refunds
CREATE TABLE "refunds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "payment_id" uuid NOT NULL,
  "reason" "refund_reason" NOT NULL,
  "status" "refund_status" NOT NULL DEFAULT 'PENDING',
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL DEFAULT 'EUR',
  "provider_refund_id" text,
  "provider_idempotency_key" text NOT NULL,
  "reverse_transfer" boolean NOT NULL DEFAULT true,
  "refund_application_fee" boolean NOT NULL DEFAULT true,
  "requested_at" timestamptz NOT NULL,
  "submitted_at" timestamptz,
  "succeeded_at" timestamptz,
  "failed_at" timestamptz,
  "failure_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_payment_id_payments_id_fk"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE restrict;

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_payment_reason_unique"
  UNIQUE ("payment_id", "reason");

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_provider_refund_id_unique"
  UNIQUE ("provider_refund_id");

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_provider_idempotency_key_unique"
  UNIQUE ("provider_idempotency_key");

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_currency_eur"
  CHECK ("currency" = 'EUR');

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_nonneg"
  CHECK ("amount_minor" >= 0);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_max_safe"
  CHECK ("amount_minor" <= 9007199254740991);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_late_payment_reverse_transfer"
  CHECK ("reason" <> 'LATE_PAYMENT_NO_BOOKING' OR "reverse_transfer" = true);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_late_payment_refund_application_fee"
  CHECK ("reason" <> 'LATE_PAYMENT_NO_BOOKING' OR "refund_application_fee" = true);

-- Trigger de cohérence multi-tenant : le remboursement doit appartenir à la
-- même organisation que le paiement référencé (via payment_id).
CREATE OR REPLACE FUNCTION before_check_refund_org_consistency()
RETURNS TRIGGER AS $$
DECLARE
  payment_org_id uuid;
BEGIN
  SELECT organization_id INTO payment_org_id FROM payments WHERE id = NEW.payment_id;
  IF payment_org_id IS NULL OR payment_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'Le remboursement n''appartient pas à la même organisation que le paiement';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_refund_org
  BEFORE INSERT OR UPDATE OF payment_id, organization_id ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION before_check_refund_org_consistency();

-- Index (ADR-010 section 7 — index list)
CREATE INDEX "organization_payment_accounts_organization_id_environment_index"
  ON "organization_payment_accounts" ("organization_id", "environment");

CREATE INDEX "payments_organization_id_status_index"
  ON "payments" ("organization_id", "status");

CREATE INDEX "payments_non_terminal_processing_deadline_index"
  ON "payments" ("status", "processing_deadline_at")
  WHERE "status" IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING');

CREATE INDEX "payment_attempts_payment_id_status_index"
  ON "payment_attempts" ("payment_id", "status");

CREATE INDEX "payment_attempts_reconcile_index"
  ON "payment_attempts" ("status", "reconcile_after", "reconcile_lease_until")
  WHERE "status" IN ('PENDING_PROVIDER', 'REQUIRES_ACTION', 'PROCESSING');

CREATE INDEX "payment_webhook_events_status_created_at_index"
  ON "payment_webhook_events" ("status", "created_at");

CREATE INDEX "bookings_organization_id_status_customer_start_at_index"
  ON "bookings" ("organization_id", "status", "customer_start_at");

CREATE INDEX "outbox_events_status_available_at_created_at_index"
  ON "outbox_events" ("status", "available_at", "created_at")
  WHERE "status" IN ('PENDING', 'PROCESSING');

CREATE UNIQUE INDEX "booking_items_source_hold_block_unique"
  ON "booking_items" ("source_hold_block_id")
  WHERE "source_hold_block_id" IS NOT NULL;

CREATE INDEX "refunds_status_requested_at_index"
  ON "refunds" ("status", "requested_at");
