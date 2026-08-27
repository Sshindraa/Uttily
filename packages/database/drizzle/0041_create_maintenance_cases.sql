-- Migration 0041 : création de la table maintenance_cases (Chantier 9.1).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'maintenance_case_status') THEN
    CREATE TYPE "maintenance_case_status" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "maintenance_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "inventory_item_id" uuid NOT NULL REFERENCES "inventory_items"("id"),
  "maintenance_block_id" uuid NOT NULL REFERENCES "inventory_blocks"("id"),
  "source_damage_report_id" uuid REFERENCES "damage_reports"("id"),
  "status" "maintenance_case_status" NOT NULL DEFAULT 'OPEN',
  "reason" text NOT NULL,
  "opened_notes" text,
  "opened_by" uuid NOT NULL REFERENCES "users"("id"),
  "opened_at" timestamp with time zone NOT NULL DEFAULT now(),
  "started_by" uuid REFERENCES "users"("id"),
  "started_at" timestamp with time zone,
  "resolution_notes" text,
  "resolved_by" uuid REFERENCES "users"("id"),
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "maintenance_cases_org_status_index" ON "maintenance_cases" ("organization_id", "status");
CREATE INDEX IF NOT EXISTS "maintenance_cases_item_index" ON "maintenance_cases" ("inventory_item_id");
CREATE INDEX IF NOT EXISTS "maintenance_cases_block_index" ON "maintenance_cases" ("maintenance_block_id");
