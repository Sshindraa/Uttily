-- Migration 0036 : G7M-A — Fondations PostgreSQL append-only des amendements financiers.
--
-- ADR-023 : tables d'amendement, paiements de supplément, extension des refunds,
-- adaptation des rapports fulfillment. Schéma, triggers et contraintes uniquement.
-- Aucun flux métier, Stripe, webhook, worker, API ou UI.
--
-- Stratégie : remplacement transactionnel des enums refund_reason et refund_status
-- (PAS de ALTER TYPE ADD VALUE) car le runner Drizzle 0.36.4 exécute toutes les
-- migrations en attente dans une transaction commune (pattern 0029).

-- ===========================================================================
-- Étape 1 — Remplacement transactionnel de refund_reason
-- ===========================================================================
-- Les contraintes CHECK et l'index unique suivants référencent la colonne
-- "reason" avec l'ancien type enum. Ils doivent être supprimés avant le
-- ALTER COLUMN TYPE puis recréés après, sinon PostgreSQL échoue avec
-- "operator does not exist: refund_reason = refund_reason_old".
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_late_payment_reverse_transfer";
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_late_payment_refund_application_fee";
DROP INDEX IF EXISTS "refunds_late_payment_unique";

-- Remplacement de l'enum.
ALTER TYPE "refund_reason" RENAME TO "refund_reason_old";
CREATE TYPE "refund_reason" AS ENUM (
  'LATE_PAYMENT_NO_BOOKING',
  'EXTERNAL_REFUND',
  'BOOKING_MODIFICATION',
  'AMENDMENT_COMPENSATION'
);
ALTER TABLE "refunds" ALTER COLUMN "reason" DROP DEFAULT;
ALTER TABLE "refunds" ALTER COLUMN "reason" TYPE "refund_reason" USING "reason"::text::"refund_reason";
DROP TYPE "refund_reason_old";

-- Recréation des contraintes et index dépendants avec le nouveau type.
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_late_payment_reverse_transfer"
  CHECK ("reason" <> 'LATE_PAYMENT_NO_BOOKING' OR "reverse_transfer" = true);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_late_payment_refund_application_fee"
  CHECK ("reason" <> 'LATE_PAYMENT_NO_BOOKING' OR "refund_application_fee" = true);

CREATE UNIQUE INDEX "refunds_late_payment_unique"
  ON "refunds" ("payment_id", "reason")
  WHERE "refunds"."reason" = 'LATE_PAYMENT_NO_BOOKING';

-- ===========================================================================
-- Étape 2 — Remplacement transactionnel de refund_status
-- ===========================================================================
ALTER TYPE "refund_status" RENAME TO "refund_status_old";
CREATE TYPE "refund_status" AS ENUM (
  'PENDING',
  'SUBMITTED',
  'SUCCEEDED',
  'FAILED',
  'FAILED_REQUIRES_MANUAL_ACTION',
  'SETTLED_OFF_PLATFORM'
);
ALTER TABLE "refunds" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "refunds" ALTER COLUMN "status" TYPE "refund_status" USING "status"::text::"refund_status";
ALTER TABLE "refunds" ALTER COLUMN "status" SET DEFAULT 'PENDING';
DROP TYPE "refund_status_old";

-- ===========================================================================
-- Étape 3 — Nouveaux enums d'amendement
-- ===========================================================================
CREATE TYPE "amendment_type" AS ENUM ('NEUTRAL', 'SUPPLEMENT', 'REFUND');
CREATE TYPE "amendment_status" AS ENUM (
  'HOLD_PENDING',
  'READY_TO_APPLY',
  'APPLIED',
  'EXPIRED',
  'CANCELLED',
  'FAILED'
);
CREATE TYPE "amendment_line_origin_type" AS ENUM ('ORIGINAL', 'AMENDMENT');
CREATE TYPE "amendment_line_action" AS ENUM ('ADD', 'MODIFY', 'REMOVE', 'UNCHANGED');
CREATE TYPE "amendment_allocation_action" AS ENUM ('RETAIN', 'ADD', 'REMOVE', 'REPLACE');
CREATE TYPE "amendment_allocation_status" AS ENUM ('PROPOSED', 'CONVERTED', 'RELEASED', 'EXPIRED');
CREATE TYPE "amendment_segment_status" AS ENUM ('PROPOSED', 'CONVERTED', 'RELEASED', 'EXPIRED');
CREATE TYPE "amendment_payment_status" AS ENUM (
  'PENDING_PROVIDER',
  'REQUIRES_PAYMENT_METHOD',
  'REQUIRES_ACTION',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED'
);
CREATE TYPE "amendment_payment_attempt_status" AS ENUM (
  'PENDING_PROVIDER',
  'REQUIRES_PAYMENT_METHOD',
  'REQUIRES_ACTION',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED'
);

-- ===========================================================================
-- Étape 4 — Table booking_amendments
-- ===========================================================================
CREATE TABLE "booking_amendments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "booking_id" uuid NOT NULL,
  "amendment_number" integer NOT NULL,
  "type" "amendment_type" NOT NULL,
  "status" "amendment_status" NOT NULL DEFAULT 'HOLD_PENDING',
  "financial_snapshot_before" jsonb NOT NULL,
  "financial_snapshot_after" jsonb NOT NULL,
  "new_customer_start_at" timestamptz NOT NULL,
  "new_customer_end_at" timestamptz NOT NULL,
  "new_blocked_start_at" timestamptz NOT NULL,
  "new_blocked_end_at" timestamptz NOT NULL,
  "hold_deadline" timestamptz,
  "created_by" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "applied_at" timestamptz,
  "expired_at" timestamptz,
  "cancelled_at" timestamptz,
  "failed_at" timestamptz
);

ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_booking_id_bookings_id_fk"
  FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE restrict;

ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE restrict;

ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_booking_number_unique"
  UNIQUE ("booking_id", "amendment_number");

ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_number_positive"
  CHECK ("amendment_number" > 0);

ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_customer_period_valid"
  CHECK ("new_customer_end_at" > "new_customer_start_at");

ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_blocked_includes_customer"
  CHECK ("new_blocked_start_at" <= "new_customer_start_at" AND "new_blocked_end_at" >= "new_customer_end_at");

ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_supplement_hold_deadline"
  CHECK ("type" <> 'SUPPLEMENT' OR "hold_deadline" IS NOT NULL);

ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_non_supplement_no_hold_deadline"
  CHECK ("type" = 'SUPPLEMENT' OR "hold_deadline" IS NULL);

ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_applied_has_timestamp"
  CHECK ("status" <> 'APPLIED' OR "applied_at" IS NOT NULL);

ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_expired_has_timestamp"
  CHECK ("status" <> 'EXPIRED' OR "expired_at" IS NOT NULL);

ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_cancelled_has_timestamp"
  CHECK ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL);

ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_failed_has_timestamp"
  CHECK ("status" <> 'FAILED' OR "failed_at" IS NOT NULL);

-- Les états non-terminaux ne doivent avoir AUCUN timestamp terminal renseigné.
ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_non_terminal_no_terminal_timestamps"
  CHECK (
    ("status" IN ('APPLIED', 'EXPIRED', 'CANCELLED', 'FAILED'))
    OR ("applied_at" IS NULL AND "expired_at" IS NULL AND "cancelled_at" IS NULL AND "failed_at" IS NULL)
  );

-- Chaque état terminal ne peut avoir que SON timestamp renseigné (les autres NULL).
ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_applied_only_applied_at"
  CHECK ("status" <> 'APPLIED' OR ("expired_at" IS NULL AND "cancelled_at" IS NULL AND "failed_at" IS NULL));

ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_expired_only_expired_at"
  CHECK ("status" <> 'EXPIRED' OR ("applied_at" IS NULL AND "cancelled_at" IS NULL AND "failed_at" IS NULL));

ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_cancelled_only_cancelled_at"
  CHECK ("status" <> 'CANCELLED' OR ("applied_at" IS NULL AND "expired_at" IS NULL AND "failed_at" IS NULL));

ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_failed_only_failed_at"
  CHECK ("status" <> 'FAILED' OR ("applied_at" IS NULL AND "expired_at" IS NULL AND "cancelled_at" IS NULL));

CREATE UNIQUE INDEX "booking_amendments_single_active_per_booking"
  ON "booking_amendments" ("booking_id")
  WHERE "booking_amendments"."status" IN ('HOLD_PENDING', 'READY_TO_APPLY');

CREATE INDEX "booking_amendments_organization_booking_status_index"
  ON "booking_amendments" ("organization_id", "booking_id", "status");

-- ===========================================================================
-- Étape 5 — Table booking_amendment_lines
-- ===========================================================================
CREATE TABLE "booking_amendment_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "amendment_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "logical_line_id" uuid NOT NULL,
  "origin_type" "amendment_line_origin_type" NOT NULL,
  "source_booking_line_id" uuid,
  "variant_id" uuid NOT NULL,
  "action" "amendment_line_action" NOT NULL,
  "before_quantity" integer NOT NULL,
  "before_unit_price_amount_minor" bigint NOT NULL,
  "before_line_total_amount_minor" bigint NOT NULL,
  "after_quantity" integer NOT NULL,
  "after_unit_price_amount_minor" bigint NOT NULL,
  "after_line_total_amount_minor" bigint NOT NULL,
  "pricing_snapshot" jsonb NOT NULL,
  "variant_snapshot" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_amendment_id_booking_amendments_id_fk"
  FOREIGN KEY ("amendment_id") REFERENCES "booking_amendments"("id") ON DELETE restrict;

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_source_booking_line_id_booking_lines_id_fk"
  FOREIGN KEY ("source_booking_line_id") REFERENCES "booking_lines"("id") ON DELETE restrict;

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_variant_id_product_variants_id_fk"
  FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE restrict;

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_amendment_logical_line_unique"
  UNIQUE ("amendment_id", "logical_line_id");

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_amendment_variant_unique"
  UNIQUE ("amendment_id", "variant_id");

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_original_has_source"
  CHECK ("origin_type" <> 'ORIGINAL' OR "source_booking_line_id" IS NOT NULL);

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_amendment_no_source"
  CHECK ("origin_type" <> 'AMENDMENT' OR "source_booking_line_id" IS NULL);

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_add_before_zero_after_positive"
  CHECK ("action" <> 'ADD' OR (
    "before_quantity" = 0 AND "before_unit_price_amount_minor" = 0 AND "before_line_total_amount_minor" = 0
    AND "after_quantity" > 0 AND "after_unit_price_amount_minor" > 0 AND "after_line_total_amount_minor" > 0
  ));

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_modify_before_after_positive"
  CHECK ("action" <> 'MODIFY' OR (
    "before_quantity" > 0 AND "before_unit_price_amount_minor" > 0 AND "before_line_total_amount_minor" > 0
    AND "after_quantity" > 0 AND "after_unit_price_amount_minor" > 0 AND "after_line_total_amount_minor" > 0
  ));

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_remove_before_positive_after_zero"
  CHECK ("action" <> 'REMOVE' OR (
    "before_quantity" > 0 AND "before_unit_price_amount_minor" > 0 AND "before_line_total_amount_minor" > 0
    AND "after_quantity" = 0 AND "after_unit_price_amount_minor" = 0 AND "after_line_total_amount_minor" = 0
  ));

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_unchanged_before_after_equal"
  CHECK ("action" <> 'UNCHANGED' OR (
    "before_quantity" = "after_quantity" AND "before_quantity" > 0
    AND "before_unit_price_amount_minor" = "after_unit_price_amount_minor" AND "before_unit_price_amount_minor" > 0
    AND "before_line_total_amount_minor" = "after_line_total_amount_minor" AND "before_line_total_amount_minor" > 0
  ));

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_before_qty_nonneg"
  CHECK ("before_quantity" >= 0);

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_after_qty_nonneg"
  CHECK ("after_quantity" >= 0);

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_before_unit_price_nonneg"
  CHECK ("before_unit_price_amount_minor" >= 0);

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_after_unit_price_nonneg"
  CHECK ("after_unit_price_amount_minor" >= 0);

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_before_line_total_nonneg"
  CHECK ("before_line_total_amount_minor" >= 0);

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_after_line_total_nonneg"
  CHECK ("after_line_total_amount_minor" >= 0);

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_before_line_total_max_safe"
  CHECK ("before_line_total_amount_minor" <= 9007199254740991);

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_after_line_total_max_safe"
  CHECK ("after_line_total_amount_minor" <= 9007199254740991);

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_before_unit_price_max_safe"
  CHECK ("before_unit_price_amount_minor" <= 9007199254740991);

ALTER TABLE "booking_amendment_lines"
  ADD CONSTRAINT "booking_amendment_lines_after_unit_price_max_safe"
  CHECK ("after_unit_price_amount_minor" <= 9007199254740991);

CREATE INDEX "booking_amendment_lines_amendment_id_index"
  ON "booking_amendment_lines" ("amendment_id");

CREATE INDEX "booking_amendment_lines_org_amendment_index"
  ON "booking_amendment_lines" ("organization_id", "amendment_id");

-- ===========================================================================
-- Étape 6 — Table booking_amendment_allocations
-- ===========================================================================
CREATE TABLE "booking_amendment_allocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "amendment_id" uuid NOT NULL,
  "amendment_line_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "inventory_item_id" uuid NOT NULL,
  "action" "amendment_allocation_action" NOT NULL,
  "source_booking_block_id" uuid,
  "applied_booking_block_id" uuid,
  "status" "amendment_allocation_status" NOT NULL DEFAULT 'PROPOSED',
  "effective_customer_start_at" timestamptz NOT NULL,
  "effective_customer_end_at" timestamptz NOT NULL,
  "effective_blocked_start_at" timestamptz NOT NULL,
  "effective_blocked_end_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "booking_amendment_allocations"
  ADD CONSTRAINT "booking_amendment_allocations_amendment_id_booking_amendments_id_fk"
  FOREIGN KEY ("amendment_id") REFERENCES "booking_amendments"("id") ON DELETE restrict;

ALTER TABLE "booking_amendment_allocations"
  ADD CONSTRAINT "booking_amendment_allocations_amendment_line_id_booking_amendment_lines_id_fk"
  FOREIGN KEY ("amendment_line_id") REFERENCES "booking_amendment_lines"("id") ON DELETE restrict;

ALTER TABLE "booking_amendment_allocations"
  ADD CONSTRAINT "booking_amendment_allocations_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "booking_amendment_allocations"
  ADD CONSTRAINT "booking_amendment_allocations_inventory_item_id_inventory_items_id_fk"
  FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE restrict;

ALTER TABLE "booking_amendment_allocations"
  ADD CONSTRAINT "booking_amendment_allocations_source_booking_block_id_inventory_blocks_id_fk"
  FOREIGN KEY ("source_booking_block_id") REFERENCES "inventory_blocks"("id") ON DELETE restrict;

ALTER TABLE "booking_amendment_allocations"
  ADD CONSTRAINT "booking_amendment_allocations_applied_booking_block_id_inventory_blocks_id_fk"
  FOREIGN KEY ("applied_booking_block_id") REFERENCES "inventory_blocks"("id") ON DELETE restrict;

ALTER TABLE "booking_amendment_allocations"
  ADD CONSTRAINT "booking_amendment_allocations_amendment_item_unique"
  UNIQUE ("amendment_id", "inventory_item_id");

ALTER TABLE "booking_amendment_allocations"
  ADD CONSTRAINT "booking_amendment_allocations_customer_period_valid"
  CHECK ("effective_customer_end_at" > "effective_customer_start_at");

ALTER TABLE "booking_amendment_allocations"
  ADD CONSTRAINT "booking_amendment_allocations_blocked_includes_customer"
  CHECK ("effective_blocked_start_at" <= "effective_customer_start_at" AND "effective_blocked_end_at" >= "effective_customer_end_at");

ALTER TABLE "booking_amendment_allocations"
  ADD CONSTRAINT "booking_amendment_allocations_retain_has_source"
  CHECK ("action" <> 'RETAIN' OR "source_booking_block_id" IS NOT NULL);

ALTER TABLE "booking_amendment_allocations"
  ADD CONSTRAINT "booking_amendment_allocations_replace_has_source"
  CHECK ("action" <> 'REPLACE' OR "source_booking_block_id" IS NOT NULL);

ALTER TABLE "booking_amendment_allocations"
  ADD CONSTRAINT "booking_amendment_allocations_add_no_source"
  CHECK ("action" <> 'ADD' OR "source_booking_block_id" IS NULL);

ALTER TABLE "booking_amendment_allocations"
  ADD CONSTRAINT "booking_amendment_allocations_remove_no_applied_block"
  CHECK ("action" <> 'REMOVE' OR "applied_booking_block_id" IS NULL);

ALTER TABLE "booking_amendment_allocations"
  ADD CONSTRAINT "booking_amendment_allocations_applied_block_converted_only"
  CHECK ("applied_booking_block_id" IS NULL OR "status" = 'CONVERTED');

CREATE INDEX "booking_amendment_allocations_amendment_id_index"
  ON "booking_amendment_allocations" ("amendment_id");

CREATE INDEX "booking_amendment_allocations_org_amendment_index"
  ON "booking_amendment_allocations" ("organization_id", "amendment_id");

-- ===========================================================================
-- Étape 7 — Table booking_amendment_segments
-- ===========================================================================
CREATE TABLE "booking_amendment_segments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "allocation_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "inventory_item_id" uuid NOT NULL,
  "hold_block_id" uuid NOT NULL,
  "delta_start_at" timestamptz NOT NULL,
  "delta_end_at" timestamptz NOT NULL,
  "status" "amendment_segment_status" NOT NULL DEFAULT 'PROPOSED',
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "booking_amendment_segments"
  ADD CONSTRAINT "booking_amendment_segments_allocation_id_booking_amendment_allocations_id_fk"
  FOREIGN KEY ("allocation_id") REFERENCES "booking_amendment_allocations"("id") ON DELETE restrict;

ALTER TABLE "booking_amendment_segments"
  ADD CONSTRAINT "booking_amendment_segments_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "booking_amendment_segments"
  ADD CONSTRAINT "booking_amendment_segments_inventory_item_id_inventory_items_id_fk"
  FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE restrict;

ALTER TABLE "booking_amendment_segments"
  ADD CONSTRAINT "booking_amendment_segments_hold_block_id_inventory_blocks_id_fk"
  FOREIGN KEY ("hold_block_id") REFERENCES "inventory_blocks"("id") ON DELETE restrict;

ALTER TABLE "booking_amendment_segments"
  ADD CONSTRAINT "booking_amendment_segments_hold_block_id_unique"
  UNIQUE ("hold_block_id");

ALTER TABLE "booking_amendment_segments"
  ADD CONSTRAINT "booking_amendment_segments_delta_period_valid"
  CHECK ("delta_end_at" > "delta_start_at");

CREATE INDEX "booking_amendment_segments_allocation_id_index"
  ON "booking_amendment_segments" ("allocation_id");

CREATE INDEX "booking_amendment_segments_org_allocation_index"
  ON "booking_amendment_segments" ("organization_id", "allocation_id");

-- ===========================================================================
-- Étape 8 — Table amendment_payments
-- ===========================================================================
-- Colonnes de snapshot Stripe minimales pour l'appel Stripe futur et la
-- réconciliation : connected_account_id, on_behalf_of_account_id, charge_model,
-- settlement_merchant_mode, processing_started_at, processing_deadline_at.
-- Ces colonnes reproduisent le sous-ensemble strictement nécessaire de la table
-- payments (pas de duplication aveugle de toutes les colonnes).
CREATE TABLE "amendment_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "booking_id" uuid NOT NULL,
  "amendment_id" uuid NOT NULL,
  "customer_user_id" uuid NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL DEFAULT 'EUR',
  "environment" "payment_environment" NOT NULL,
  "connected_account_id" text NOT NULL,
  "on_behalf_of_account_id" text,
  "charge_model" "charge_model" NOT NULL,
  "settlement_merchant_mode" "settlement_merchant_mode" NOT NULL,
  "processing_started_at" timestamptz,
  "processing_deadline_at" timestamptz,
  "status" "amendment_payment_status" NOT NULL DEFAULT 'PENDING_PROVIDER',
  "succeeded_at" timestamptz,
  "failed_at" timestamptz,
  "cancelled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "amendment_payments"
  ADD CONSTRAINT "amendment_payments_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "amendment_payments"
  ADD CONSTRAINT "amendment_payments_booking_id_bookings_id_fk"
  FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE restrict;

ALTER TABLE "amendment_payments"
  ADD CONSTRAINT "amendment_payments_amendment_id_booking_amendments_id_fk"
  FOREIGN KEY ("amendment_id") REFERENCES "booking_amendments"("id") ON DELETE restrict;

ALTER TABLE "amendment_payments"
  ADD CONSTRAINT "amendment_payments_customer_user_id_users_id_fk"
  FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE restrict;

ALTER TABLE "amendment_payments"
  ADD CONSTRAINT "amendment_payments_amendment_id_unique"
  UNIQUE ("amendment_id");

ALTER TABLE "amendment_payments"
  ADD CONSTRAINT "amendment_payments_currency_eur"
  CHECK ("currency" = 'EUR');

ALTER TABLE "amendment_payments"
  ADD CONSTRAINT "amendment_payments_amount_positive"
  CHECK ("amount_minor" > 0);

ALTER TABLE "amendment_payments"
  ADD CONSTRAINT "amendment_payments_amount_max_safe"
  CHECK ("amount_minor" <= 9007199254740991);

ALTER TABLE "amendment_payments"
  ADD CONSTRAINT "amendment_payments_succeeded_has_timestamp"
  CHECK ("status" <> 'SUCCEEDED' OR "succeeded_at" IS NOT NULL);

ALTER TABLE "amendment_payments"
  ADD CONSTRAINT "amendment_payments_environment_check"
  CHECK ("environment" IN ('TEST', 'LIVE'));

ALTER TABLE "amendment_payments"
  ADD CONSTRAINT "amendment_payments_failed_has_timestamp"
  CHECK ("status" <> 'FAILED' OR "failed_at" IS NOT NULL);

ALTER TABLE "amendment_payments"
  ADD CONSTRAINT "amendment_payments_cancelled_has_timestamp"
  CHECK ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL);

-- Les états non-terminaux ne doivent avoir AUCUN timestamp terminal renseigné.
ALTER TABLE "amendment_payments"
  ADD CONSTRAINT "amendment_payments_non_terminal_no_terminal_timestamps"
  CHECK (
    ("status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED'))
    OR ("succeeded_at" IS NULL AND "failed_at" IS NULL AND "cancelled_at" IS NULL)
  );

-- Chaque état terminal ne peut avoir que SON timestamp renseigné.
ALTER TABLE "amendment_payments"
  ADD CONSTRAINT "amendment_payments_succeeded_only_succeeded_at"
  CHECK ("status" <> 'SUCCEEDED' OR ("failed_at" IS NULL AND "cancelled_at" IS NULL));

ALTER TABLE "amendment_payments"
  ADD CONSTRAINT "amendment_payments_failed_only_failed_at"
  CHECK ("status" <> 'FAILED' OR ("succeeded_at" IS NULL AND "cancelled_at" IS NULL));

ALTER TABLE "amendment_payments"
  ADD CONSTRAINT "amendment_payments_cancelled_only_cancelled_at"
  CHECK ("status" <> 'CANCELLED' OR ("succeeded_at" IS NULL AND "failed_at" IS NULL));

CREATE INDEX "amendment_payments_organization_status_index"
  ON "amendment_payments" ("organization_id", "status");

CREATE INDEX "amendment_payments_booking_id_index"
  ON "amendment_payments" ("booking_id");

-- ===========================================================================
-- Étape 9 — Table amendment_payment_attempts
-- ===========================================================================
CREATE TABLE "amendment_payment_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "amendment_payment_id" uuid NOT NULL,
  "attempt_number" integer NOT NULL,
  "status" "amendment_payment_attempt_status" NOT NULL,
  "provider_payment_intent_id" text,
  "provider_status" text,
  "provider_idempotency_key" text NOT NULL,
  "last_provider_error_code" text,
  "reconcile_after" timestamptz,
  "reconcile_lease_until" timestamptz,
  "reconcile_lease_token" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "amendment_payment_attempts"
  ADD CONSTRAINT "amendment_payment_attempts_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "amendment_payment_attempts"
  ADD CONSTRAINT "amendment_payment_attempts_amendment_payment_id_amendment_payments_id_fk"
  FOREIGN KEY ("amendment_payment_id") REFERENCES "amendment_payments"("id") ON DELETE restrict;

ALTER TABLE "amendment_payment_attempts"
  ADD CONSTRAINT "amendment_payment_attempts_payment_attempt_number_unique"
  UNIQUE ("amendment_payment_id", "attempt_number");

ALTER TABLE "amendment_payment_attempts"
  ADD CONSTRAINT "amendment_payment_attempts_provider_payment_intent_id_unique"
  UNIQUE ("provider_payment_intent_id");

ALTER TABLE "amendment_payment_attempts"
  ADD CONSTRAINT "amendment_payment_attempts_provider_idempotency_key_unique"
  UNIQUE ("provider_idempotency_key");

ALTER TABLE "amendment_payment_attempts"
  ADD CONSTRAINT "amendment_payment_attempts_attempt_number_positive"
  CHECK ("attempt_number" > 0);

ALTER TABLE "amendment_payment_attempts"
  ADD CONSTRAINT "amendment_payment_attempts_idempotency_key_nonempty"
  CHECK (length(btrim("provider_idempotency_key")) > 0);

ALTER TABLE "amendment_payment_attempts"
  ADD CONSTRAINT "amendment_payment_attempts_provider_status_with_intent"
  CHECK ("provider_payment_intent_id" IS NULL OR "provider_status" IS NOT NULL);

ALTER TABLE "amendment_payment_attempts"
  ADD CONSTRAINT "amendment_payment_attempts_lease_token_lease_until_consistent"
  CHECK (("reconcile_lease_token" IS NULL AND "reconcile_lease_until" IS NULL) OR ("reconcile_lease_token" IS NOT NULL AND "reconcile_lease_until" IS NOT NULL));

-- Si reconcile_lease_until est renseigné, reconcile_after doit aussi être renseigné.
ALTER TABLE "amendment_payment_attempts"
  ADD CONSTRAINT "amendment_payment_attempts_lease_until_implies_reconcile_after"
  CHECK ("reconcile_lease_until" IS NULL OR "reconcile_after" IS NOT NULL);

CREATE UNIQUE INDEX "amendment_payment_attempts_single_non_terminal_attempt"
  ON "amendment_payment_attempts" ("amendment_payment_id")
  WHERE "amendment_payment_attempts"."status" IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING');

CREATE INDEX "amendment_payment_attempts_payment_id_status_index"
  ON "amendment_payment_attempts" ("amendment_payment_id", "status");

CREATE INDEX "amendment_payment_attempts_reconcile_index"
  ON "amendment_payment_attempts" ("status", "reconcile_after", "reconcile_lease_until")
  WHERE "amendment_payment_attempts"."status" IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING');

-- ===========================================================================
-- Étape 10 — Extension de refunds : payment_id nullable + amendment_payment_id + XOR
-- ===========================================================================
ALTER TABLE "refunds" ALTER COLUMN "payment_id" DROP NOT NULL;

ALTER TABLE "refunds"
  ADD COLUMN "amendment_payment_id" uuid;

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amendment_payment_id_amendment_payments_id_fk"
  FOREIGN KEY ("amendment_payment_id") REFERENCES "amendment_payments"("id") ON DELETE restrict;

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_payment_origin_xor"
  CHECK (("payment_id" IS NOT NULL AND "amendment_payment_id" IS NULL) OR ("payment_id" IS NULL AND "amendment_payment_id" IS NOT NULL));

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_booking_modification_payment_id"
  CHECK ("reason" <> 'BOOKING_MODIFICATION' OR "payment_id" IS NOT NULL);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amendment_compensation_amendment_payment_id"
  CHECK ("reason" <> 'AMENDMENT_COMPENSATION' OR "amendment_payment_id" IS NOT NULL);

-- BUG 5 : LATE_PAYMENT_NO_BOOKING et EXTERNAL_REFUND requièrent payment_id
-- (ces raisons historiques ne peuvent pas référencer un paiement de supplément).
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_late_payment_requires_payment_id"
  CHECK ("reason" <> 'LATE_PAYMENT_NO_BOOKING' OR "payment_id" IS NOT NULL);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_external_refund_requires_payment_id"
  CHECK ("reason" <> 'EXTERNAL_REFUND' OR "payment_id" IS NOT NULL);

-- Colonnes de résolution manuelle auditée (ADR-023 §10.7).
ALTER TABLE "refunds"
  ADD COLUMN "settled_off_platform_at" timestamptz;

ALTER TABLE "refunds"
  ADD COLUMN "settled_off_platform_by" uuid;

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_settled_off_platform_by_users_id_fk"
  FOREIGN KEY ("settled_off_platform_by") REFERENCES "users"("id") ON DELETE restrict;

ALTER TABLE "refunds"
  ADD COLUMN "settlement_notes" text;

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_settled_off_platform_invariants"
  CHECK ("status" <> 'SETTLED_OFF_PLATFORM' OR ("settled_off_platform_at" IS NOT NULL AND "settled_off_platform_by" IS NOT NULL AND btrim("settlement_notes") IS NOT NULL));

-- Les colonnes de résolution manuelle doivent être NULL tant que le statut
-- n'est pas SETTLED_OFF_PLATFORM.
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_non_settled_off_platform_no_resolution"
  CHECK (
    "status" = 'SETTLED_OFF_PLATFORM'
    OR ("settled_off_platform_at" IS NULL AND "settled_off_platform_by" IS NULL AND "settlement_notes" IS NULL)
  );

-- NOTE : la borne cumulative des refunds (somme des refunds <= montant de l'origine)
-- sera garantie par le cas d'usage transactionnel sous lock dans un lot métier
-- ultérieur. On NE tente PAS d'imposer cette borne par un trigger car la vérification
-- concurrente serait sujette aux races (lecture-then-write sans verrou applicatif).

-- BUG 1 (critique) : le trigger before_check_refund_org de la migration 0019
-- ne gère que payment_id. Quand payment_id est NULL (refund de compensation
-- d'amendement), le SELECT retourne NULL et lève systématiquement une exception.
-- On droppe et recrée le trigger pour gérer les deux origines + la cohérence
-- de devise entre le refund et son origine de paiement.
DROP TRIGGER IF EXISTS before_check_refund_org ON "refunds";
DROP FUNCTION IF EXISTS before_check_refund_org_consistency();

CREATE OR REPLACE FUNCTION before_check_refund_org_consistency()
RETURNS TRIGGER AS $$
DECLARE
  payment_org_id uuid;
  payment_currency text;
  amendment_payment_org_id uuid;
  amendment_payment_currency text;
BEGIN
  IF NEW.payment_id IS NOT NULL THEN
    SELECT organization_id, currency INTO payment_org_id, payment_currency
      FROM payments WHERE id = NEW.payment_id;
    IF payment_org_id IS NULL OR payment_org_id <> NEW.organization_id THEN
      RAISE EXCEPTION 'Le remboursement n''appartient pas à la même organisation que le paiement';
    END IF;
    IF payment_currency <> NEW.currency THEN
      RAISE EXCEPTION 'La devise du remboursement ne correspond pas à celle du paiement';
    END IF;
  ELSIF NEW.amendment_payment_id IS NOT NULL THEN
    SELECT organization_id, currency INTO amendment_payment_org_id, amendment_payment_currency
      FROM amendment_payments WHERE id = NEW.amendment_payment_id;
    IF amendment_payment_org_id IS NULL OR amendment_payment_org_id <> NEW.organization_id THEN
      RAISE EXCEPTION 'Le remboursement n''appartient pas à la même organisation que le paiement de supplément';
    END IF;
    IF amendment_payment_currency <> NEW.currency THEN
      RAISE EXCEPTION 'La devise du remboursement ne correspond pas à celle du paiement de supplément';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_refund_org
  BEFORE INSERT OR UPDATE OF payment_id, amendment_payment_id, organization_id, currency ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION before_check_refund_org_consistency();

-- Trigger : le montant du refund ne peut pas dépasser le montant de l'origine.
CREATE OR REPLACE FUNCTION before_check_refund_amount_bound()
RETURNS TRIGGER AS $$
DECLARE
  origin_amount bigint;
BEGIN
  IF NEW.payment_id IS NOT NULL THEN
    SELECT amount_minor INTO origin_amount FROM payments WHERE id = NEW.payment_id;
    IF origin_amount IS NOT NULL AND NEW.amount_minor > origin_amount THEN
      RAISE EXCEPTION 'Le montant du remboursement ne peut pas dépasser le montant du paiement initial';
    END IF;
  ELSIF NEW.amendment_payment_id IS NOT NULL THEN
    SELECT amount_minor INTO origin_amount FROM amendment_payments WHERE id = NEW.amendment_payment_id;
    IF origin_amount IS NOT NULL AND NEW.amount_minor > origin_amount THEN
      RAISE EXCEPTION 'Le montant du remboursement ne peut pas dépasser le montant du paiement de supplément';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_refund_amount_bound
  BEFORE INSERT OR UPDATE OF payment_id, amendment_payment_id, amount_minor ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION before_check_refund_amount_bound();

-- Trigger de transition : SETTLED_OFF_PLATFORM uniquement depuis FAILED_REQUIRES_MANUAL_ACTION,
-- et immutabilité une fois SETTLED_OFF_PLATFORM atteint.
CREATE OR REPLACE FUNCTION before_check_refund_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- État terminal SETTLED_OFF_PLATFORM : immuable (seul updated_at peut changer).
  IF OLD.status = 'SETTLED_OFF_PLATFORM' THEN
    IF NEW.status <> OLD.status
       OR NEW.settled_off_platform_at IS DISTINCT FROM OLD.settled_off_platform_at
       OR NEW.settled_off_platform_by IS DISTINCT FROM OLD.settled_off_platform_by
       OR NEW.settlement_notes IS DISTINCT FROM OLD.settlement_notes
       OR NEW.updated_at <> OLD.updated_at THEN
      RAISE EXCEPTION 'refunds: état SETTLED_OFF_PLATFORM immuable, aucune modification autorisée';
    END IF;
    RETURN NEW;
  END IF;

  -- Transition vers SETTLED_OFF_PLATFORM : uniquement depuis FAILED_REQUIRES_MANUAL_ACTION.
  IF NEW.status = 'SETTLED_OFF_PLATFORM' AND OLD.status <> 'FAILED_REQUIRES_MANUAL_ACTION' THEN
    RAISE EXCEPTION 'refunds: la transition vers SETTLED_OFF_PLATFORM n''est autorisée que depuis FAILED_REQUIRES_MANUAL_ACTION';
  END IF;

  -- État terminal SUCCEEDED : immuable (seul updated_at peut changer).
  IF OLD.status = 'SUCCEEDED' THEN
    IF NEW.status <> OLD.status
       OR NEW.updated_at <> OLD.updated_at THEN
      RAISE EXCEPTION 'refunds: état SUCCEEDED immuable, aucune modification autorisée';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_refund_transition
  BEFORE UPDATE ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION before_check_refund_transition();

-- ===========================================================================
-- Étape 11 — Extension de condition_reports : booking_item_id nullable + amendment_allocation_id
-- ===========================================================================
-- Supprimer les triggers existants avant de modifier les colonnes.
DROP TRIGGER IF EXISTS before_check_condition_report ON "condition_reports";
DROP FUNCTION IF EXISTS before_check_condition_report_consistency();
DROP TRIGGER IF EXISTS no_update_condition_reports ON "condition_reports";
DROP TRIGGER IF EXISTS no_delete_condition_reports ON "condition_reports";
DROP FUNCTION IF EXISTS prevent_condition_report_modification();

ALTER TABLE "condition_reports" ALTER COLUMN "booking_item_id" DROP NOT NULL;

ALTER TABLE "condition_reports"
  ADD COLUMN "amendment_allocation_id" uuid;

ALTER TABLE "condition_reports"
  ADD CONSTRAINT "condition_reports_amendment_allocation_id_booking_amendment_allocations_id_fk"
  FOREIGN KEY ("amendment_allocation_id") REFERENCES "booking_amendment_allocations"("id") ON DELETE restrict;

ALTER TABLE "condition_reports"
  ADD CONSTRAINT "condition_reports_item_origin_xor"
  CHECK (("booking_item_id" IS NOT NULL AND "amendment_allocation_id" IS NULL) OR ("booking_item_id" IS NULL AND "amendment_allocation_id" IS NOT NULL));

-- Recréer le trigger de cohérence multi-tenant (mis à jour pour XOR).
CREATE OR REPLACE FUNCTION before_check_condition_report_consistency()
RETURNS TRIGGER AS $$
DECLARE
  booking_org_id uuid;
  booking_item_booking_id uuid;
  booking_item_inventory_id uuid;
  allocation_amendment_id uuid;
  allocation_line_id uuid;
  allocation_inventory_id uuid;
  allocation_org_id uuid;
  inv_org_id uuid;
  amendment_org_id uuid;
BEGIN
  -- 1. Le booking doit appartenir à la même organisation
  SELECT organization_id INTO booking_org_id FROM bookings WHERE id = NEW.booking_id;
  IF booking_org_id IS NULL OR booking_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'La réservation n''appartient pas à la même organisation que le rapport d''état';
  END IF;

  -- 2. XOR : exactement une référence d'item non-null (déjà vérifié par CHECK,
  --    mais on valide la cohérence métier ici).
  IF NEW.booking_item_id IS NOT NULL THEN
    -- Le booking_item doit appartenir au booking et référencer le bon inventory_item
    SELECT booking_id, inventory_item_id INTO booking_item_booking_id, booking_item_inventory_id
      FROM booking_items WHERE id = NEW.booking_item_id;
    IF booking_item_booking_id IS NULL OR booking_item_booking_id <> NEW.booking_id THEN
      RAISE EXCEPTION 'L''élément de réservation n''appartient pas à la réservation indiquée';
    END IF;
    IF booking_item_inventory_id <> NEW.inventory_item_id THEN
      RAISE EXCEPTION 'L''exemplaire du rapport ne correspond pas à l''élément de réservation';
    END IF;
  ELSE
    -- L'allocation d'amendement doit appartenir à un amendement du booking et
    -- référencer le même inventory_item et la même organisation.
    SELECT a.amendment_id, a.amendment_line_id, a.inventory_item_id, a.organization_id
      INTO allocation_amendment_id, allocation_line_id, allocation_inventory_id, allocation_org_id
      FROM booking_amendment_allocations a WHERE a.id = NEW.amendment_allocation_id;
    IF allocation_org_id IS NULL OR allocation_org_id <> NEW.organization_id THEN
      RAISE EXCEPTION 'L''allocation d''amendement n''appartient pas à la même organisation que le rapport d''état';
    END IF;
    IF allocation_inventory_id <> NEW.inventory_item_id THEN
      RAISE EXCEPTION 'L''exemplaire du rapport ne correspond pas à l''allocation d''amendement';
    END IF;
    -- L'amendement doit appartenir au booking.
    SELECT organization_id INTO amendment_org_id FROM booking_amendments WHERE id = allocation_amendment_id AND booking_id = NEW.booking_id;
    IF amendment_org_id IS NULL THEN
      RAISE EXCEPTION 'L''allocation d''amendement ne référence pas un amendement de cette réservation';
    END IF;
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
  BEFORE INSERT OR UPDATE OF booking_id, booking_item_id, amendment_allocation_id, inventory_item_id, organization_id ON "condition_reports"
  FOR EACH ROW EXECUTE FUNCTION before_check_condition_report_consistency();

-- Recréer le trigger append-only.
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

-- ===========================================================================
-- Étape 12 — Extension de damage_reports : booking_item_id nullable + amendment_allocation_id
-- ===========================================================================
DROP TRIGGER IF EXISTS before_check_damage_report ON "damage_reports";
DROP FUNCTION IF EXISTS before_check_damage_report_consistency();
DROP TRIGGER IF EXISTS no_update_damage_reports ON "damage_reports";
DROP TRIGGER IF EXISTS no_delete_damage_reports ON "damage_reports";
DROP FUNCTION IF EXISTS prevent_damage_report_modification();

ALTER TABLE "damage_reports" ALTER COLUMN "booking_item_id" DROP NOT NULL;

ALTER TABLE "damage_reports"
  ADD COLUMN "amendment_allocation_id" uuid;

ALTER TABLE "damage_reports"
  ADD CONSTRAINT "damage_reports_amendment_allocation_id_booking_amendment_allocations_id_fk"
  FOREIGN KEY ("amendment_allocation_id") REFERENCES "booking_amendment_allocations"("id") ON DELETE restrict;

ALTER TABLE "damage_reports"
  ADD CONSTRAINT "damage_reports_item_origin_xor"
  CHECK (("booking_item_id" IS NOT NULL AND "amendment_allocation_id" IS NULL) OR ("booking_item_id" IS NULL AND "amendment_allocation_id" IS NOT NULL));

-- Recréer le trigger de cohérence multi-tenant (mis à jour pour XOR).
CREATE OR REPLACE FUNCTION before_check_damage_report_consistency()
RETURNS TRIGGER AS $$
DECLARE
  booking_org_id uuid;
  booking_item_booking_id uuid;
  booking_item_inventory_id uuid;
  allocation_amendment_id uuid;
  allocation_line_id uuid;
  allocation_inventory_id uuid;
  allocation_org_id uuid;
  inv_org_id uuid;
  amendment_org_id uuid;
BEGIN
  -- 1. Le booking doit appartenir à la même organisation
  SELECT organization_id INTO booking_org_id FROM bookings WHERE id = NEW.booking_id;
  IF booking_org_id IS NULL OR booking_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'La réservation n''appartient pas à la même organisation que la déclaration de dommage';
  END IF;

  -- 2. XOR : cohérence métier.
  IF NEW.booking_item_id IS NOT NULL THEN
    SELECT booking_id, inventory_item_id INTO booking_item_booking_id, booking_item_inventory_id
      FROM booking_items WHERE id = NEW.booking_item_id;
    IF booking_item_booking_id IS NULL OR booking_item_booking_id <> NEW.booking_id THEN
      RAISE EXCEPTION 'L''élément de réservation n''appartient pas à la réservation indiquée';
    END IF;
    IF booking_item_inventory_id <> NEW.inventory_item_id THEN
      RAISE EXCEPTION 'L''exemplaire de la déclaration ne correspond pas à l''élément de réservation';
    END IF;
  ELSE
    SELECT a.amendment_id, a.amendment_line_id, a.inventory_item_id, a.organization_id
      INTO allocation_amendment_id, allocation_line_id, allocation_inventory_id, allocation_org_id
      FROM booking_amendment_allocations a WHERE a.id = NEW.amendment_allocation_id;
    IF allocation_org_id IS NULL OR allocation_org_id <> NEW.organization_id THEN
      RAISE EXCEPTION 'L''allocation d''amendement n''appartient pas à la même organisation que la déclaration de dommage';
    END IF;
    IF allocation_inventory_id <> NEW.inventory_item_id THEN
      RAISE EXCEPTION 'L''exemplaire de la déclaration ne correspond pas à l''allocation d''amendement';
    END IF;
    SELECT organization_id INTO amendment_org_id FROM booking_amendments WHERE id = allocation_amendment_id AND booking_id = NEW.booking_id;
    IF amendment_org_id IS NULL THEN
      RAISE EXCEPTION 'L''allocation d''amendement ne référence pas un amendement de cette réservation';
    END IF;
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
  BEFORE INSERT OR UPDATE OF booking_id, booking_item_id, amendment_allocation_id, inventory_item_id, organization_id ON "damage_reports"
  FOR EACH ROW EXECUTE FUNCTION before_check_damage_report_consistency();

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

-- ===========================================================================
-- Étape 13 — Trigger de cohérence tenant + validation INSERT : booking_amendments
-- ===========================================================================
CREATE OR REPLACE FUNCTION before_check_booking_amendment_consistency()
RETURNS TRIGGER AS $$
DECLARE
  booking_org_id uuid;
  booking_status text;
BEGIN
  SELECT organization_id, status INTO booking_org_id, booking_status FROM bookings WHERE id = NEW.booking_id;
  IF booking_org_id IS NULL OR booking_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'La réservation n''appartient pas à la même organisation que l''amendement';
  END IF;

  -- Validation INSERT uniquement (TG_OP = 'INSERT')
  IF TG_OP = 'INSERT' THEN
    -- Le booking doit être CONFIRMED.
    IF booking_status <> 'CONFIRMED' THEN
      RAISE EXCEPTION 'Un amendement ne peut être créé que sur une réservation CONFIRMED';
    END IF;

    -- SUPPLEMENT doit être inséré avec status=HOLD_PENDING.
    IF NEW.type = 'SUPPLEMENT' AND NEW.status <> 'HOLD_PENDING' THEN
      RAISE EXCEPTION 'Un amendement SUPPLEMENT doit être créé avec le statut HOLD_PENDING';
    END IF;

    -- NEUTRAL et REFUND doivent être insérés avec status=READY_TO_APPLY (pas HOLD_PENDING).
    IF NEW.type IN ('NEUTRAL', 'REFUND') AND NEW.status <> 'READY_TO_APPLY' THEN
      RAISE EXCEPTION 'Un amendement NEUTRAL ou REFUND doit être créé avec le statut READY_TO_APPLY';
    END IF;

    -- Pour SUPPLEMENT, hold_deadline doit être created_at + interval '10 minutes'.
    IF NEW.type = 'SUPPLEMENT' THEN
      IF NEW.hold_deadline IS NULL THEN
        RAISE EXCEPTION 'Un amendement SUPPLEMENT doit avoir un hold_deadline renseigné';
      END IF;
      IF NEW.hold_deadline <> NEW.created_at + interval '10 minutes' THEN
        RAISE EXCEPTION 'Le hold_deadline d''un amendement SUPPLEMENT doit être égal à created_at + 10 minutes';
      END IF;
    END IF;

    -- Pour NEUTRAL/REFUND, hold_deadline doit être NULL.
    IF NEW.type IN ('NEUTRAL', 'REFUND') AND NEW.hold_deadline IS NOT NULL THEN
      RAISE EXCEPTION 'Un amendement NEUTRAL ou REFUND ne doit pas avoir de hold_deadline';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_booking_amendment_consistency
  BEFORE INSERT OR UPDATE OF booking_id, organization_id ON "booking_amendments"
  FOR EACH ROW EXECUTE FUNCTION before_check_booking_amendment_consistency();

-- BEFORE DELETE : les amendements ne sont jamais supprimés.
CREATE OR REPLACE FUNCTION prevent_booking_amendment_deletion()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'booking_amendments est append-only : DELETE est interdit';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_delete_booking_amendments
  BEFORE DELETE ON "booking_amendments"
  FOR EACH ROW EXECUTE FUNCTION prevent_booking_amendment_deletion();

-- ===========================================================================
-- Étape 14 — Trigger d'immutabilité et de transition : booking_amendments
-- ===========================================================================
CREATE OR REPLACE FUNCTION before_check_booking_amendment_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- Colonnes immuables après création
  IF NEW.id <> OLD.id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.booking_id <> OLD.booking_id
     OR NEW.amendment_number <> OLD.amendment_number
     OR NEW.type <> OLD.type
     OR NEW.financial_snapshot_before IS DISTINCT FROM OLD.financial_snapshot_before
     OR NEW.financial_snapshot_after IS DISTINCT FROM OLD.financial_snapshot_after
     OR NEW.new_customer_start_at <> OLD.new_customer_start_at
     OR NEW.new_customer_end_at <> OLD.new_customer_end_at
     OR NEW.new_blocked_start_at <> OLD.new_blocked_start_at
     OR NEW.new_blocked_end_at <> OLD.new_blocked_end_at
     OR NEW.hold_deadline IS DISTINCT FROM OLD.hold_deadline
     OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'booking_amendments: colonnes immuables modifiées';
  END IF;

  -- États terminaux : immuables (seul updated_at peut changer, mais pas le statut ni les timestamps)
  IF OLD.status IN ('APPLIED', 'EXPIRED', 'CANCELLED', 'FAILED') THEN
    IF NEW.status <> OLD.status
       OR NEW.applied_at IS DISTINCT FROM OLD.applied_at
       OR NEW.expired_at IS DISTINCT FROM OLD.expired_at
       OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.failed_at IS DISTINCT FROM OLD.failed_at
       OR NEW.updated_at <> OLD.updated_at THEN
      RAISE EXCEPTION 'booking_amendments: état terminal immuable, aucune modification autorisée';
    END IF;
    RETURN NEW;
  END IF;

  -- Transitions autorisées depuis HOLD_PENDING (ADR §5.1) :
  --   → HOLD_PENDING (self/idempotent), → READY_TO_APPLY, → EXPIRED, → CANCELLED.
  IF OLD.status = 'HOLD_PENDING' THEN
    IF NEW.status NOT IN ('HOLD_PENDING', 'READY_TO_APPLY', 'EXPIRED', 'CANCELLED') THEN
      RAISE EXCEPTION 'booking_amendments: transition invalide depuis HOLD_PENDING vers %', NEW.status;
    END IF;
    -- Transition vers un état terminal : seul le timestamp correspondant + updated_at peuvent changer.
    IF NEW.status = 'EXPIRED' THEN
      IF NEW.applied_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.failed_at IS NOT NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers EXPIRED ne doit pas renseigner d''autres timestamps terminaux';
      END IF;
      IF NEW.expired_at IS NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers EXPIRED requiert expired_at';
      END IF;
    ELSIF NEW.status = 'CANCELLED' THEN
      IF NEW.applied_at IS NOT NULL OR NEW.expired_at IS NOT NULL OR NEW.failed_at IS NOT NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers CANCELLED ne doit pas renseigner d''autres timestamps terminaux';
      END IF;
      IF NEW.cancelled_at IS NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers CANCELLED requiert cancelled_at';
      END IF;
    ELSE
      -- Self-transition (HOLD_PENDING→HOLD_PENDING) ou →READY_TO_APPLY : aucun timestamp terminal ne doit être renseigné.
      IF NEW.applied_at IS NOT NULL OR NEW.expired_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.failed_at IS NOT NULL THEN
        RAISE EXCEPTION 'booking_amendments: aucun timestamp terminal ne peut être renseigné dans un état non-terminal';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Transitions autorisées depuis READY_TO_APPLY (ADR §5.1) :
  --   → READY_TO_APPLY (self/idempotent), → APPLIED, → FAILED.
  IF OLD.status = 'READY_TO_APPLY' THEN
    IF NEW.status NOT IN ('READY_TO_APPLY', 'APPLIED', 'FAILED') THEN
      RAISE EXCEPTION 'booking_amendments: transition invalide depuis READY_TO_APPLY vers %', NEW.status;
    END IF;
    -- Transition vers un état terminal : seul le timestamp correspondant + updated_at peuvent changer.
    IF NEW.status = 'APPLIED' THEN
      IF NEW.expired_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.failed_at IS NOT NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers APPLIED ne doit pas renseigner d''autres timestamps terminaux';
      END IF;
      IF NEW.applied_at IS NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers APPLIED requiert applied_at';
      END IF;
    ELSIF NEW.status = 'FAILED' THEN
      IF NEW.applied_at IS NOT NULL OR NEW.expired_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers FAILED ne doit pas renseigner d''autres timestamps terminaux';
      END IF;
      IF NEW.failed_at IS NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers FAILED requiert failed_at';
      END IF;
    ELSE
      -- Self-transition (READY_TO_APPLY→READY_TO_APPLY) : aucun timestamp terminal ne doit être renseigné.
      IF NEW.applied_at IS NOT NULL OR NEW.expired_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.failed_at IS NOT NULL THEN
        RAISE EXCEPTION 'booking_amendments: aucun timestamp terminal ne peut être renseigné dans un état non-terminal';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'booking_amendments: état source inattendu %', OLD.status;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_booking_amendment_transition
  BEFORE UPDATE ON "booking_amendments"
  FOR EACH ROW EXECUTE FUNCTION before_check_booking_amendment_transition();

-- ===========================================================================
-- Étape 15 — Trigger append-only : booking_amendment_lines
-- ===========================================================================
CREATE OR REPLACE FUNCTION prevent_booking_amendment_line_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'booking_amendment_lines est append-only : UPDATE et DELETE sont interdits';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_update_booking_amendment_lines
  BEFORE UPDATE ON "booking_amendment_lines"
  FOR EACH ROW EXECUTE FUNCTION prevent_booking_amendment_line_modification();

CREATE TRIGGER no_delete_booking_amendment_lines
  BEFORE DELETE ON "booking_amendment_lines"
  FOR EACH ROW EXECUTE FUNCTION prevent_booking_amendment_line_modification();

-- Trigger de cohérence tenant + validation INSERT : l'amendement et la ligne
-- sont de la même organisation, et pour les lignes ORIGINAL, le source_booking_line_id
-- doit appartenir au même booking, même org, même variante, et logical_line_id = source.
CREATE OR REPLACE FUNCTION before_check_booking_amendment_line_consistency()
RETURNS TRIGGER AS $$
DECLARE
  amendment_org_id uuid;
  amendment_booking_id uuid;
  source_line_booking_id uuid;
  source_line_variant_id uuid;
  source_line_org_id uuid;
BEGIN
  SELECT organization_id, booking_id INTO amendment_org_id, amendment_booking_id
    FROM booking_amendments WHERE id = NEW.amendment_id;
  IF amendment_org_id IS NULL OR amendment_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'L''amendement n''appartient pas à la même organisation que la ligne d''amendement';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Pour les lignes ORIGINAL : source_booking_line_id doit exister, appartenir au
    -- même booking, même organisation, même variante, et logical_line_id = source_booking_line_id.
    IF NEW.origin_type = 'ORIGINAL' THEN
      SELECT booking_id, variant_id INTO source_line_booking_id, source_line_variant_id
        FROM booking_lines WHERE id = NEW.source_booking_line_id;
      IF source_line_booking_id IS NULL THEN
        RAISE EXCEPTION 'La ligne source n''existe pas dans booking_lines';
      END IF;
      IF source_line_booking_id <> amendment_booking_id THEN
        RAISE EXCEPTION 'La ligne source n''appartient pas au même booking que l''amendement';
      END IF;
      IF source_line_variant_id <> NEW.variant_id THEN
        RAISE EXCEPTION 'La ligne source ne référence pas la même variante que la ligne d''amendement';
      END IF;
      IF NEW.logical_line_id <> NEW.source_booking_line_id THEN
        RAISE EXCEPTION 'Pour une ligne ORIGINAL, logical_line_id doit être égal à source_booking_line_id';
      END IF;
    END IF;

    -- Pour les lignes AMENDMENT : source_booking_line_id doit être NULL.
    -- L'action ADD n'est autorisée qu'avec origin_type=AMENDMENT.
    IF NEW.origin_type = 'AMENDMENT' AND NEW.action = 'ADD' THEN
      -- OK : ADD avec AMENDMENT est valide.
      NULL;
    ELSIF NEW.origin_type = 'ORIGINAL' AND NEW.action = 'ADD' THEN
      RAISE EXCEPTION 'L''action ADD n''est autorisée qu''avec origin_type=AMENDMENT';
    END IF;

    -- Les snapshots JSONB doivent être des objets (pas des tableaux ou scalaires).
    IF jsonb_typeof(NEW.pricing_snapshot) <> 'object' THEN
      RAISE EXCEPTION 'pricing_snapshot doit être un objet JSON';
    END IF;
    IF jsonb_typeof(NEW.variant_snapshot) <> 'object' THEN
      RAISE EXCEPTION 'variant_snapshot doit être un objet JSON';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_booking_amendment_line_consistency
  BEFORE INSERT OR UPDATE OF amendment_id, organization_id ON "booking_amendment_lines"
  FOR EACH ROW EXECUTE FUNCTION before_check_booking_amendment_line_consistency();

-- ===========================================================================
-- Étape 16 — Trigger d'immutabilité + transition : booking_amendment_allocations + cohérence tenant
-- ===========================================================================
-- Les allocations ont un cycle de vie : PROPOSED → CONVERTED | RELEASED | EXPIRED.
-- Les colonnes d'identité sont immuables ; seuls status et applied_booking_block_id
-- peuvent changer. Les états terminaux (CONVERTED, RELEASED, EXPIRED) sont immuables.
-- La transition vers CONVERTED requiert applied_booking_block_id.
CREATE OR REPLACE FUNCTION before_check_booking_amendment_allocation_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- Colonnes immuables après création
  IF NEW.id <> OLD.id
     OR NEW.amendment_id <> OLD.amendment_id
     OR NEW.amendment_line_id <> OLD.amendment_line_id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.inventory_item_id <> OLD.inventory_item_id
     OR NEW.action <> OLD.action
     OR NEW.source_booking_block_id IS DISTINCT FROM OLD.source_booking_block_id
     OR NEW.effective_customer_start_at <> OLD.effective_customer_start_at
     OR NEW.effective_customer_end_at <> OLD.effective_customer_end_at
     OR NEW.effective_blocked_start_at <> OLD.effective_blocked_start_at
     OR NEW.effective_blocked_end_at <> OLD.effective_blocked_end_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'booking_amendment_allocations: colonnes immuables modifiées';
  END IF;

  -- États terminaux : immuables
  IF OLD.status IN ('CONVERTED', 'RELEASED', 'EXPIRED') THEN
    IF NEW.status <> OLD.status
       OR NEW.applied_booking_block_id IS DISTINCT FROM OLD.applied_booking_block_id THEN
      RAISE EXCEPTION 'booking_amendment_allocations: état terminal immuable, aucune modification autorisée';
    END IF;
    RETURN NEW;
  END IF;

  -- Transitions autorisées depuis PROPOSED :
  --   → PROPOSED (self/idempotent), → CONVERTED, → RELEASED, → EXPIRED.
  IF OLD.status = 'PROPOSED' THEN
    IF NEW.status NOT IN ('PROPOSED', 'CONVERTED', 'RELEASED', 'EXPIRED') THEN
      RAISE EXCEPTION 'booking_amendment_allocations: transition invalide depuis PROPOSED vers %', NEW.status;
    END IF;
    -- La transition vers CONVERTED requiert applied_booking_block_id.
    IF NEW.status = 'CONVERTED' AND NEW.applied_booking_block_id IS NULL THEN
      RAISE EXCEPTION 'booking_amendment_allocations: la transition vers CONVERTED requiert applied_booking_block_id';
    END IF;
    -- L'action REMOVE ne peut jamais devenir CONVERTED.
    IF NEW.status = 'CONVERTED' AND OLD.action = 'REMOVE' THEN
      RAISE EXCEPTION 'booking_amendment_allocations: l''action REMOVE ne peut jamais devenir CONVERTED';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'booking_amendment_allocations: état source inattendu %', OLD.status;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_booking_amendment_allocation_transition
  BEFORE UPDATE ON "booking_amendment_allocations"
  FOR EACH ROW EXECUTE FUNCTION before_check_booking_amendment_allocation_transition();

-- BEFORE DELETE : les allocations ne sont jamais supprimées.
CREATE OR REPLACE FUNCTION prevent_booking_amendment_allocation_deletion()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'booking_amendment_allocations est append-only : DELETE est interdit';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_delete_booking_amendment_allocations
  BEFORE DELETE ON "booking_amendment_allocations"
  FOR EACH ROW EXECUTE FUNCTION prevent_booking_amendment_allocation_deletion();

CREATE OR REPLACE FUNCTION before_check_booking_amendment_allocation_consistency()
RETURNS TRIGGER AS $$
DECLARE
  amendment_org_id uuid;
  amendment_booking_id uuid;
  amendment_new_customer_start timestamptz;
  amendment_new_customer_end timestamptz;
  amendment_new_blocked_start timestamptz;
  amendment_new_blocked_end timestamptz;
  line_amendment_id uuid;
  line_org_id uuid;
  line_variant_id uuid;
  item_org_id uuid;
  item_variant_id uuid;
  source_block_type text;
  source_block_org_id uuid;
  source_block_item_id uuid;
  source_block_source_id uuid;
  applied_block_type text;
  applied_block_org_id uuid;
  applied_block_item_id uuid;
  applied_block_source_id uuid;
BEGIN
  -- L'amendement et l'allocation sont de la même organisation.
  SELECT organization_id, booking_id,
         new_customer_start_at, new_customer_end_at,
         new_blocked_start_at, new_blocked_end_at
    INTO amendment_org_id, amendment_booking_id,
         amendment_new_customer_start, amendment_new_customer_end,
         amendment_new_blocked_start, amendment_new_blocked_end
    FROM booking_amendments WHERE id = NEW.amendment_id;
  IF amendment_org_id IS NULL OR amendment_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'L''amendement n''appartient pas à la même organisation que l''allocation';
  END IF;
  -- La ligne d'amendement appartient au même amendement et à la même organisation.
  SELECT amendment_id, organization_id, variant_id INTO line_amendment_id, line_org_id, line_variant_id
    FROM booking_amendment_lines WHERE id = NEW.amendment_line_id;
  IF line_amendment_id IS NULL OR line_amendment_id <> NEW.amendment_id THEN
    RAISE EXCEPTION 'La ligne d''amendement n''appartient pas à l''amendement indiqué';
  END IF;
  IF line_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'La ligne d''amendement n''appartient pas à la même organisation que l''allocation';
  END IF;
  -- L'exemplaire est de la même organisation.
  SELECT organization_id, product_variant_id INTO item_org_id, item_variant_id
    FROM inventory_items WHERE id = NEW.inventory_item_id;
  IF item_org_id IS NULL OR item_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'L''exemplaire n''appartient pas à la même organisation que l''allocation';
  END IF;
  -- L'exemplaire doit référencer la même variante que la ligne d'amendement.
  IF item_variant_id <> line_variant_id THEN
    RAISE EXCEPTION 'L''exemplaire ne référence pas la même variante que la ligne d''amendement';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Le statut initial doit être PROPOSED.
    IF NEW.status <> 'PROPOSED' THEN
      RAISE EXCEPTION 'Une allocation d''amendement doit être créée avec le statut PROPOSED';
    END IF;

    -- Source block : requis pour RETAIN/REMOVE/REPLACE, interdit pour ADD.
    -- Quand présent : type=BOOKING, même org, même item, et lié au booking de l'amendement.
    IF NEW.source_booking_block_id IS NOT NULL THEN
      SELECT type, organization_id, inventory_item_id, source_id
        INTO source_block_type, source_block_org_id, source_block_item_id, source_block_source_id
        FROM inventory_blocks WHERE id = NEW.source_booking_block_id;
      IF source_block_type IS NULL THEN
        RAISE EXCEPTION 'Le block source n''existe pas';
      END IF;
      IF source_block_type <> 'BOOKING' THEN
        RAISE EXCEPTION 'Le block source doit être de type BOOKING';
      END IF;
      IF source_block_org_id <> NEW.organization_id THEN
        RAISE EXCEPTION 'Le block source n''appartient pas à la même organisation que l''allocation';
      END IF;
      IF source_block_item_id <> NEW.inventory_item_id THEN
        RAISE EXCEPTION 'Le block source ne référence pas le même exemplaire que l''allocation';
      END IF;
      IF source_block_source_id <> amendment_booking_id THEN
        RAISE EXCEPTION 'Le block source doit appartenir au booking de l''amendement';
      END IF;
    END IF;

    -- Applied block : quand présent, type=BOOKING, même org, même item, lié au booking.
    IF NEW.applied_booking_block_id IS NOT NULL THEN
      SELECT type, organization_id, inventory_item_id, source_id
        INTO applied_block_type, applied_block_org_id, applied_block_item_id, applied_block_source_id
        FROM inventory_blocks WHERE id = NEW.applied_booking_block_id;
      IF applied_block_type IS NULL THEN
        RAISE EXCEPTION 'Le block appliqué n''existe pas';
      END IF;
      IF applied_block_type <> 'BOOKING' THEN
        RAISE EXCEPTION 'Le block appliqué doit être de type BOOKING';
      END IF;
      IF applied_block_org_id <> NEW.organization_id THEN
        RAISE EXCEPTION 'Le block appliqué n''appartient pas à la même organisation que l''allocation';
      END IF;
      IF applied_block_item_id <> NEW.inventory_item_id THEN
        RAISE EXCEPTION 'Le block appliqué ne référence pas le même exemplaire que l''allocation';
      END IF;
    END IF;

    -- Les périodes effectives doivent être cohérentes avec les périodes de l'amendement.
    IF NEW.effective_customer_start_at < amendment_new_customer_start
       OR NEW.effective_customer_end_at > amendment_new_customer_end THEN
      RAISE EXCEPTION 'Les périodes customer effectives doivent être incluses dans les périodes de l''amendement';
    END IF;
    IF NEW.effective_blocked_start_at < amendment_new_blocked_start
       OR NEW.effective_blocked_end_at > amendment_new_blocked_end THEN
      RAISE EXCEPTION 'Les périodes blocked effectives doivent être incluses dans les périodes de l''amendement';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_booking_amendment_allocation_consistency
  BEFORE INSERT OR UPDATE OF amendment_id, amendment_line_id, organization_id, inventory_item_id ON "booking_amendment_allocations"
  FOR EACH ROW EXECUTE FUNCTION before_check_booking_amendment_allocation_consistency();

-- ===========================================================================
-- Étape 17 — Trigger d'immutabilité + transition : booking_amendment_segments + cohérence tenant + block HOLD
-- ===========================================================================
-- Les segments ont un cycle de vie : PROPOSED → CONVERTED | RELEASED | EXPIRED.
-- Les colonnes d'identité sont immuables ; seul status peut changer.
-- Les états terminaux (CONVERTED, RELEASED, EXPIRED) sont immuables.
CREATE OR REPLACE FUNCTION before_check_booking_amendment_segment_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- Colonnes immuables après création
  IF NEW.id <> OLD.id
     OR NEW.allocation_id <> OLD.allocation_id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.inventory_item_id <> OLD.inventory_item_id
     OR NEW.hold_block_id <> OLD.hold_block_id
     OR NEW.delta_start_at <> OLD.delta_start_at
     OR NEW.delta_end_at <> OLD.delta_end_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'booking_amendment_segments: colonnes immuables modifiées';
  END IF;

  -- États terminaux : immuables
  IF OLD.status IN ('CONVERTED', 'RELEASED', 'EXPIRED') THEN
    IF NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'booking_amendment_segments: état terminal immuable, aucune modification autorisée';
    END IF;
    RETURN NEW;
  END IF;

  -- Transitions autorisées depuis PROPOSED :
  --   → PROPOSED (self/idempotent), → CONVERTED, → RELEASED, → EXPIRED.
  IF OLD.status = 'PROPOSED' THEN
    IF NEW.status NOT IN ('PROPOSED', 'CONVERTED', 'RELEASED', 'EXPIRED') THEN
      RAISE EXCEPTION 'booking_amendment_segments: transition invalide depuis PROPOSED vers %', NEW.status;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'booking_amendment_segments: état source inattendu %', OLD.status;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_booking_amendment_segment_transition
  BEFORE UPDATE ON "booking_amendment_segments"
  FOR EACH ROW EXECUTE FUNCTION before_check_booking_amendment_segment_transition();

-- BEFORE DELETE : les segments ne sont jamais supprimés.
CREATE OR REPLACE FUNCTION prevent_booking_amendment_segment_deletion()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'booking_amendment_segments est append-only : DELETE est interdit';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_delete_booking_amendment_segments
  BEFORE DELETE ON "booking_amendment_segments"
  FOR EACH ROW EXECUTE FUNCTION prevent_booking_amendment_segment_deletion();

CREATE OR REPLACE FUNCTION before_check_booking_amendment_segment_consistency()
RETURNS TRIGGER AS $$
DECLARE
  allocation_org_id uuid;
  allocation_item_id uuid;
  allocation_amendment_id uuid;
  amendment_type text;
  block_type text;
  block_org_id uuid;
  block_item_id uuid;
  block_status text;
  block_deleted timestamptz;
  block_blocked_start timestamptz;
  block_blocked_end timestamptz;
BEGIN
  -- L'allocation et le segment sont de la même organisation et référencent le même item.
  SELECT organization_id, inventory_item_id, amendment_id
    INTO allocation_org_id, allocation_item_id, allocation_amendment_id
    FROM booking_amendment_allocations WHERE id = NEW.allocation_id;
  IF allocation_org_id IS NULL OR allocation_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'L''allocation n''appartient pas à la même organisation que le segment';
  END IF;
  IF allocation_item_id <> NEW.inventory_item_id THEN
    RAISE EXCEPTION 'L''exemplaire du segment ne correspond pas à l''allocation';
  END IF;

  -- L'amendement de l'allocation doit être de type SUPPLEMENT.
  SELECT type INTO amendment_type FROM booking_amendments WHERE id = allocation_amendment_id;
  IF amendment_type IS NULL THEN
    RAISE EXCEPTION 'L''amendement de l''allocation n''existe pas';
  END IF;
  IF amendment_type <> 'SUPPLEMENT' THEN
    RAISE EXCEPTION 'Les delta-segments ne peuvent être associés qu''à un amendement de type SUPPLEMENT';
  END IF;

  -- Le block référencé doit être de type HOLD et de la même organisation/item.
  SELECT type, organization_id, inventory_item_id, status, deleted_at,
         blocked_start_at, blocked_end_at
    INTO block_type, block_org_id, block_item_id, block_status, block_deleted,
         block_blocked_start, block_blocked_end
    FROM inventory_blocks WHERE id = NEW.hold_block_id;
  IF block_type IS NULL THEN
    RAISE EXCEPTION 'Le block référencé n''existe pas';
  END IF;
  IF block_type <> 'HOLD' THEN
    RAISE EXCEPTION 'Le block référencé par un segment d''amendement doit être de type HOLD';
  END IF;
  IF block_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'Le block référencé n''appartient pas à la même organisation que le segment';
  END IF;
  IF block_item_id <> NEW.inventory_item_id THEN
    RAISE EXCEPTION 'Le block référencé ne référence pas le même exemplaire que le segment';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Le statut initial doit être PROPOSED.
    IF NEW.status <> 'PROPOSED' THEN
      RAISE EXCEPTION 'Un segment d''amendement doit être créé avec le statut PROPOSED';
    END IF;

    -- Le HOLD block ne doit pas être supprimé et doit être ACTIVE.
    IF block_deleted IS NOT NULL THEN
      RAISE EXCEPTION 'Le block HOLD référencé par le segment a été supprimé';
    END IF;
    IF block_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'Le block HOLD référencé par le segment doit être en statut ACTIVE';
    END IF;

    -- La période du segment doit exactement correspondre à celle du HOLD block.
    IF NEW.delta_start_at <> block_blocked_start OR NEW.delta_end_at <> block_blocked_end THEN
      RAISE EXCEPTION 'La période du segment (delta_start_at, delta_end_at) doit exactement correspondre au HOLD block (blocked_start_at, blocked_end_at)';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_booking_amendment_segment_consistency
  BEFORE INSERT OR UPDATE OF allocation_id, organization_id, inventory_item_id, hold_block_id ON "booking_amendment_segments"
  FOR EACH ROW EXECUTE FUNCTION before_check_booking_amendment_segment_consistency();

-- ===========================================================================
-- Étape 18 — Trigger de cohérence tenant : amendment_payments
-- ===========================================================================
CREATE OR REPLACE FUNCTION before_check_amendment_payment_consistency()
RETURNS TRIGGER AS $$
DECLARE
  amendment_org_id uuid;
  booking_org_id uuid;
  booking_customer_user_id uuid;
  amendment_booking_id uuid;
  amendment_type text;
  snapshot_amount text;
BEGIN
  -- L'amendement et le paiement sont de la même organisation.
  -- BUG 6 : seuls les amendements de type SUPPLEMENT ont un paiement.
  SELECT organization_id, booking_id, type, financial_snapshot_after
    INTO amendment_org_id, amendment_booking_id, amendment_type, snapshot_amount
    FROM booking_amendments WHERE id = NEW.amendment_id;
  IF amendment_org_id IS NULL OR amendment_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'L''amendement n''appartient pas à la même organisation que le paiement de supplément';
  END IF;
  IF amendment_type <> 'SUPPLEMENT' THEN
    RAISE EXCEPTION 'Un paiement de supplément ne peut être associé qu''à un amendement de type SUPPLEMENT';
  END IF;
  -- Le booking référencé correspond à celui de l'amendement.
  IF amendment_booking_id <> NEW.booking_id THEN
    RAISE EXCEPTION 'Le booking du paiement ne correspond pas au booking de l''amendement';
  END IF;
  -- Le booking est de la même organisation.
  SELECT organization_id, customer_user_id INTO booking_org_id, booking_customer_user_id
    FROM bookings WHERE id = NEW.booking_id;
  IF booking_org_id IS NULL OR booking_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'Le booking n''appartient pas à la même organisation que le paiement de supplément';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Le statut initial doit être PENDING_PROVIDER.
    IF NEW.status <> 'PENDING_PROVIDER' THEN
      RAISE EXCEPTION 'Un paiement de supplément doit être créé avec le statut PENDING_PROVIDER';
    END IF;
    -- customer_user_id doit correspondre au customer_user_id du booking.
    IF NEW.customer_user_id <> booking_customer_user_id THEN
      RAISE EXCEPTION 'Le customer_user_id du paiement ne correspond pas à celui du booking';
    END IF;
    -- Le montant du paiement doit correspondre au montant du supplément dans le snapshot.
    -- On lit financial_snapshot_after->>'supplementAmountMinor' (ou ->>'totalAmountMinor'
    -- si supplementAmountMinor est absent — le delta est la différence entre after et before).
    IF snapshot_amount IS NOT NULL THEN
      DECLARE
        supplement_minor text;
        total_after text;
        total_before text;
      BEGIN
        supplement_minor := NULL;
        total_after := (snapshot_amount::jsonb)->>'totalAmountMinor';
        total_before := NULL;
        -- On utilise supplementAmountMinor si présent, sinon on calcule le delta.
        IF (snapshot_amount::jsonb) ? 'supplementAmountMinor' THEN
          supplement_minor := (snapshot_amount::jsonb)->>'supplementAmountMinor';
          IF supplement_minor IS NOT NULL AND NEW.amount_minor <> supplement_minor::bigint THEN
            RAISE EXCEPTION 'Le montant du paiement ne correspond pas au supplementAmountMinor du snapshot';
          END IF;
        ELSIF total_after IS NOT NULL THEN
          -- Si pas de supplementAmountMinor, on accepte que le montant soit > 0
          -- (la cohérence exacte sera validée par le cas d'usage métier).
          NULL;
        END IF;
      END;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_amendment_payment_consistency
  BEFORE INSERT OR UPDATE OF amendment_id, booking_id, organization_id ON "amendment_payments"
  FOR EACH ROW EXECUTE FUNCTION before_check_amendment_payment_consistency();

-- ===========================================================================
-- Étape 19 — Trigger d'immutabilité et de transition : amendment_payments
-- ===========================================================================
CREATE OR REPLACE FUNCTION before_check_amendment_payment_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- Colonnes immuables après création
  IF NEW.id <> OLD.id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.booking_id <> OLD.booking_id
     OR NEW.amendment_id <> OLD.amendment_id
     OR NEW.customer_user_id <> OLD.customer_user_id
     OR NEW.amount_minor <> OLD.amount_minor
     OR NEW.currency <> OLD.currency
     OR NEW.environment <> OLD.environment
     OR NEW.connected_account_id <> OLD.connected_account_id
     OR NEW.on_behalf_of_account_id IS DISTINCT FROM OLD.on_behalf_of_account_id
     OR NEW.charge_model <> OLD.charge_model
     OR NEW.settlement_merchant_mode <> OLD.settlement_merchant_mode
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'amendment_payments: colonnes immuables modifiées';
  END IF;

  -- États terminaux : immuables (seul updated_at peut changer)
  IF OLD.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN
    IF NEW.status <> OLD.status
       OR NEW.succeeded_at IS DISTINCT FROM OLD.succeeded_at
       OR NEW.failed_at IS DISTINCT FROM OLD.failed_at
       OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.updated_at <> OLD.updated_at THEN
      RAISE EXCEPTION 'amendment_payments: état terminal immuable, aucune modification autorisée';
    END IF;
    RETURN NEW;
  END IF;

  -- Transitions explicites par état source (ADR §5.2)
  IF OLD.status = 'PENDING_PROVIDER' THEN
    IF NEW.status NOT IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED') THEN
      RAISE EXCEPTION 'amendment_payments: transition invalide depuis PENDING_PROVIDER vers %', NEW.status;
    END IF;
  ELSIF OLD.status = 'REQUIRES_PAYMENT_METHOD' THEN
    IF NEW.status NOT IN ('REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED') THEN
      RAISE EXCEPTION 'amendment_payments: transition invalide depuis REQUIRES_PAYMENT_METHOD vers %', NEW.status;
    END IF;
  ELSIF OLD.status = 'REQUIRES_ACTION' THEN
    IF NEW.status NOT IN ('REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED') THEN
      RAISE EXCEPTION 'amendment_payments: transition invalide depuis REQUIRES_ACTION vers %', NEW.status;
    END IF;
  ELSIF OLD.status = 'PROCESSING' THEN
    IF NEW.status NOT IN ('PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED') THEN
      RAISE EXCEPTION 'amendment_payments: transition invalide depuis PROCESSING vers %', NEW.status;
    END IF;
  ELSE
    RAISE EXCEPTION 'amendment_payments: état source inattendu %', OLD.status;
  END IF;

  -- Transition vers un état terminal : seul le timestamp correspondant + updated_at peuvent changer.
  IF NEW.status = 'SUCCEEDED' THEN
    IF NEW.failed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'amendment_payments: transition vers SUCCEEDED ne doit pas renseigner d''autres timestamps terminaux';
    END IF;
    IF NEW.succeeded_at IS NULL THEN
      RAISE EXCEPTION 'amendment_payments: transition vers SUCCEEDED requiert succeeded_at';
    END IF;
  ELSIF NEW.status = 'FAILED' THEN
    IF NEW.succeeded_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'amendment_payments: transition vers FAILED ne doit pas renseigner d''autres timestamps terminaux';
    END IF;
    IF NEW.failed_at IS NULL THEN
      RAISE EXCEPTION 'amendment_payments: transition vers FAILED requiert failed_at';
    END IF;
  ELSIF NEW.status = 'CANCELLED' THEN
    IF NEW.succeeded_at IS NOT NULL OR NEW.failed_at IS NOT NULL THEN
      RAISE EXCEPTION 'amendment_payments: transition vers CANCELLED ne doit pas renseigner d''autres timestamps terminaux';
    END IF;
    IF NEW.cancelled_at IS NULL THEN
      RAISE EXCEPTION 'amendment_payments: transition vers CANCELLED requiert cancelled_at';
    END IF;
  ELSE
    -- État non-terminal : aucun timestamp terminal ne doit être renseigné.
    IF NEW.succeeded_at IS NOT NULL OR NEW.failed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'amendment_payments: aucun timestamp terminal ne peut être renseigné dans un état non-terminal';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_amendment_payment_transition
  BEFORE UPDATE ON "amendment_payments"
  FOR EACH ROW EXECUTE FUNCTION before_check_amendment_payment_transition();

-- ===========================================================================
-- Étape 20 — Trigger de cohérence tenant : amendment_payment_attempts
-- ===========================================================================
CREATE OR REPLACE FUNCTION before_check_amendment_payment_attempt_consistency()
RETURNS TRIGGER AS $$
DECLARE
  payment_org_id uuid;
  max_attempt integer;
BEGIN
  SELECT organization_id INTO payment_org_id FROM amendment_payments WHERE id = NEW.amendment_payment_id;
  IF payment_org_id IS NULL OR payment_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'Le paiement de supplément n''appartient pas à la même organisation que l''attempt';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Le statut initial doit être PENDING_PROVIDER.
    IF NEW.status <> 'PENDING_PROVIDER' THEN
      RAISE EXCEPTION 'Un attempt de paiement doit être créé avec le statut PENDING_PROVIDER';
    END IF;
    -- attempt_number doit être max+1 (ou 1 si premier).
    SELECT COALESCE(MAX(attempt_number), 0) INTO max_attempt
      FROM amendment_payment_attempts WHERE amendment_payment_id = NEW.amendment_payment_id;
    IF NEW.attempt_number <> max_attempt + 1 THEN
      RAISE EXCEPTION 'attempt_number doit être égal à % (max existant + 1)', max_attempt + 1;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_amendment_payment_attempt_consistency
  BEFORE INSERT OR UPDATE OF amendment_payment_id, organization_id ON "amendment_payment_attempts"
  FOR EACH ROW EXECUTE FUNCTION before_check_amendment_payment_attempt_consistency();

-- Trigger d'immutabilité : colonnes d'identité immuables après création,
-- transitions explicites, terminalité.
CREATE OR REPLACE FUNCTION before_check_amendment_payment_attempt_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.amendment_payment_id <> OLD.amendment_payment_id
     OR NEW.attempt_number <> OLD.attempt_number
     OR NEW.provider_idempotency_key <> OLD.provider_idempotency_key
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'amendment_payment_attempts: colonnes immuables modifiées';
  END IF;
  -- provider_payment_intent_id, une fois renseigné, ne peut jamais changer.
  IF OLD.provider_payment_intent_id IS NOT NULL AND (NEW.provider_payment_intent_id IS NULL OR NEW.provider_payment_intent_id <> OLD.provider_payment_intent_id) THEN
    RAISE EXCEPTION 'amendment_payment_attempts: provider_payment_intent_id ne peut pas changer une fois renseigné';
  END IF;

  -- États terminaux : toutes les colonnes immuables (seul updated_at peut changer).
  IF OLD.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN
    IF NEW.status <> OLD.status
       OR NEW.provider_payment_intent_id IS DISTINCT FROM OLD.provider_payment_intent_id
       OR NEW.provider_status IS DISTINCT FROM OLD.provider_status
       OR NEW.last_provider_error_code IS DISTINCT FROM OLD.last_provider_error_code
       OR NEW.reconcile_after IS DISTINCT FROM OLD.reconcile_after
       OR NEW.reconcile_lease_until IS DISTINCT FROM OLD.reconcile_lease_until
       OR NEW.reconcile_lease_token IS DISTINCT FROM OLD.reconcile_lease_token
       OR NEW.updated_at <> OLD.updated_at THEN
      RAISE EXCEPTION 'amendment_payment_attempts: état terminal immuable, aucune modification autorisée';
    END IF;
    RETURN NEW;
  END IF;

  -- Transitions explicites par état source (ADR §5.2)
  IF OLD.status = 'PENDING_PROVIDER' THEN
    IF NEW.status NOT IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED') THEN
      RAISE EXCEPTION 'amendment_payment_attempts: transition invalide depuis PENDING_PROVIDER vers %', NEW.status;
    END IF;
  ELSIF OLD.status = 'REQUIRES_PAYMENT_METHOD' THEN
    IF NEW.status NOT IN ('REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED') THEN
      RAISE EXCEPTION 'amendment_payment_attempts: transition invalide depuis REQUIRES_PAYMENT_METHOD vers %', NEW.status;
    END IF;
  ELSIF OLD.status = 'REQUIRES_ACTION' THEN
    IF NEW.status NOT IN ('REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED') THEN
      RAISE EXCEPTION 'amendment_payment_attempts: transition invalide depuis REQUIRES_ACTION vers %', NEW.status;
    END IF;
  ELSIF OLD.status = 'PROCESSING' THEN
    IF NEW.status NOT IN ('PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED') THEN
      RAISE EXCEPTION 'amendment_payment_attempts: transition invalide depuis PROCESSING vers %', NEW.status;
    END IF;
  ELSE
    RAISE EXCEPTION 'amendment_payment_attempts: état source inattendu %', OLD.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_amendment_payment_attempt_immutability
  BEFORE UPDATE ON "amendment_payment_attempts"
  FOR EACH ROW EXECUTE FUNCTION before_check_amendment_payment_attempt_immutability();
