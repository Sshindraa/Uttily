-- Migration 0056 : séries de blocages manuels récurrents (ADR-038).
--
-- Le calendrier reste en temps civil dans le fuseau de l'établissement. Chaque
-- occurrence est matérialisée dans inventory_blocks comme MANUAL_BLOCK ; cette
-- migration n'ajoute aucun traitement automatique ni aucune catégorie.

CREATE TABLE IF NOT EXISTS "manual_block_series" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "location_id" uuid NOT NULL REFERENCES "locations"("id"),
  "inventory_item_id" uuid NOT NULL REFERENCES "inventory_items"("id"),
  "frequency" text NOT NULL DEFAULT 'WEEKLY',
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "start_time" time NOT NULL,
  "end_time" time NOT NULL,
  "time_zone" text NOT NULL,
  "status" text NOT NULL DEFAULT 'ACTIVE',
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "manual_block_series_frequency_valid"
    CHECK ("frequency" = 'WEEKLY'),
  CONSTRAINT "manual_block_series_date_bounds_valid"
    CHECK ("end_date" >= "start_date" AND "end_date" - "start_date" <= 84),
  CONSTRAINT "manual_block_series_time_bounds_valid"
    CHECK ("end_time" > "start_time"),
  CONSTRAINT "manual_block_series_status_valid"
    CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
  CONSTRAINT "manual_block_series_deleted_state_valid"
    CHECK (("status" = 'DELETED' AND "deleted_at" IS NOT NULL)
      OR ("status" <> 'DELETED' AND "deleted_at" IS NULL))
);

CREATE INDEX IF NOT EXISTS "manual_block_series_organization_idx"
  ON "manual_block_series" ("organization_id", "status");
CREATE INDEX IF NOT EXISTS "manual_block_series_item_idx"
  ON "manual_block_series" ("inventory_item_id", "status");

CREATE TABLE IF NOT EXISTS "manual_block_series_occurrences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "series_id" uuid NOT NULL REFERENCES "manual_block_series"("id") ON DELETE RESTRICT,
  "inventory_block_id" uuid NOT NULL UNIQUE REFERENCES "inventory_blocks"("id") ON DELETE RESTRICT,
  "occurrence_date" date NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "manual_block_series_occurrence_date_unique"
    UNIQUE ("series_id", "occurrence_date")
);

CREATE INDEX IF NOT EXISTS "manual_block_series_occurrences_series_idx"
  ON "manual_block_series_occurrences" ("series_id", "occurrence_date");

CREATE OR REPLACE FUNCTION check_manual_block_series_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item_org uuid;
  item_location uuid;
  location_org uuid;
BEGIN
  SELECT organization_id, current_location_id
    INTO item_org, item_location
    FROM inventory_items
   WHERE id = NEW.inventory_item_id;
  SELECT organization_id INTO location_org
    FROM locations
   WHERE id = NEW.location_id;

  IF item_org IS NULL OR location_org IS NULL
     OR item_org <> NEW.organization_id
     OR location_org <> NEW.organization_id
     OR item_location <> NEW.location_id THEN
    RAISE EXCEPTION
      'manual_block_series organization, location and inventory item must be consistent';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS before_check_manual_block_series_scope ON "manual_block_series";
CREATE TRIGGER before_check_manual_block_series_scope
  BEFORE INSERT OR UPDATE ON "manual_block_series"
  FOR EACH ROW EXECUTE FUNCTION check_manual_block_series_scope();

CREATE OR REPLACE FUNCTION check_manual_block_series_occurrence_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  series_org uuid;
  series_item uuid;
  block_org uuid;
  block_item uuid;
  block_type text;
  block_source uuid;
BEGIN
  SELECT organization_id, inventory_item_id
    INTO series_org, series_item
    FROM manual_block_series
   WHERE id = NEW.series_id;
  SELECT organization_id, inventory_item_id, type, source_id
    INTO block_org, block_item, block_type, block_source
    FROM inventory_blocks
   WHERE id = NEW.inventory_block_id;

  IF series_org IS NULL OR block_org IS NULL
     OR block_type <> 'MANUAL_BLOCK'
     OR series_org <> block_org
     OR series_item <> block_item
     OR block_source IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION
      'manual_block_series occurrence must link the matching MANUAL_BLOCK';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS before_check_manual_block_series_occurrence_consistency
  ON "manual_block_series_occurrences";
CREATE TRIGGER before_check_manual_block_series_occurrence_consistency
  BEFORE INSERT OR UPDATE ON "manual_block_series_occurrences"
  FOR EACH ROW EXECUTE FUNCTION check_manual_block_series_occurrence_consistency();
