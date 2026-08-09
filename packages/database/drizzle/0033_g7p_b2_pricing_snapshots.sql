-- Migration 0033 : G7P-B2-A — fondations des snapshots de prix flexibles.
--
-- Étend booking_drafts, booking_draft_lines, bookings et booking_lines avec
-- les colonnes de snapshot de prix flexible (ADR-018, G7P-B2-A).
--
-- Deux versions de snapshot coexistent :
-- - legacy-daily-v1 : snapshots existants (modèle journalier ADR-009).
-- - flexible-pricing-v1 : nouveaux snapshots flexibles (moteur G7P-B1).
--
-- Les snapshots legacy restent lisibles ; aucune conversion n'est tentée.
-- Les nouvelles colonnes sont nullable pour les lignes legacy, requises (via
-- CHECK conditionnel) pour les lignes flexibles.
--
-- G7P-B2-A = schéma + contraintes + triggers + tests uniquement.
-- G7P-B2-B (intégration dans createBookingDraftWithHold) en correction Round 2.
-- G7P-B2-C (migration des flux existants) non démarré.
--
-- G7P-B2-B Round 2 — corrections :
-- - Validation du snapshot de fenêtre (PricingWindowSnapshot) dans le trigger
--   enforce_draft_line_pricing_coherence (Defect 2).
-- - DAY_RANGE DAILY exige un snapshot DAY_RANGE_BOUNDARIES non-null.
-- - DAY_RANGE avec snapshot TIME_RANGE_WINDOW → rejeté.
-- - TIME_RANGE avec snapshot DAY_RANGE_BOUNDARIES → rejeté.
-- - kind inconnu ou structure partielle → rejeté.
-- - firstDay.localDate / lastDay.localDate vérifiés contre l'intent snapshot.

-- ========================================================================
-- 1. Nouvelles colonnes sur booking_drafts
-- ========================================================================

ALTER TABLE "booking_drafts" ADD COLUMN "pricing_snapshot_version" text NOT NULL DEFAULT 'legacy-daily-v1';
ALTER TABLE "booking_drafts" ADD COLUMN "pricing_algorithm_version" text;
ALTER TABLE "booking_drafts" ADD COLUMN "pricing_rounding_rule_version" text;
ALTER TABLE "booking_drafts" ADD COLUMN "pricing_intent_type" text;
ALTER TABLE "booking_drafts" ADD COLUMN "pricing_intent_snapshot" jsonb;
ALTER TABLE "booking_drafts" ADD COLUMN "pricing_resolved_locale" text;

-- ========================================================================
-- 2. Nouvelles colonnes sur booking_draft_lines
-- ========================================================================

ALTER TABLE "booking_draft_lines" ADD COLUMN "pricing_plan_id" uuid;
ALTER TABLE "booking_draft_lines" ADD COLUMN "pricing_plan_version" integer;
ALTER TABLE "booking_draft_lines" ADD COLUMN "pricing_plan_type" text;
ALTER TABLE "booking_draft_lines" ADD COLUMN "pricing_public_label" text;
ALTER TABLE "booking_draft_lines" ADD COLUMN "pricing_requested_duration_minutes" integer;
ALTER TABLE "booking_draft_lines" ADD COLUMN "pricing_billed_duration_minutes" integer;
ALTER TABLE "booking_draft_lines" ADD COLUMN "pricing_covered_duration_minutes" integer;
ALTER TABLE "booking_draft_lines" ADD COLUMN "pricing_billed_days" integer;
ALTER TABLE "booking_draft_lines" ADD COLUMN "pricing_selected_window" jsonb;
ALTER TABLE "booking_draft_lines" ADD COLUMN "pricing_discount_threshold_days" integer;
ALTER TABLE "booking_draft_lines" ADD COLUMN "pricing_discount_percent" integer;
ALTER TABLE "booking_draft_lines" ADD COLUMN "pricing_amount_before_discount_minor" bigint;
ALTER TABLE "booking_draft_lines" ADD COLUMN "pricing_amount_after_discount_minor" bigint;

-- ========================================================================
-- 3. Nouvelles colonnes sur bookings
-- ========================================================================

ALTER TABLE "bookings" ADD COLUMN "pricing_snapshot_version" text NOT NULL DEFAULT 'legacy-daily-v1';
ALTER TABLE "bookings" ADD COLUMN "pricing_algorithm_version" text;
ALTER TABLE "bookings" ADD COLUMN "pricing_rounding_rule_version" text;
ALTER TABLE "bookings" ADD COLUMN "pricing_intent_type" text;
ALTER TABLE "bookings" ADD COLUMN "pricing_intent_snapshot" jsonb;
ALTER TABLE "bookings" ADD COLUMN "pricing_resolved_locale" text;

-- ========================================================================
-- 4. Nouvelles colonnes sur booking_lines
-- ========================================================================

ALTER TABLE "booking_lines" ADD COLUMN "pricing_plan_id" uuid;
ALTER TABLE "booking_lines" ADD COLUMN "pricing_plan_version" integer;
ALTER TABLE "booking_lines" ADD COLUMN "pricing_plan_type" text;
ALTER TABLE "booking_lines" ADD COLUMN "pricing_public_label" text;
ALTER TABLE "booking_lines" ADD COLUMN "pricing_requested_duration_minutes" integer;
ALTER TABLE "booking_lines" ADD COLUMN "pricing_billed_duration_minutes" integer;
ALTER TABLE "booking_lines" ADD COLUMN "pricing_covered_duration_minutes" integer;
ALTER TABLE "booking_lines" ADD COLUMN "pricing_billed_days" integer;
ALTER TABLE "booking_lines" ADD COLUMN "pricing_selected_window" jsonb;
ALTER TABLE "booking_lines" ADD COLUMN "pricing_discount_threshold_days" integer;
ALTER TABLE "booking_lines" ADD COLUMN "pricing_discount_percent" integer;
ALTER TABLE "booking_lines" ADD COLUMN "pricing_amount_before_discount_minor" bigint;
ALTER TABLE "booking_lines" ADD COLUMN "pricing_amount_after_discount_minor" bigint;
-- source_draft_line_id : la copie en booking_line verrouille la source en FOR SHARE
-- avant toute modification/ suppression (ordre : source FOR SHARE, puis UPDATE/DELETE).
ALTER TABLE "booking_lines" ADD COLUMN "source_draft_line_id" uuid;

-- 4a. FK + unicité sur source_draft_line_id
ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_source_draft_line_id_fk"
  FOREIGN KEY ("source_draft_line_id") REFERENCES "booking_draft_lines"("id")
  DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX "booking_lines_source_draft_line_id_unique"
  ON "booking_lines" ("source_draft_line_id");

-- 4b. Colonnes manquantes sur bookings (héritées de booking_drafts pour la cohérence legacy)
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "timezone" text NOT NULL DEFAULT 'UTC';
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "billable_unit" text NOT NULL DEFAULT 'DAY';
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "billable_unit_count" integer NOT NULL DEFAULT 1;

-- ========================================================================
-- 5. Contraintes CHECK sur booking_drafts
-- ========================================================================

-- Remplacer la contrainte billable_unit = 'DAY' par une contrainte
-- conditionnelle : legacy-daily-v1 exige DAY, flexible autorise d'autres unités.
ALTER TABLE "booking_drafts" DROP CONSTRAINT IF EXISTS "booking_drafts_billable_unit_day";

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_billable_unit_valid"
  CHECK ("billable_unit" IN ('DAY', 'HOURLY', 'FIXED_DURATION', 'DAILY', 'MINUTE'));

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_legacy_billable_unit_day"
  CHECK ("pricing_snapshot_version" <> 'legacy-daily-v1' OR "billable_unit" = 'DAY');

-- G7P-B2-B : billable_unit sémantique pour les drafts flexibles
-- TIME_RANGE → MINUTE, DAY_RANGE → DAY
ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_flexible_billable_unit_by_intent"
  CHECK (
    "pricing_snapshot_version" <> 'flexible-pricing-v1' OR
    ("pricing_intent_type" <> 'TIME_RANGE' OR "billable_unit" = 'MINUTE') AND
    ("pricing_intent_type" <> 'DAY_RANGE' OR "billable_unit" = 'DAY')
  );

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_pricing_snapshot_version_valid"
  CHECK ("pricing_snapshot_version" IN ('legacy-daily-v1', 'flexible-pricing-v1'));

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_pricing_intent_type_valid"
  CHECK ("pricing_intent_type" IS NULL OR "pricing_intent_type" IN ('TIME_RANGE', 'DAY_RANGE'));

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_flexible_requires_versions"
  CHECK (
    "pricing_snapshot_version" <> 'flexible-pricing-v1' OR
    ("pricing_algorithm_version" IS NOT NULL AND
     "pricing_rounding_rule_version" IS NOT NULL AND
     "pricing_intent_type" IS NOT NULL)
  );

-- ========================================================================
-- 6. Contraintes CHECK sur bookings
-- ========================================================================

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_pricing_snapshot_version_valid"
  CHECK ("pricing_snapshot_version" IN ('legacy-daily-v1', 'flexible-pricing-v1'));

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_pricing_intent_type_valid"
  CHECK ("pricing_intent_type" IS NULL OR "pricing_intent_type" IN ('TIME_RANGE', 'DAY_RANGE'));

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_flexible_requires_versions"
  CHECK (
    "pricing_snapshot_version" <> 'flexible-pricing-v1' OR
    ("pricing_algorithm_version" IS NOT NULL AND
     "pricing_rounding_rule_version" IS NOT NULL AND
     "pricing_intent_type" IS NOT NULL)
  );

-- G7P-B2-B : billable_unit sémantique pour les réservations flexibles
-- TIME_RANGE → MINUTE, DAY_RANGE → DAY
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_flexible_billable_unit_by_intent"
  CHECK (
    "pricing_snapshot_version" <> 'flexible-pricing-v1' OR
    ("pricing_intent_type" <> 'TIME_RANGE' OR "billable_unit" = 'MINUTE') AND
    ("pricing_intent_type" <> 'DAY_RANGE' OR "billable_unit" = 'DAY')
  );

-- ========================================================================
-- 7. Contraintes CHECK sur booking_draft_lines
-- ========================================================================

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_pricing_plan_type_valid"
  CHECK ("pricing_plan_type" IS NULL OR "pricing_plan_type" IN ('HOURLY', 'FIXED_DURATION', 'DAILY'));

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_pricing_amount_before_nonneg"
  CHECK ("pricing_amount_before_discount_minor" IS NULL OR "pricing_amount_before_discount_minor" >= 0);

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_pricing_amount_before_max_safe"
  CHECK ("pricing_amount_before_discount_minor" IS NULL OR "pricing_amount_before_discount_minor" <= 9007199254740991);

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_pricing_amount_after_nonneg"
  CHECK ("pricing_amount_after_discount_minor" IS NULL OR "pricing_amount_after_discount_minor" >= 0);

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_pricing_amount_after_max_safe"
  CHECK ("pricing_amount_after_discount_minor" IS NULL OR "pricing_amount_after_discount_minor" <= 9007199254740991);

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_pricing_amount_before_gte_after"
  CHECK (
    "pricing_amount_before_discount_minor" IS NULL OR
    "pricing_amount_after_discount_minor" IS NULL OR
    "pricing_amount_before_discount_minor" >= "pricing_amount_after_discount_minor"
  );

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_pricing_discount_percent_range"
  CHECK ("pricing_discount_percent" IS NULL OR ("pricing_discount_percent" >= 0 AND "pricing_discount_percent" <= 100));

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_pricing_discount_threshold_daily_only"
  CHECK ("pricing_discount_threshold_days" IS NULL OR "pricing_plan_type" = 'DAILY');

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_pricing_hourly_requires_billed"
  CHECK ("pricing_plan_type" <> 'HOURLY' OR "pricing_billed_duration_minutes" IS NOT NULL);

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_pricing_fixed_requires_covered"
  CHECK ("pricing_plan_type" <> 'FIXED_DURATION' OR "pricing_covered_duration_minutes" IS NOT NULL);

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_pricing_daily_requires_days_and_amounts"
  CHECK (
    "pricing_plan_type" <> 'DAILY' OR
    ("pricing_billed_days" IS NOT NULL AND
     "pricing_amount_before_discount_minor" IS NOT NULL AND
     "pricing_amount_after_discount_minor" IS NOT NULL)
  );

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_pricing_billed_days_positive"
  CHECK ("pricing_billed_days" IS NULL OR "pricing_billed_days" > 0);

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_pricing_billed_duration_positive"
  CHECK ("pricing_billed_duration_minutes" IS NULL OR "pricing_billed_duration_minutes" > 0);

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_pricing_covered_duration_positive"
  CHECK ("pricing_covered_duration_minutes" IS NULL OR "pricing_covered_duration_minutes" > 0);

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_pricing_requested_duration_positive"
  CHECK ("pricing_requested_duration_minutes" IS NULL OR "pricing_requested_duration_minutes" > 0);

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_pricing_day_range_requires_daily"
  CHECK (
    "pricing_plan_type" IS NULL OR
    "pricing_plan_type" = 'DAILY' OR
    "pricing_discount_threshold_days" IS NULL
  );

-- ========================================================================
-- 8. Contraintes CHECK sur booking_lines (identiques à booking_draft_lines)
-- ========================================================================

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_pricing_plan_type_valid"
  CHECK ("pricing_plan_type" IS NULL OR "pricing_plan_type" IN ('HOURLY', 'FIXED_DURATION', 'DAILY'));

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_pricing_amount_before_nonneg"
  CHECK ("pricing_amount_before_discount_minor" IS NULL OR "pricing_amount_before_discount_minor" >= 0);

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_pricing_amount_before_max_safe"
  CHECK ("pricing_amount_before_discount_minor" IS NULL OR "pricing_amount_before_discount_minor" <= 9007199254740991);

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_pricing_amount_after_nonneg"
  CHECK ("pricing_amount_after_discount_minor" IS NULL OR "pricing_amount_after_discount_minor" >= 0);

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_pricing_amount_after_max_safe"
  CHECK ("pricing_amount_after_discount_minor" IS NULL OR "pricing_amount_after_discount_minor" <= 9007199254740991);

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_pricing_amount_before_gte_after"
  CHECK (
    "pricing_amount_before_discount_minor" IS NULL OR
    "pricing_amount_after_discount_minor" IS NULL OR
    "pricing_amount_before_discount_minor" >= "pricing_amount_after_discount_minor"
  );

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_pricing_discount_percent_range"
  CHECK ("pricing_discount_percent" IS NULL OR ("pricing_discount_percent" >= 0 AND "pricing_discount_percent" <= 100));

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_pricing_discount_threshold_daily_only"
  CHECK ("pricing_discount_threshold_days" IS NULL OR "pricing_plan_type" = 'DAILY');

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_pricing_hourly_requires_billed"
  CHECK ("pricing_plan_type" <> 'HOURLY' OR "pricing_billed_duration_minutes" IS NOT NULL);

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_pricing_fixed_requires_covered"
  CHECK ("pricing_plan_type" <> 'FIXED_DURATION' OR "pricing_covered_duration_minutes" IS NOT NULL);

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_pricing_daily_requires_days_and_amounts"
  CHECK (
    "pricing_plan_type" <> 'DAILY' OR
    ("pricing_billed_days" IS NOT NULL AND
     "pricing_amount_before_discount_minor" IS NOT NULL AND
     "pricing_amount_after_discount_minor" IS NOT NULL)
  );

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_pricing_billed_days_positive"
  CHECK ("pricing_billed_days" IS NULL OR "pricing_billed_days" > 0);

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_pricing_billed_duration_positive"
  CHECK ("pricing_billed_duration_minutes" IS NULL OR "pricing_billed_duration_minutes" > 0);

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_pricing_covered_duration_positive"
  CHECK ("pricing_covered_duration_minutes" IS NULL OR "pricing_covered_duration_minutes" > 0);

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_pricing_requested_duration_positive"
  CHECK ("pricing_requested_duration_minutes" IS NULL OR "pricing_requested_duration_minutes" > 0);

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_pricing_day_range_requires_daily"
  CHECK (
    "pricing_plan_type" IS NULL OR
    "pricing_plan_type" = 'DAILY' OR
    "pricing_discount_threshold_days" IS NULL
  );

-- ========================================================================
-- 9. Clés étrangères vers pricing_plans
-- ========================================================================

ALTER TABLE "booking_draft_lines"
  ADD CONSTRAINT "booking_draft_lines_pricing_plan_id_fk"
  FOREIGN KEY ("pricing_plan_id") REFERENCES "pricing_plans"("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "booking_lines"
  ADD CONSTRAINT "booking_lines_pricing_plan_id_fk"
  FOREIGN KEY ("pricing_plan_id") REFERENCES "pricing_plans"("id")
  DEFERRABLE INITIALLY DEFERRED;

-- ========================================================================
-- 10. Index partiels sur pricing_plan_id
-- ========================================================================

CREATE INDEX "booking_draft_lines_pricing_plan_id_idx"
  ON "booking_draft_lines" ("pricing_plan_id")
  WHERE "pricing_plan_id" IS NOT NULL;

CREATE INDEX "booking_lines_pricing_plan_id_idx"
  ON "booking_lines" ("pricing_plan_id")
  WHERE "pricing_plan_id" IS NOT NULL;

-- ========================================================================
-- 11. Backfill explicite : pricing_snapshot_version = 'legacy-daily-v1'
-- ========================================================================

UPDATE "booking_drafts" SET "pricing_snapshot_version" = 'legacy-daily-v1'
WHERE "pricing_snapshot_version" IS NULL OR "pricing_snapshot_version" <> 'legacy-daily-v1';

UPDATE "bookings" SET "pricing_snapshot_version" = 'legacy-daily-v1'
WHERE "pricing_snapshot_version" IS NULL OR "pricing_snapshot_version" <> 'legacy-daily-v1';

-- ========================================================================
-- Fonctions et triggers
-- ========================================================================

-- 12. Fonction : cohérence multi-tenant + devise des lignes de brouillon
-- Si pricing_plan_id IS NOT NULL, vérifie que le plan appartient à la même
-- organisation que le brouillon ET que la devise du plan correspond à la
-- devise du brouillon. Fail-closed.
CREATE OR REPLACE FUNCTION "check_draft_pricing_plan_org_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  draft_org_id uuid;
  draft_currency text;
  plan_org_id uuid;
  plan_currency text;
BEGIN
  IF NEW."pricing_plan_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "organization_id", "currency" INTO draft_org_id, draft_currency
  FROM "booking_drafts"
  WHERE "id" = NEW."draft_id";

  IF draft_org_id IS NULL THEN
    RAISE EXCEPTION 'booking_draft_lines: draft_id % does not exist', NEW."draft_id";
  END IF;

  SELECT "organization_id", "currency" INTO plan_org_id, plan_currency
  FROM "pricing_plans"
  WHERE "id" = NEW."pricing_plan_id";

  IF plan_org_id IS NULL THEN
    RAISE EXCEPTION 'booking_draft_lines: pricing_plan_id % does not exist', NEW."pricing_plan_id";
  END IF;

  IF plan_org_id <> draft_org_id THEN
    RAISE EXCEPTION 'booking_draft_lines: pricing_plan organization_id mismatch — plan has % but draft belongs to %', plan_org_id, draft_org_id;
  END IF;

  IF plan_currency <> draft_currency THEN
    RAISE EXCEPTION 'booking_draft_lines: pricing_plan currency mismatch — plan has % but draft has %', plan_currency, draft_currency;
  END IF;

  RETURN NEW;
END;
$$;

-- 13. Trigger : cohérence multi-tenant des lignes de brouillon
DROP TRIGGER IF EXISTS "before_check_draft_pricing_plan_org_consistency" ON "booking_draft_lines";
CREATE TRIGGER "before_check_draft_pricing_plan_org_consistency"
  BEFORE INSERT OR UPDATE OF "pricing_plan_id", "draft_id" ON "booking_draft_lines"
  FOR EACH ROW
  EXECUTE FUNCTION "check_draft_pricing_plan_org_consistency"();

-- 14. Fonction : cohérence multi-tenant + devise des lignes de réservation
CREATE OR REPLACE FUNCTION "check_booking_pricing_plan_org_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  booking_org_id uuid;
  booking_currency text;
  plan_org_id uuid;
  plan_currency text;
BEGIN
  IF NEW."pricing_plan_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "organization_id", "currency" INTO booking_org_id, booking_currency
  FROM "bookings"
  WHERE "id" = NEW."booking_id";

  IF booking_org_id IS NULL THEN
    RAISE EXCEPTION 'booking_lines: booking_id % does not exist', NEW."booking_id";
  END IF;

  SELECT "organization_id", "currency" INTO plan_org_id, plan_currency
  FROM "pricing_plans"
  WHERE "id" = NEW."pricing_plan_id";

  IF plan_org_id IS NULL THEN
    RAISE EXCEPTION 'booking_lines: pricing_plan_id % does not exist', NEW."pricing_plan_id";
  END IF;

  IF plan_org_id <> booking_org_id THEN
    RAISE EXCEPTION 'booking_lines: pricing_plan organization_id mismatch — plan has % but booking belongs to %', plan_org_id, booking_org_id;
  END IF;

  IF plan_currency <> booking_currency THEN
    RAISE EXCEPTION 'booking_lines: pricing_plan currency mismatch — plan has % but booking has %', plan_currency, booking_currency;
  END IF;

  RETURN NEW;
END;
$$;

-- 15. Trigger : cohérence multi-tenant des lignes de réservation
DROP TRIGGER IF EXISTS "before_check_booking_pricing_plan_org_consistency" ON "booking_lines";
CREATE TRIGGER "before_check_booking_pricing_plan_org_consistency"
  BEFORE INSERT OR UPDATE OF "pricing_plan_id", "booking_id" ON "booking_lines"
  FOR EACH ROW
  EXECUTE FUNCTION "check_booking_pricing_plan_org_consistency"();

-- 16. Fonction : immutabilité financière des brouillons
-- Sur UPDATE de booking_drafts, rejette les modifications de toutes les
-- colonnes SAUF status, expires_at, updated_at. Le snapshot financier est figé
-- à la création.
CREATE OR REPLACE FUNCTION "enforce_draft_financial_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."location_id" IS DISTINCT FROM OLD."location_id"
     OR NEW."customer_user_id" IS DISTINCT FROM OLD."customer_user_id"
     OR NEW."customer_start_at" IS DISTINCT FROM OLD."customer_start_at"
     OR NEW."customer_end_at" IS DISTINCT FROM OLD."customer_end_at"
     OR NEW."blocked_start_at" IS DISTINCT FROM OLD."blocked_start_at"
     OR NEW."blocked_end_at" IS DISTINCT FROM OLD."blocked_end_at"
     OR NEW."timezone" IS DISTINCT FROM OLD."timezone"
     OR NEW."prep_buffer_minutes" IS DISTINCT FROM OLD."prep_buffer_minutes"
     OR NEW."cleanup_buffer_minutes" IS DISTINCT FROM OLD."cleanup_buffer_minutes"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."subtotal_amount_minor" IS DISTINCT FROM OLD."subtotal_amount_minor"
     OR NEW."mandatory_fees_amount_minor" IS DISTINCT FROM OLD."mandatory_fees_amount_minor"
     OR NEW."total_amount_minor" IS DISTINCT FROM OLD."total_amount_minor"
     OR NEW."tax_status" IS DISTINCT FROM OLD."tax_status"
     OR NEW."tax_amount_minor" IS DISTINCT FROM OLD."tax_amount_minor"
     OR NEW."tax_rate_bps" IS DISTINCT FROM OLD."tax_rate_bps"
     OR NEW."commission_amount_minor" IS DISTINCT FROM OLD."commission_amount_minor"
     OR NEW."billable_unit" IS DISTINCT FROM OLD."billable_unit"
     OR NEW."billable_unit_count" IS DISTINCT FROM OLD."billable_unit_count"
     OR NEW."cancellation_policy_snapshot" IS DISTINCT FROM OLD."cancellation_policy_snapshot"
     OR NEW."pricing_snapshot_version" IS DISTINCT FROM OLD."pricing_snapshot_version"
     OR NEW."pricing_algorithm_version" IS DISTINCT FROM OLD."pricing_algorithm_version"
     OR NEW."pricing_rounding_rule_version" IS DISTINCT FROM OLD."pricing_rounding_rule_version"
     OR NEW."pricing_intent_type" IS DISTINCT FROM OLD."pricing_intent_type"
     OR NEW."pricing_intent_snapshot" IS DISTINCT FROM OLD."pricing_intent_snapshot"
     OR NEW."pricing_resolved_locale" IS DISTINCT FROM OLD."pricing_resolved_locale"
  THEN
    RAISE EXCEPTION 'booking_drafts: financial snapshot is immutable — only status, expires_at and updated_at may change';
  END IF;
  RETURN NEW;
END;
$$;

-- 17. Trigger : immutabilité financière des brouillons
DROP TRIGGER IF EXISTS "before_check_draft_financial_immutability" ON "booking_drafts";
CREATE TRIGGER "before_check_draft_financial_immutability"
  BEFORE UPDATE ON "booking_drafts"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_draft_financial_immutability"();

-- 18. Fonction : immutabilité conditionnelle des lignes de brouillon
-- Allow UPDATE/DELETE only when parent draft status = 'DRAFT'.
-- When parent is HELD/PAYMENT_PROCESSING/EXPIRED/CONVERTED, reject ALL changes
-- (any column). This freezes the snapshot once the draft is HELD, while allowing
-- existing flows that manipulate DRAFT-status draft lines to continue working.
CREATE OR REPLACE FUNCTION "enforce_draft_line_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO parent_status FROM "booking_drafts" WHERE "id" = OLD."draft_id";
    IF parent_status IS NULL OR parent_status = 'DRAFT' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Cannot delete draft line: parent draft is not DRAFT (status=%)', parent_status;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT status INTO parent_status FROM "booking_drafts" WHERE "id" = NEW."draft_id";
    IF parent_status IS NULL OR parent_status = 'DRAFT' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Cannot update draft line: parent draft is not DRAFT (status=%)', parent_status;
  END IF;

  RETURN NEW;
END;
$$;

-- 19. Trigger : immutabilité des lignes de brouillon
DROP TRIGGER IF EXISTS "before_check_draft_line_immutability" ON "booking_draft_lines";
CREATE TRIGGER "before_check_draft_line_immutability"
  BEFORE UPDATE OR DELETE ON "booking_draft_lines"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_draft_line_immutability"();

-- 19b. Fonction : cohérence intent/plan des lignes de brouillon
-- Si le parent draft a pricing_intent_type = 'DAY_RANGE', alors la ligne doit
-- avoir pricing_plan_type = 'DAILY' (ou NULL). Un plan HOURLY ou FIXED_DURATION
-- avec un draft DAY_RANGE est incohérent.
CREATE OR REPLACE FUNCTION "enforce_draft_line_intent_plan_coherence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_intent_type text;
BEGIN
  SELECT "pricing_intent_type" INTO parent_intent_type FROM "booking_drafts" WHERE "id" = NEW."draft_id";
  IF parent_intent_type = 'DAY_RANGE' AND NEW."pricing_plan_type" IS NOT NULL AND NEW."pricing_plan_type" <> 'DAILY' THEN
    RAISE EXCEPTION 'DAY_RANGE intent requires DAILY plan type, got %', NEW."pricing_plan_type";
  END IF;
  RETURN NEW;
END;
$$;

-- 19c. Trigger : cohérence intent/plan des lignes de brouillon
DROP TRIGGER IF EXISTS "before_check_draft_line_intent_plan_coherence" ON "booking_draft_lines";
CREATE TRIGGER "before_check_draft_line_intent_plan_coherence"
  BEFORE INSERT OR UPDATE ON "booking_draft_lines"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_draft_line_intent_plan_coherence"();

-- 20. Fonction : immutabilité financière des réservations
-- Sur UPDATE de bookings, rejette les modifications de toutes les colonnes
-- SAUF status et updated_at. Le snapshot financier est figé à la confirmation.
-- Les transitions de statut (CONFIRMED → READY_FOR_PICKUP → ACTIVE → etc.)
-- restent autorisées. DELETE est toujours rejeté.
CREATE OR REPLACE FUNCTION "enforce_booking_financial_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bookings: DELETE is not allowed (bookings are immutable after confirmation)';
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."location_id" IS DISTINCT FROM OLD."location_id"
     OR NEW."customer_user_id" IS DISTINCT FROM OLD."customer_user_id"
     OR NEW."draft_id" IS DISTINCT FROM OLD."draft_id"
     OR NEW."payment_id" IS DISTINCT FROM OLD."payment_id"
     OR NEW."customer_start_at" IS DISTINCT FROM OLD."customer_start_at"
     OR NEW."customer_end_at" IS DISTINCT FROM OLD."customer_end_at"
     OR NEW."blocked_start_at" IS DISTINCT FROM OLD."blocked_start_at"
     OR NEW."blocked_end_at" IS DISTINCT FROM OLD."blocked_end_at"
     OR NEW."prep_buffer_minutes" IS DISTINCT FROM OLD."prep_buffer_minutes"
     OR NEW."cleanup_buffer_minutes" IS DISTINCT FROM OLD."cleanup_buffer_minutes"
     OR NEW."timezone" IS DISTINCT FROM OLD."timezone"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."subtotal_amount_minor" IS DISTINCT FROM OLD."subtotal_amount_minor"
     OR NEW."mandatory_fees_amount_minor" IS DISTINCT FROM OLD."mandatory_fees_amount_minor"
     OR NEW."tax_status" IS DISTINCT FROM OLD."tax_status"
     OR NEW."tax_amount_minor" IS DISTINCT FROM OLD."tax_amount_minor"
     OR NEW."tax_rate_bps" IS DISTINCT FROM OLD."tax_rate_bps"
     OR NEW."commission_amount_minor" IS DISTINCT FROM OLD."commission_amount_minor"
     OR NEW."total_amount_minor" IS DISTINCT FROM OLD."total_amount_minor"
     OR NEW."billable_unit" IS DISTINCT FROM OLD."billable_unit"
     OR NEW."billable_unit_count" IS DISTINCT FROM OLD."billable_unit_count"
     OR NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at"
     OR NEW."pricing_snapshot_version" IS DISTINCT FROM OLD."pricing_snapshot_version"
     OR NEW."pricing_algorithm_version" IS DISTINCT FROM OLD."pricing_algorithm_version"
     OR NEW."pricing_rounding_rule_version" IS DISTINCT FROM OLD."pricing_rounding_rule_version"
     OR NEW."pricing_intent_type" IS DISTINCT FROM OLD."pricing_intent_type"
     OR NEW."pricing_intent_snapshot" IS DISTINCT FROM OLD."pricing_intent_snapshot"
     OR NEW."pricing_resolved_locale" IS DISTINCT FROM OLD."pricing_resolved_locale"
     OR NEW."cancellation_policy_snapshot" IS DISTINCT FROM OLD."cancellation_policy_snapshot"
     OR NEW."terms_acceptance_snapshot" IS DISTINCT FROM OLD."terms_acceptance_snapshot"
     OR NEW."tax_rule_snapshot" IS DISTINCT FROM OLD."tax_rule_snapshot"
     OR NEW."commission_rule_snapshot" IS DISTINCT FROM OLD."commission_rule_snapshot"
  THEN
    RAISE EXCEPTION 'bookings: financial snapshot is immutable — only status and updated_at may change';
  END IF;
  RETURN NEW;
END;
$$;

-- 21. Trigger : immutabilité des réservations
DROP TRIGGER IF EXISTS "before_check_booking_financial_immutability" ON "bookings";
CREATE TRIGGER "before_check_booking_financial_immutability"
  BEFORE UPDATE OR DELETE ON "bookings"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_booking_financial_immutability"();

-- 22. Fonction : immutabilité complète des lignes de réservation
-- Bookings are immutable after confirmation. Reject ALL UPDATE and DELETE.
CREATE OR REPLACE FUNCTION "enforce_booking_line_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cannot delete booking line: bookings are immutable';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Cannot update booking line: bookings are immutable';
  END IF;
  RETURN NEW;
END;
$$;

-- 23. Trigger : immutabilité des lignes de réservation
DROP TRIGGER IF EXISTS "before_check_booking_line_immutability" ON "booking_lines";
CREATE TRIGGER "before_check_booking_line_immutability"
  BEFORE UPDATE OR DELETE ON "booking_lines"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_booking_line_immutability"();

-- 23b. Fonction : cohérence intent/plan des lignes de réservation
-- Si le parent booking a pricing_intent_type = 'DAY_RANGE', alors la ligne doit
-- avoir pricing_plan_type = 'DAILY' (ou NULL).
CREATE OR REPLACE FUNCTION "enforce_booking_line_intent_plan_coherence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_intent_type text;
BEGIN
  SELECT "pricing_intent_type" INTO parent_intent_type FROM "bookings" WHERE "id" = NEW."booking_id";
  IF parent_intent_type = 'DAY_RANGE' AND NEW."pricing_plan_type" IS NOT NULL AND NEW."pricing_plan_type" <> 'DAILY' THEN
    RAISE EXCEPTION 'DAY_RANGE intent requires DAILY plan type, got %', NEW."pricing_plan_type";
  END IF;
  RETURN NEW;
END;
$$;

-- 23c. Trigger : cohérence intent/plan des lignes de réservation
DROP TRIGGER IF EXISTS "before_check_booking_line_intent_plan_coherence" ON "booking_lines";
CREATE TRIGGER "before_check_booking_line_intent_plan_coherence"
  BEFORE INSERT OR UPDATE ON "booking_lines"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_booking_line_intent_plan_coherence"();

-- =====================================================================
-- G7P-B2-A Round 2 — Renforcement fail-closed des invariants (appendix)
-- =====================================================================

-- Supprimer les anciens déclencheurs/fonctions de cohérence faibles
DROP TRIGGER IF EXISTS "before_check_draft_pricing_plan_org_consistency" ON "booking_draft_lines";
DROP TRIGGER IF EXISTS "before_check_booking_pricing_plan_org_consistency" ON "booking_lines";
DROP FUNCTION IF EXISTS "check_draft_pricing_plan_org_consistency"();
DROP FUNCTION IF EXISTS "check_booking_pricing_plan_org_consistency"();

-- Contraintes CHECK exactes sur les métadonnées des parents (P0-3)
ALTER TABLE "booking_drafts"
  DROP CONSTRAINT IF EXISTS "booking_drafts_flexible_requires_versions";
ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_flexible_metadata_exact"
  CHECK (
    "pricing_snapshot_version" <> 'flexible-pricing-v1' OR
    (
      "pricing_algorithm_version" = 'flexible-pricing-v1' AND
      "pricing_rounding_rule_version" = 'half-up-v1' AND
      "pricing_intent_type" IN ('TIME_RANGE', 'DAY_RANGE') AND
      "pricing_intent_snapshot" IS NOT NULL AND
      jsonb_typeof("pricing_intent_snapshot") = 'object' AND
      length(btrim("pricing_resolved_locale")) > 0
    )
  );

ALTER TABLE "booking_drafts"
  ADD CONSTRAINT "booking_drafts_legacy_metadata_null"
  CHECK (
    "pricing_snapshot_version" <> 'legacy-daily-v1' OR
    (
      "pricing_algorithm_version" IS NULL AND
      "pricing_rounding_rule_version" IS NULL AND
      "pricing_intent_type" IS NULL AND
      "pricing_intent_snapshot" IS NULL AND
      "pricing_resolved_locale" IS NULL AND
      "billable_unit" = 'DAY'
    )
  );

ALTER TABLE "bookings"
  DROP CONSTRAINT IF EXISTS "bookings_flexible_requires_versions";
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_flexible_metadata_exact"
  CHECK (
    "pricing_snapshot_version" <> 'flexible-pricing-v1' OR
    (
      "pricing_algorithm_version" = 'flexible-pricing-v1' AND
      "pricing_rounding_rule_version" = 'half-up-v1' AND
      "pricing_intent_type" IN ('TIME_RANGE', 'DAY_RANGE') AND
      "pricing_intent_snapshot" IS NOT NULL AND
      jsonb_typeof("pricing_intent_snapshot") = 'object' AND
      length(btrim("pricing_resolved_locale")) > 0
    )
  );

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_legacy_metadata_null"
  CHECK (
    "pricing_snapshot_version" <> 'legacy-daily-v1' OR
    (
      "pricing_algorithm_version" IS NULL AND
      "pricing_rounding_rule_version" IS NULL AND
      "pricing_intent_type" IS NULL AND
      "pricing_intent_snapshot" IS NULL AND
      "pricing_resolved_locale" IS NULL AND
      "billable_unit" = 'DAY'
    )
  );

-- Déclencheur de cohérence location / devise / timezone sur booking_drafts (P0-3)
CREATE OR REPLACE FUNCTION "enforce_draft_location_coherence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  loc_record "locations"%ROWTYPE;
BEGIN
  SELECT * INTO loc_record FROM "locations" WHERE "id" = NEW."location_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_drafts: location % does not exist', NEW."location_id";
  END IF;

  IF loc_record."organization_id" <> NEW."organization_id" THEN
    RAISE EXCEPTION 'booking_drafts: location % belongs to a different organization', NEW."location_id";
  END IF;

  IF loc_record."deleted_at" IS NOT NULL THEN
    RAISE EXCEPTION 'booking_drafts: location % is deleted', NEW."location_id";
  END IF;

  -- Fail-closed: location time_zone must be a valid IANA timezone
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = loc_record."time_zone") THEN
    RAISE EXCEPTION 'booking_drafts: location time_zone % is not a valid IANA timezone', loc_record."time_zone";
  END IF;

  -- Fail-closed: draft time_zone must be a valid IANA timezone
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW."timezone") THEN
    RAISE EXCEPTION 'booking_drafts: timezone % is not a valid IANA timezone', NEW."timezone";
  END IF;

  -- Both must be strictly identical
  IF loc_record."time_zone" <> NEW."timezone" THEN
    RAISE EXCEPTION 'booking_drafts: timezone % does not match location time_zone %', NEW."timezone", loc_record."time_zone";
  END IF;

  IF loc_record."operating_currency" <> NEW."currency" THEN
    RAISE EXCEPTION 'booking_drafts: currency % does not match location operating_currency %', NEW."currency", loc_record."operating_currency";
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "before_enforce_draft_location_coherence" ON "booking_drafts";
CREATE TRIGGER "before_enforce_draft_location_coherence"
  BEFORE INSERT OR UPDATE ON "booking_drafts"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_draft_location_coherence"();


-- P0-2 / P0-4 / P0-5 — Cohérence complète des lignes de brouillon
CREATE OR REPLACE FUNCTION "enforce_draft_line_pricing_coherence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent "booking_drafts"%ROWTYPE;
  plan_record "pricing_plans"%ROWTYPE;
  loc_record "locations"%ROWTYPE;
  translation_exists boolean;
  local_active_count integer;
  expected_amount_before bigint;
  expected_amount_after bigint;
  expected_discount bigint;
  best_threshold integer;
  best_percent integer;
  expected_buc integer;
  prod numeric;
  win_kind text;
  win_weekday_mask integer;
  win_start_time text;
  win_end_time text;
  win_first_local_date text;
  win_last_local_date text;
  intent_start_date text;
  intent_end_date_exclusive text;
BEGIN
  -- Lecture du parent avec verrou partagé (ordre de verrouillage : ligne -> parent -> plan)
  SELECT * INTO parent
  FROM "booking_drafts"
  WHERE "id" = NEW."draft_id"
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_draft_lines: draft_id % does not exist', NEW."draft_id";
  END IF;

  -- P0-1 : parent legacy => toutes les colonnes pricing_* doivent être NULL
  IF parent."pricing_snapshot_version" = 'legacy-daily-v1' THEN
    IF NEW."pricing_plan_id" IS NOT NULL OR NEW."pricing_plan_version" IS NOT NULL OR
       NEW."pricing_plan_type" IS NOT NULL OR NEW."pricing_public_label" IS NOT NULL OR
       NEW."pricing_requested_duration_minutes" IS NOT NULL OR
       NEW."pricing_billed_duration_minutes" IS NOT NULL OR
       NEW."pricing_covered_duration_minutes" IS NOT NULL OR
       NEW."pricing_billed_days" IS NOT NULL OR
       NEW."pricing_selected_window" IS NOT NULL OR
       NEW."pricing_discount_threshold_days" IS NOT NULL OR
       NEW."pricing_discount_percent" IS NOT NULL OR
       NEW."pricing_amount_before_discount_minor" IS NOT NULL OR
       NEW."pricing_amount_after_discount_minor" IS NOT NULL THEN
      RAISE EXCEPTION 'booking_draft_lines: legacy parent requires all pricing_* columns to be NULL';
    END IF;
    RETURN NEW;
  END IF;

  -- Flexible parent => snapshot complet obligatoire
  IF parent."pricing_snapshot_version" <> 'flexible-pricing-v1' THEN
    RETURN NEW;
  END IF;

  IF NEW."pricing_plan_id" IS NULL OR NEW."pricing_plan_version" IS NULL OR
     NEW."pricing_plan_type" IS NULL OR NEW."pricing_public_label" IS NULL OR
     length(btrim(NEW."pricing_public_label")) = 0 THEN
    RAISE EXCEPTION 'booking_draft_lines: flexible parent requires a complete pricing snapshot';
  END IF;

  -- Cohérence intent / plan type (P0-1)
  IF parent."pricing_intent_type" = 'DAY_RANGE' AND NEW."pricing_plan_type" <> 'DAILY' THEN
    RAISE EXCEPTION 'booking_draft_lines: DAY_RANGE intent requires DAILY plan type, got %', NEW."pricing_plan_type";
  END IF;

  IF parent."pricing_intent_type" = 'TIME_RANGE' AND
     NEW."pricing_plan_type" NOT IN ('HOURLY', 'FIXED_DURATION', 'DAILY') THEN
    RAISE EXCEPTION 'booking_draft_lines: TIME_RANGE intent requires plan type in (HOURLY, FIXED_DURATION, DAILY), got %', NEW."pricing_plan_type";
  END IF;

  -- G7P-B2-B : cohérence pricing_requested_duration_minutes selon intent_type
  -- DAY_RANGE + DAILY → pricing_requested_duration_minutes must be NULL
  -- TIME_RANGE (any plan) → pricing_requested_duration_minutes must be > 0
  IF parent."pricing_intent_type" = 'DAY_RANGE' THEN
    IF NEW."pricing_requested_duration_minutes" IS NOT NULL THEN
      RAISE EXCEPTION 'booking_draft_lines: DAY_RANGE intent requires NULL pricing_requested_duration_minutes, got %', NEW."pricing_requested_duration_minutes";
    END IF;
  ELSIF parent."pricing_intent_type" = 'TIME_RANGE' THEN
    IF NEW."pricing_requested_duration_minutes" IS NULL OR NEW."pricing_requested_duration_minutes" <= 0 THEN
      RAISE EXCEPTION 'booking_draft_lines: TIME_RANGE intent requires positive pricing_requested_duration_minutes';
    END IF;
  END IF;

  -- Verrouillage et validation du plan référencé (P0-2).
  -- La ligne de brouillon prend d'abord le verrou FOR SHARE sur pricing_plans,
  -- ce qui bloque tout UPDATE concurrent (ex. RETIRED) jusqu'au COMMIT.
  SELECT * INTO plan_record
  FROM "pricing_plans"
  WHERE "id" = NEW."pricing_plan_id"
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_draft_lines: pricing_plan_id % does not exist', NEW."pricing_plan_id";
  END IF;

  IF plan_record."organization_id" <> parent."organization_id" THEN
    RAISE EXCEPTION 'booking_draft_lines: pricing_plan organization_id mismatch';
  END IF;

  IF plan_record."product_variant_id" <> NEW."variant_id" THEN
    RAISE EXCEPTION 'booking_draft_lines: pricing_plan product_variant_id mismatch';
  END IF;

  IF plan_record."currency" <> NEW."currency" OR plan_record."currency" <> parent."currency" THEN
    RAISE EXCEPTION 'booking_draft_lines: pricing_plan currency mismatch';
  END IF;

  IF plan_record."version" <> NEW."pricing_plan_version" THEN
    RAISE EXCEPTION 'booking_draft_lines: pricing_plan_version snapshot mismatch (expected %, got %)', plan_record."version", NEW."pricing_plan_version";
  END IF;

  IF plan_record."plan_type"::text <> NEW."pricing_plan_type" THEN
    RAISE EXCEPTION 'booking_draft_lines: pricing_plan_type snapshot mismatch';
  END IF;

  IF plan_record."lifecycle_state"::text <> 'ACTIVE' THEN
    RAISE EXCEPTION 'booking_draft_lines: pricing_plan is not ACTIVE (state %)', plan_record."lifecycle_state";
  END IF;

  -- Applicabilité à la location (P0-2)
  IF plan_record."location_id" IS NOT NULL THEN
    IF plan_record."location_id" <> parent."location_id" THEN
      RAISE EXCEPTION 'booking_draft_lines: pricing_plan is local to another location';
    END IF;
  ELSE
    SELECT count(*) INTO local_active_count
    FROM "pricing_plans"
    WHERE "location_id" = parent."location_id"
      AND "product_variant_id" = NEW."variant_id"
      AND "plan_type"::text = NEW."pricing_plan_type"
      AND "currency" = NEW."currency"
      AND COALESCE("included_duration_minutes", -1) = COALESCE(plan_record."included_duration_minutes", -1)
      AND "lifecycle_state"::text = 'ACTIVE'
      AND "id" <> plan_record."id";
    IF local_active_count > 0 THEN
      RAISE EXCEPTION 'booking_draft_lines: a local ACTIVE plan overrides this default plan for the location';
    END IF;
  END IF;

  -- Libellé résolu dans pricing_plan_translations
  SELECT EXISTS (
    SELECT 1 FROM "pricing_plan_translations"
    WHERE "pricing_plan_id" = plan_record."id"
      AND "locale" = parent."pricing_resolved_locale"
      AND "public_label" = NEW."pricing_public_label"
  ) INTO translation_exists;
  IF NOT translation_exists THEN
    RAISE EXCEPTION 'booking_draft_lines: pricing_public_label does not match resolved locale translation';
  END IF;

  -- Validation location / devise
  SELECT * INTO loc_record FROM "locations" WHERE "id" = parent."location_id";
  IF NOT FOUND OR loc_record."organization_id" <> parent."organization_id" OR loc_record."deleted_at" IS NOT NULL THEN
    RAISE EXCEPTION 'booking_draft_lines: location is not valid for this draft';
  END IF;
  IF loc_record."operating_currency" <> NEW."currency" OR loc_record."operating_currency" <> parent."currency" THEN
    RAISE EXCEPTION 'booking_draft_lines: currency must match location operating_currency';
  END IF;

  -- P0-4 : snapshot canonique par type et arithmétique
  IF NEW."pricing_plan_type" = 'HOURLY' THEN
    IF NEW."pricing_billed_duration_minutes" IS NULL OR NEW."pricing_billed_duration_minutes" <= 0 THEN
      RAISE EXCEPTION 'booking_draft_lines: HOURLY requires positive pricing_billed_duration_minutes';
    END IF;
    IF NEW."pricing_covered_duration_minutes" IS NOT NULL OR
       NEW."pricing_billed_days" IS NOT NULL OR
       NEW."pricing_amount_before_discount_minor" IS NOT NULL OR
       NEW."pricing_amount_after_discount_minor" IS NOT NULL THEN
      RAISE EXCEPTION 'booking_draft_lines: HOURLY line must not contain daily/fixed fields';
    END IF;
    IF plan_record."billing_increment_minutes" IS NULL OR plan_record."billing_increment_minutes" <= 0 THEN
      RAISE EXCEPTION 'booking_draft_lines: HOURLY plan missing billing_increment_minutes';
    END IF;
    expected_buc := NEW."pricing_billed_duration_minutes" / plan_record."billing_increment_minutes";
    IF NEW."pricing_billed_duration_minutes" % plan_record."billing_increment_minutes" <> 0 OR
       NEW."billable_unit_count" <> expected_buc THEN
      RAISE EXCEPTION 'booking_draft_lines: HOURLY billable_unit_count must equal billed_duration_minutes / billing_increment_minutes';
    END IF;
    prod := NEW."unit_price_amount_minor"::numeric * NEW."billable_unit_count"::numeric * NEW."quantity"::numeric;
    IF prod > 9007199254740991 THEN
      RAISE EXCEPTION 'booking_draft_lines: line total exceeds MAX_SAFE_INTEGER';
    END IF;
    IF NEW."line_total_amount_minor" <> prod::bigint THEN
      RAISE EXCEPTION 'booking_draft_lines: HOURLY line_total_amount_minor mismatch (expected %, got %)', prod::bigint, NEW."line_total_amount_minor";
    END IF;
  ELSIF NEW."pricing_plan_type" = 'FIXED_DURATION' THEN
    IF NEW."pricing_covered_duration_minutes" IS NULL OR NEW."pricing_covered_duration_minutes" <= 0 THEN
      RAISE EXCEPTION 'booking_draft_lines: FIXED_DURATION requires positive pricing_covered_duration_minutes';
    END IF;
    IF NEW."pricing_billed_duration_minutes" IS NOT NULL OR
       NEW."pricing_billed_days" IS NOT NULL OR
       NEW."pricing_amount_before_discount_minor" IS NOT NULL OR
       NEW."pricing_amount_after_discount_minor" IS NOT NULL THEN
      RAISE EXCEPTION 'booking_draft_lines: FIXED_DURATION line must not contain hourly/daily amount fields';
    END IF;
    IF NEW."billable_unit_count" <> 1 THEN
      RAISE EXCEPTION 'booking_draft_lines: FIXED_DURATION requires billable_unit_count = 1';
    END IF;
    prod := NEW."unit_price_amount_minor"::numeric * 1::numeric * NEW."quantity"::numeric;
    IF prod > 9007199254740991 THEN
      RAISE EXCEPTION 'booking_draft_lines: line total exceeds MAX_SAFE_INTEGER';
    END IF;
    IF NEW."line_total_amount_minor" <> prod::bigint THEN
      RAISE EXCEPTION 'booking_draft_lines: FIXED_DURATION line_total_amount_minor mismatch';
    END IF;
  ELSIF NEW."pricing_plan_type" = 'DAILY' THEN
    IF NEW."pricing_billed_days" IS NULL OR NEW."pricing_billed_days" <= 0 THEN
      RAISE EXCEPTION 'booking_draft_lines: DAILY requires positive pricing_billed_days';
    END IF;
    IF NEW."pricing_amount_before_discount_minor" IS NULL OR NEW."pricing_amount_after_discount_minor" IS NULL THEN
      RAISE EXCEPTION 'booking_draft_lines: DAILY requires amount_before and amount_after';
    END IF;
    IF NEW."pricing_billed_duration_minutes" IS NOT NULL OR
       NEW."pricing_covered_duration_minutes" IS NOT NULL THEN
      RAISE EXCEPTION 'booking_draft_lines: DAILY line must not contain hourly/fixed duration fields';
    END IF;
    expected_buc := NEW."pricing_billed_days";
    IF NEW."billable_unit_count" <> expected_buc THEN
      RAISE EXCEPTION 'booking_draft_lines: DAILY billable_unit_count must equal billed_days';
    END IF;
    prod := NEW."unit_price_amount_minor"::numeric * NEW."pricing_billed_days"::numeric * NEW."quantity"::numeric;
    IF prod > 9007199254740991 THEN
      RAISE EXCEPTION 'booking_draft_lines: line total exceeds MAX_SAFE_INTEGER';
    END IF;
    expected_amount_before := prod::bigint;
    IF NEW."pricing_amount_before_discount_minor" <> expected_amount_before THEN
      RAISE EXCEPTION 'booking_draft_lines: DAILY amount_before_discount mismatch';
    END IF;
    -- P0-5 : remise canonique
    IF NEW."pricing_discount_threshold_days" IS NULL AND (NEW."pricing_discount_percent" IS NULL OR NEW."pricing_discount_percent" = 0) THEN
      IF NEW."pricing_amount_before_discount_minor" <> NEW."pricing_amount_after_discount_minor" THEN
        RAISE EXCEPTION 'booking_draft_lines: no discount requires amount_before = amount_after';
      END IF;
    ELSIF NEW."pricing_discount_threshold_days" IS NOT NULL AND NEW."pricing_discount_percent" IS NOT NULL THEN
      IF NEW."pricing_discount_threshold_days" < 2 THEN
        RAISE EXCEPTION 'booking_draft_lines: discount threshold must be >= 2';
      END IF;
      IF NEW."pricing_discount_percent" < 1 OR NEW."pricing_discount_percent" > 99 THEN
        RAISE EXCEPTION 'booking_draft_lines: discount percent must be between 1 and 99';
      END IF;
      IF NEW."pricing_billed_days" < NEW."pricing_discount_threshold_days" THEN
        RAISE EXCEPTION 'booking_draft_lines: billed_days must be >= threshold_days';
      END IF;
      expected_discount := floor((expected_amount_before::numeric * NEW."pricing_discount_percent"::numeric * 2 + 100) / 200);
      expected_amount_after := expected_amount_before - expected_discount;
      IF NEW."pricing_amount_after_discount_minor" <> expected_amount_after THEN
        RAISE EXCEPTION 'booking_draft_lines: amount_after does not match half-up rounding (expected %, got %)', expected_amount_after, NEW."pricing_amount_after_discount_minor";
      END IF;
      SELECT "threshold_days", "discount_percent"
        INTO best_threshold, best_percent
        FROM "multi_day_discount_tiers"
        WHERE "pricing_plan_id" = plan_record."id"
          AND "active" = true
          AND "threshold_days" <= NEW."pricing_billed_days"
        ORDER BY "threshold_days" DESC
        LIMIT 1;
      IF best_threshold IS NULL THEN
        RAISE EXCEPTION 'booking_draft_lines: no active discount tier found for the billed days';
      END IF;
      IF NEW."pricing_discount_threshold_days" <> best_threshold OR NEW."pricing_discount_percent" <> best_percent THEN
        RAISE EXCEPTION 'booking_draft_lines: selected discount tier is not the best applicable';
      END IF;
    ELSE
      RAISE EXCEPTION 'booking_draft_lines: partial discount representation is not allowed';
    END IF;
    IF NEW."line_total_amount_minor" <> NEW."pricing_amount_after_discount_minor" THEN
      RAISE EXCEPTION 'booking_draft_lines: DAILY line_total must equal amount_after_discount';
    END IF;
  END IF;

  -- G7P-B2-B Round 2 — Defect 2 : validation du snapshot de fenêtre (pricing_selected_window)
  -- Le snapshot doit être cohérent avec le plan_type et l'intent du parent.
  -- TIME_RANGE_WINDOW : { kind, weekdayMask, startTime, endTime }
  -- DAY_RANGE_BOUNDARIES : { kind, firstDay: { localDate, weekdayMask, startTime, endTime }, lastDay: { ... } }
  IF NEW."pricing_selected_window" IS NOT NULL THEN
    win_kind := NEW."pricing_selected_window"->>'kind';
    IF win_kind IS NULL THEN
      RAISE EXCEPTION 'booking_draft_lines: pricing_selected_window must have a "kind" field';
    END IF;

    IF win_kind = 'TIME_RANGE_WINDOW' THEN
      -- TIME_RANGE_WINDOW : valider la structure complète
      IF NEW."pricing_selected_window"->'weekdayMask' IS NULL OR
         NEW."pricing_selected_window"->'startTime' IS NULL OR
         NEW."pricing_selected_window"->'endTime' IS NULL THEN
        RAISE EXCEPTION 'booking_draft_lines: TIME_RANGE_WINDOW requires weekdayMask, startTime, endTime';
      END IF;
      -- TIME_RANGE_WINDOW est valide pour HOURLY, FIXED_DURATION et DAILY (TIME_RANGE intent)
      -- Invalide pour DAY_RANGE intent
      IF parent."pricing_intent_type" = 'DAY_RANGE' THEN
        RAISE EXCEPTION 'booking_draft_lines: DAY_RANGE intent requires DAY_RANGE_BOUNDARIES snapshot, got TIME_RANGE_WINDOW';
      END IF;
    ELSIF win_kind = 'DAY_RANGE_BOUNDARIES' THEN
      -- DAY_RANGE_BOUNDARIES : valider la structure complète
      IF NEW."pricing_selected_window"->'firstDay' IS NULL OR
         NEW."pricing_selected_window"->'lastDay' IS NULL THEN
        RAISE EXCEPTION 'booking_draft_lines: DAY_RANGE_BOUNDARIES requires firstDay and lastDay';
      END IF;
      IF NEW."pricing_selected_window"->'firstDay'->>'localDate' IS NULL OR
         NEW."pricing_selected_window"->'firstDay'->>'weekdayMask' IS NULL OR
         NEW."pricing_selected_window"->'firstDay'->>'startTime' IS NULL OR
         NEW."pricing_selected_window"->'firstDay'->>'endTime' IS NULL THEN
        RAISE EXCEPTION 'booking_draft_lines: DAY_RANGE_BOUNDARIES firstDay requires localDate, weekdayMask, startTime, endTime';
      END IF;
      IF NEW."pricing_selected_window"->'lastDay'->>'localDate' IS NULL OR
         NEW."pricing_selected_window"->'lastDay'->>'weekdayMask' IS NULL OR
         NEW."pricing_selected_window"->'lastDay'->>'startTime' IS NULL OR
         NEW."pricing_selected_window"->'lastDay'->>'endTime' IS NULL THEN
        RAISE EXCEPTION 'booking_draft_lines: DAY_RANGE_BOUNDARIES lastDay requires localDate, weekdayMask, startTime, endTime';
      END IF;
      -- DAY_RANGE_BOUNDARIES n'est valide que pour DAILY avec DAY_RANGE intent
      IF NEW."pricing_plan_type" <> 'DAILY' THEN
        RAISE EXCEPTION 'booking_draft_lines: DAY_RANGE_BOUNDARIES snapshot requires DAILY plan type, got %', NEW."pricing_plan_type";
      END IF;
      IF parent."pricing_intent_type" <> 'DAY_RANGE' THEN
        RAISE EXCEPTION 'booking_draft_lines: DAY_RANGE_BOUNDARIES snapshot requires DAY_RANGE intent, got %', parent."pricing_intent_type";
      END IF;
      -- Vérifier que firstDay.localDate et lastDay.localDate correspondent aux dates de l'intent snapshot
      intent_start_date := parent."pricing_intent_snapshot"->>'startDate';
      intent_end_date_exclusive := parent."pricing_intent_snapshot"->>'endDateExclusive';
      win_first_local_date := NEW."pricing_selected_window"->'firstDay'->>'localDate';
      win_last_local_date := NEW."pricing_selected_window"->'lastDay'->>'localDate';
      IF intent_start_date IS NOT NULL AND win_first_local_date IS NOT NULL AND
         win_first_local_date <> intent_start_date THEN
        RAISE EXCEPTION 'booking_draft_lines: DAY_RANGE_BOUNDARIES firstDay.localDate % does not match intent startDate %', win_first_local_date, intent_start_date;
      END IF;
      -- lastDay.localDate doit être la veille de endDateExclusive (dernier jour inclus)
      IF intent_end_date_exclusive IS NOT NULL AND win_last_local_date IS NOT NULL THEN
        -- Simple check: lastDay.localDate must be < endDateExclusive
        IF win_last_local_date >= intent_end_date_exclusive THEN
          RAISE EXCEPTION 'booking_draft_lines: DAY_RANGE_BOUNDARIES lastDay.localDate % must be before intent endDateExclusive %', win_last_local_date, intent_end_date_exclusive;
        END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'booking_draft_lines: pricing_selected_window has unknown kind %', win_kind;
    END IF;
  ELSE
    -- pricing_selected_window IS NULL
    -- DAY_RANGE + DAILY doit avoir un snapshot DAY_RANGE_BOUNDARIES non-null
    IF parent."pricing_intent_type" = 'DAY_RANGE' AND NEW."pricing_plan_type" = 'DAILY' THEN
      RAISE EXCEPTION 'booking_draft_lines: DAY_RANGE DAILY line requires non-null pricing_selected_window (DAY_RANGE_BOUNDARIES)';
    END IF;
    -- HOURLY et FIXED_DURATION peuvent avoir NULL (pas de fenêtre applicable)
    -- DAILY avec TIME_RANGE peut avoir NULL ou TIME_RANGE_WINDOW
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "before_enforce_draft_line_pricing_coherence" ON "booking_draft_lines";
CREATE TRIGGER "before_enforce_draft_line_pricing_coherence"
  BEFORE INSERT OR UPDATE ON "booking_draft_lines"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_draft_line_pricing_coherence"();


-- P0-2 / P0-4 — Cohérence et copie exacte des lignes de réservation
-- Source de vérité unique : la booking_draft_line explicitement référencée.
-- Aucune re-validation du catalogue (pricing_plans, translations, locations)
-- n'est effectuée : le snapshot reste figé au moment du devis.
-- Ordre de verrouillage : parent booking FOR SHARE, puis source booking_draft_line FOR SHARE.
-- Cela bloque tout UPDATE/DELETE concurrent sur la ligne source (snapshot figé).
CREATE OR REPLACE FUNCTION "enforce_booking_line_pricing_coherence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent "bookings"%ROWTYPE;
  source_line "booking_draft_lines"%ROWTYPE;
BEGIN
  SELECT * INTO parent
  FROM "bookings"
  WHERE "id" = NEW."booking_id"
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_lines: booking_id % does not exist', NEW."booking_id";
  END IF;

  -- Legacy parent => source_draft_line_id NULL et toutes les colonnes pricing_* NULL
  IF parent."pricing_snapshot_version" = 'legacy-daily-v1' THEN
    IF NEW."source_draft_line_id" IS NOT NULL THEN
      RAISE EXCEPTION 'booking_lines: legacy line must not reference a source draft line';
    END IF;
    IF NEW."pricing_plan_id" IS NOT NULL OR NEW."pricing_plan_version" IS NOT NULL OR
       NEW."pricing_plan_type" IS NOT NULL OR NEW."pricing_public_label" IS NOT NULL OR
       NEW."pricing_requested_duration_minutes" IS NOT NULL OR
       NEW."pricing_billed_duration_minutes" IS NOT NULL OR
       NEW."pricing_covered_duration_minutes" IS NOT NULL OR
       NEW."pricing_billed_days" IS NOT NULL OR
       NEW."pricing_selected_window" IS NOT NULL OR
       NEW."pricing_discount_threshold_days" IS NOT NULL OR
       NEW."pricing_discount_percent" IS NOT NULL OR
       NEW."pricing_amount_before_discount_minor" IS NOT NULL OR
       NEW."pricing_amount_after_discount_minor" IS NOT NULL THEN
      RAISE EXCEPTION 'booking_lines: legacy parent requires all pricing_* columns to be NULL';
    END IF;
    RETURN NEW;
  END IF;

  IF parent."pricing_snapshot_version" <> 'flexible-pricing-v1' THEN
    RETURN NEW;
  END IF;

  -- Flexible parent => source_draft_line_id obligatoire et non nul
  IF NEW."source_draft_line_id" IS NULL THEN
    RAISE EXCEPTION 'booking_lines: flexible parent requires source_draft_line_id';
  END IF;

  -- Copie exacte depuis la source booking_draft_line explicitement référencée
  SELECT * INTO source_line
  FROM "booking_draft_lines"
  WHERE "id" = NEW."source_draft_line_id"
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_lines: source draft line % not found', NEW."source_draft_line_id";
  END IF;

  IF source_line."draft_id" <> parent."draft_id" THEN
    RAISE EXCEPTION 'booking_lines: source draft line % does not belong to booking draft %', source_line."id", parent."draft_id";
  END IF;

  IF source_line."variant_id" <> NEW."variant_id" THEN
    RAISE EXCEPTION 'booking_lines: source draft line variant_id mismatch';
  END IF;

  IF NEW."pricing_plan_id" IS DISTINCT FROM source_line."pricing_plan_id" OR
     NEW."pricing_plan_version" IS DISTINCT FROM source_line."pricing_plan_version" OR
     NEW."pricing_plan_type" IS DISTINCT FROM source_line."pricing_plan_type" OR
     NEW."pricing_public_label" IS DISTINCT FROM source_line."pricing_public_label" OR
     NEW."pricing_requested_duration_minutes" IS DISTINCT FROM source_line."pricing_requested_duration_minutes" OR
     NEW."pricing_billed_duration_minutes" IS DISTINCT FROM source_line."pricing_billed_duration_minutes" OR
     NEW."pricing_covered_duration_minutes" IS DISTINCT FROM source_line."pricing_covered_duration_minutes" OR
     NEW."pricing_billed_days" IS DISTINCT FROM source_line."pricing_billed_days" OR
     NEW."pricing_selected_window" IS DISTINCT FROM source_line."pricing_selected_window" OR
     NEW."pricing_discount_threshold_days" IS DISTINCT FROM source_line."pricing_discount_threshold_days" OR
     NEW."pricing_discount_percent" IS DISTINCT FROM source_line."pricing_discount_percent" OR
     NEW."pricing_amount_before_discount_minor" IS DISTINCT FROM source_line."pricing_amount_before_discount_minor" OR
     NEW."pricing_amount_after_discount_minor" IS DISTINCT FROM source_line."pricing_amount_after_discount_minor" OR
     NEW."unit_price_amount_minor" IS DISTINCT FROM source_line."unit_price_amount_minor" OR
     NEW."billable_unit_count" IS DISTINCT FROM source_line."billable_unit_count" OR
     NEW."quantity" IS DISTINCT FROM source_line."quantity" OR
     NEW."currency" IS DISTINCT FROM source_line."currency" OR
     NEW."line_total_amount_minor" IS DISTINCT FROM source_line."line_total_amount_minor" OR
     NEW."variant_snapshot" IS DISTINCT FROM source_line."variant_snapshot" THEN
    RAISE EXCEPTION 'booking_lines: snapshot does not match source draft line %', source_line."id";
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "before_enforce_booking_line_pricing_coherence" ON "booking_lines";
CREATE TRIGGER "before_enforce_booking_line_pricing_coherence"
  BEFORE INSERT OR UPDATE ON "booking_lines"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_booking_line_pricing_coherence"();


-- P0-6 — Déclencheurs DEFERRABLE INITIALLY DEFERRED de vérification agrégée
CREATE OR REPLACE FUNCTION "validate_flexible_draft_aggregates"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_id uuid;
  parent "booking_drafts"%ROWTYPE;
  computed_subtotal bigint;
  line_count integer;
  child_currency text;
  currency_mismatch integer;
BEGIN
  IF TG_TABLE_NAME = 'booking_draft_lines' THEN
    parent_id := COALESCE(NEW."draft_id", OLD."draft_id");
  ELSIF TG_TABLE_NAME = 'booking_drafts' THEN
    parent_id := NEW."id";
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT * INTO parent FROM "booking_drafts" WHERE "id" = parent_id;
  IF NOT FOUND OR parent."pricing_snapshot_version" <> 'flexible-pricing-v1' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT count(*), COALESCE(sum("line_total_amount_minor"), 0)
    INTO line_count, computed_subtotal
  FROM "booking_draft_lines"
  WHERE "draft_id" = parent_id;

  IF parent."pricing_snapshot_version" = 'flexible-pricing-v1' AND line_count = 0 THEN
    RAISE EXCEPTION 'booking_drafts: flexible draft must have at least one line';
  END IF;

  IF line_count > 0 AND computed_subtotal <> parent."subtotal_amount_minor" THEN
    RAISE EXCEPTION 'booking_drafts: subtotal_amount_minor % does not match sum of line totals %', parent."subtotal_amount_minor", computed_subtotal;
  END IF;

  IF parent."total_amount_minor" <> parent."subtotal_amount_minor" + parent."mandatory_fees_amount_minor" THEN
    RAISE EXCEPTION 'booking_drafts: total_amount_minor must equal subtotal + mandatory_fees';
  END IF;

  SELECT count(DISTINCT "currency"), count(*) FILTER (WHERE "currency" <> parent."currency")
    INTO child_currency, currency_mismatch
  FROM "booking_draft_lines"
  WHERE "draft_id" = parent_id;

  IF currency_mismatch > 0 THEN
    RAISE EXCEPTION 'booking_draft_lines: all lines must use the parent currency %', parent."currency";
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS "after_validate_flexible_draft_aggregates_line" ON "booking_draft_lines";
CREATE CONSTRAINT TRIGGER "after_validate_flexible_draft_aggregates_line"
  AFTER INSERT OR UPDATE OR DELETE ON "booking_draft_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "validate_flexible_draft_aggregates"();

DROP TRIGGER IF EXISTS "after_validate_flexible_draft_aggregates_draft" ON "booking_drafts";
CREATE CONSTRAINT TRIGGER "after_validate_flexible_draft_aggregates_draft"
  AFTER INSERT OR UPDATE OF "status" ON "booking_drafts"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "validate_flexible_draft_aggregates"();

CREATE OR REPLACE FUNCTION "validate_flexible_booking_aggregates"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_id uuid;
  parent "bookings"%ROWTYPE;
  computed_subtotal bigint;
  line_count integer;
  currency_mismatch integer;
BEGIN
  IF TG_TABLE_NAME = 'booking_lines' THEN
    parent_id := COALESCE(NEW."booking_id", OLD."booking_id");
  ELSIF TG_TABLE_NAME = 'bookings' THEN
    parent_id := NEW."id";
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT * INTO parent FROM "bookings" WHERE "id" = parent_id;
  IF NOT FOUND OR parent."pricing_snapshot_version" <> 'flexible-pricing-v1' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT count(*), COALESCE(sum("line_total_amount_minor"), 0)
    INTO line_count, computed_subtotal
  FROM "booking_lines"
  WHERE "booking_id" = parent_id;

  IF line_count = 0 THEN
    RAISE EXCEPTION 'bookings: flexible booking must have at least one line';
  END IF;

  IF computed_subtotal <> parent."subtotal_amount_minor" THEN
    RAISE EXCEPTION 'bookings: subtotal_amount_minor % does not match sum of line totals %', parent."subtotal_amount_minor", computed_subtotal;
  END IF;

  IF parent."total_amount_minor" <> parent."subtotal_amount_minor" + parent."mandatory_fees_amount_minor" THEN
    RAISE EXCEPTION 'bookings: total_amount_minor must equal subtotal + mandatory_fees';
  END IF;

  SELECT count(*) FILTER (WHERE "currency" <> parent."currency")
    INTO currency_mismatch
  FROM "booking_lines"
  WHERE "booking_id" = parent_id;

  IF currency_mismatch > 0 THEN
    RAISE EXCEPTION 'booking_lines: all lines must use the parent currency %', parent."currency";
  END IF;

  -- Root snapshot must be an exact copy of the source booking_drafts row.
  -- G7P-B2-C Round 3 (P0-2) — tax/commission/terms fields are NOT part of the
  -- exact copy check. They come from `payments` (authority ADR-010 §6), resolved
  -- at payment initiation. The draft has tax_status='UNDETERMINED' and
  -- commission_amount_minor=NULL, which are not valid on bookings. Only rental
  -- pricing, period, timezone, and pricing snapshot fields are verified here.
  IF TG_TABLE_NAME = 'bookings' THEN
    DECLARE
      source "booking_drafts"%ROWTYPE;
    BEGIN
      SELECT * INTO source FROM "booking_drafts" WHERE "id" = parent."draft_id";
      IF FOUND THEN
        IF parent."organization_id" IS DISTINCT FROM source."organization_id" OR
           parent."location_id" IS DISTINCT FROM source."location_id" OR
           parent."customer_user_id" IS DISTINCT FROM source."customer_user_id" OR
           parent."customer_start_at" IS DISTINCT FROM source."customer_start_at" OR
           parent."customer_end_at" IS DISTINCT FROM source."customer_end_at" OR
           parent."blocked_start_at" IS DISTINCT FROM source."blocked_start_at" OR
           parent."blocked_end_at" IS DISTINCT FROM source."blocked_end_at" OR
           parent."timezone" IS DISTINCT FROM source."timezone" OR
           parent."prep_buffer_minutes" IS DISTINCT FROM source."prep_buffer_minutes" OR
           parent."cleanup_buffer_minutes" IS DISTINCT FROM source."cleanup_buffer_minutes" OR
           parent."currency" IS DISTINCT FROM source."currency" OR
           parent."subtotal_amount_minor" IS DISTINCT FROM source."subtotal_amount_minor" OR
           parent."mandatory_fees_amount_minor" IS DISTINCT FROM source."mandatory_fees_amount_minor" OR
           parent."total_amount_minor" IS DISTINCT FROM source."total_amount_minor" OR
           parent."billable_unit" IS DISTINCT FROM source."billable_unit" OR
           parent."billable_unit_count" IS DISTINCT FROM source."billable_unit_count" OR
           parent."cancellation_policy_snapshot" IS DISTINCT FROM source."cancellation_policy_snapshot" OR
           parent."pricing_snapshot_version" IS DISTINCT FROM source."pricing_snapshot_version" OR
           parent."pricing_algorithm_version" IS DISTINCT FROM source."pricing_algorithm_version" OR
           parent."pricing_rounding_rule_version" IS DISTINCT FROM source."pricing_rounding_rule_version" OR
           parent."pricing_intent_type" IS DISTINCT FROM source."pricing_intent_type" OR
           parent."pricing_intent_snapshot" IS DISTINCT FROM source."pricing_intent_snapshot" OR
           parent."pricing_resolved_locale" IS DISTINCT FROM source."pricing_resolved_locale" THEN
          RAISE EXCEPTION 'bookings: root row must be an exact copy of booking_drafts id % (fields differ)', source."id";
        END IF;
      END IF;
    END;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS "after_validate_flexible_booking_aggregates_line" ON "booking_lines";
CREATE CONSTRAINT TRIGGER "after_validate_flexible_booking_aggregates_line"
  AFTER INSERT OR UPDATE OR DELETE ON "booking_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "validate_flexible_booking_aggregates"();

DROP TRIGGER IF EXISTS "after_validate_flexible_booking_aggregates_booking" ON "bookings";
CREATE CONSTRAINT TRIGGER "after_validate_flexible_booking_aggregates_booking"
  AFTER INSERT OR UPDATE OF "status" ON "bookings"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "validate_flexible_booking_aggregates"();

-- P1 — Mise à jour des déclencheurs d'immutabilité
CREATE OR REPLACE FUNCTION "enforce_draft_financial_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('HELD', 'PAYMENT_PROCESSING') THEN
      RAISE EXCEPTION 'booking_drafts: DELETE is not allowed when status is %', OLD."status";
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."location_id" IS DISTINCT FROM OLD."location_id"
     OR NEW."customer_user_id" IS DISTINCT FROM OLD."customer_user_id"
     OR NEW."customer_start_at" IS DISTINCT FROM OLD."customer_start_at"
     OR NEW."customer_end_at" IS DISTINCT FROM OLD."customer_end_at"
     OR NEW."blocked_start_at" IS DISTINCT FROM OLD."blocked_start_at"
     OR NEW."blocked_end_at" IS DISTINCT FROM OLD."blocked_end_at"
     OR NEW."timezone" IS DISTINCT FROM OLD."timezone"
     OR NEW."prep_buffer_minutes" IS DISTINCT FROM OLD."prep_buffer_minutes"
     OR NEW."cleanup_buffer_minutes" IS DISTINCT FROM OLD."cleanup_buffer_minutes"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."subtotal_amount_minor" IS DISTINCT FROM OLD."subtotal_amount_minor"
     OR NEW."mandatory_fees_amount_minor" IS DISTINCT FROM OLD."mandatory_fees_amount_minor"
     OR NEW."total_amount_minor" IS DISTINCT FROM OLD."total_amount_minor"
     OR NEW."tax_status" IS DISTINCT FROM OLD."tax_status"
     OR NEW."tax_amount_minor" IS DISTINCT FROM OLD."tax_amount_minor"
     OR NEW."tax_rate_bps" IS DISTINCT FROM OLD."tax_rate_bps"
     OR NEW."commission_amount_minor" IS DISTINCT FROM OLD."commission_amount_minor"
     OR NEW."billable_unit" IS DISTINCT FROM OLD."billable_unit"
     OR NEW."billable_unit_count" IS DISTINCT FROM OLD."billable_unit_count"
     OR NEW."cancellation_policy_snapshot" IS DISTINCT FROM OLD."cancellation_policy_snapshot"
     OR NEW."pricing_snapshot_version" IS DISTINCT FROM OLD."pricing_snapshot_version"
     OR NEW."pricing_algorithm_version" IS DISTINCT FROM OLD."pricing_algorithm_version"
     OR NEW."pricing_rounding_rule_version" IS DISTINCT FROM OLD."pricing_rounding_rule_version"
     OR NEW."pricing_intent_type" IS DISTINCT FROM OLD."pricing_intent_type"
     OR NEW."pricing_intent_snapshot" IS DISTINCT FROM OLD."pricing_intent_snapshot"
     OR NEW."pricing_resolved_locale" IS DISTINCT FROM OLD."pricing_resolved_locale"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'booking_drafts: financial snapshot is immutable — only status, expires_at and updated_at may change';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "before_check_draft_financial_immutability" ON "booking_drafts";
CREATE TRIGGER "before_check_draft_financial_immutability"
  BEFORE UPDATE OR DELETE ON "booking_drafts"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_draft_financial_immutability"();

CREATE OR REPLACE FUNCTION "enforce_draft_line_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent "booking_drafts"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO parent FROM "booking_drafts" WHERE "id" = NEW."draft_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cannot insert draft line: parent draft does not exist';
    END IF;
    IF parent."pricing_snapshot_version" = 'legacy-daily-v1' THEN
      RETURN NEW;
    END IF;
    IF parent."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Cannot insert draft line: parent draft is not DRAFT (status=%)', parent."status";
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."draft_id" IS DISTINCT FROM OLD."draft_id" OR NEW."variant_id" IS DISTINCT FROM OLD."variant_id" THEN
      RAISE EXCEPTION 'Cannot update draft line: draft_id and variant_id are immutable';
    END IF;
    SELECT * INTO parent FROM "booking_drafts" WHERE "id" = NEW."draft_id";
    IF NOT FOUND OR parent."status" = 'DRAFT' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Cannot update draft line: parent draft is not DRAFT (status=%)', parent."status";
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT * INTO parent FROM "booking_drafts" WHERE "id" = OLD."draft_id";
    IF NOT FOUND OR parent."status" = 'DRAFT' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Cannot delete draft line: parent draft is not DRAFT (status=%)', parent."status";
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS "before_check_draft_line_immutability" ON "booking_draft_lines";
CREATE TRIGGER "before_check_draft_line_immutability"
  BEFORE INSERT OR UPDATE OR DELETE ON "booking_draft_lines"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_draft_line_immutability"();

CREATE OR REPLACE FUNCTION "enforce_booking_financial_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bookings: DELETE is not allowed (bookings are immutable after confirmation)';
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."location_id" IS DISTINCT FROM OLD."location_id"
     OR NEW."customer_user_id" IS DISTINCT FROM OLD."customer_user_id"
     OR NEW."draft_id" IS DISTINCT FROM OLD."draft_id"
     OR NEW."payment_id" IS DISTINCT FROM OLD."payment_id"
     OR NEW."customer_start_at" IS DISTINCT FROM OLD."customer_start_at"
     OR NEW."customer_end_at" IS DISTINCT FROM OLD."customer_end_at"
     OR NEW."blocked_start_at" IS DISTINCT FROM OLD."blocked_start_at"
     OR NEW."blocked_end_at" IS DISTINCT FROM OLD."blocked_end_at"
     OR NEW."prep_buffer_minutes" IS DISTINCT FROM OLD."prep_buffer_minutes"
     OR NEW."cleanup_buffer_minutes" IS DISTINCT FROM OLD."cleanup_buffer_minutes"
     OR NEW."timezone" IS DISTINCT FROM OLD."timezone"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."subtotal_amount_minor" IS DISTINCT FROM OLD."subtotal_amount_minor"
     OR NEW."mandatory_fees_amount_minor" IS DISTINCT FROM OLD."mandatory_fees_amount_minor"
     OR NEW."tax_status" IS DISTINCT FROM OLD."tax_status"
     OR NEW."tax_amount_minor" IS DISTINCT FROM OLD."tax_amount_minor"
     OR NEW."tax_rate_bps" IS DISTINCT FROM OLD."tax_rate_bps"
     OR NEW."commission_amount_minor" IS DISTINCT FROM OLD."commission_amount_minor"
     OR NEW."total_amount_minor" IS DISTINCT FROM OLD."total_amount_minor"
     OR NEW."billable_unit" IS DISTINCT FROM OLD."billable_unit"
     OR NEW."billable_unit_count" IS DISTINCT FROM OLD."billable_unit_count"
     OR NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at"
     OR NEW."pricing_snapshot_version" IS DISTINCT FROM OLD."pricing_snapshot_version"
     OR NEW."pricing_algorithm_version" IS DISTINCT FROM OLD."pricing_algorithm_version"
     OR NEW."pricing_rounding_rule_version" IS DISTINCT FROM OLD."pricing_rounding_rule_version"
     OR NEW."pricing_intent_type" IS DISTINCT FROM OLD."pricing_intent_type"
     OR NEW."pricing_intent_snapshot" IS DISTINCT FROM OLD."pricing_intent_snapshot"
     OR NEW."pricing_resolved_locale" IS DISTINCT FROM OLD."pricing_resolved_locale"
     OR NEW."cancellation_policy_snapshot" IS DISTINCT FROM OLD."cancellation_policy_snapshot"
     OR NEW."terms_acceptance_snapshot" IS DISTINCT FROM OLD."terms_acceptance_snapshot"
     OR NEW."tax_rule_snapshot" IS DISTINCT FROM OLD."tax_rule_snapshot"
     OR NEW."commission_rule_snapshot" IS DISTINCT FROM OLD."commission_rule_snapshot"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'bookings: financial snapshot is immutable — only status and updated_at may change';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "before_check_booking_financial_immutability" ON "bookings";
CREATE TRIGGER "before_check_booking_financial_immutability"
  BEFORE UPDATE OR DELETE ON "bookings"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_booking_financial_immutability"();

CREATE OR REPLACE FUNCTION "enforce_booking_line_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cannot delete booking line: bookings are immutable';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Cannot update booking line: bookings are immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS "before_check_booking_line_immutability" ON "booking_lines";
CREATE TRIGGER "before_check_booking_line_immutability"
  BEFORE UPDATE OR DELETE ON "booking_lines"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_booking_line_immutability"();

-- Suppression des fonctions de cohérence intent/plan devenues redondantes
DROP TRIGGER IF EXISTS "before_check_draft_line_intent_plan_coherence" ON "booking_draft_lines";
DROP FUNCTION IF EXISTS "enforce_draft_line_intent_plan_coherence"();
DROP TRIGGER IF EXISTS "before_check_booking_line_intent_plan_coherence" ON "booking_lines";
DROP FUNCTION IF EXISTS "enforce_booking_line_intent_plan_coherence"();
