-- Migration 0005 : table locations (établissements de retrait).
-- MVP : retrait en établissement uniquement (décision open-questions).
-- geo_point est de type geometry(Point, 4326) déclaré explicitement en SQL
-- (ADR-004) : Drizzle ne gère pas nativement les types PostGIS.

CREATE TABLE "locations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "time_zone" text NOT NULL,
  "address_line1" text,
  "address_line2" text,
  "city" text,
  "postal_code" text,
  "country_code" text,
  "geo_point" geometry(Point, 4326),
  "pickup_enabled" boolean NOT NULL DEFAULT true,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Slug unique par organisation (pas globalement).
ALTER TABLE "locations"
  ADD CONSTRAINT "locations_organization_slug_unique"
  UNIQUE ("organization_id", "slug");

ALTER TABLE "locations"
  ADD CONSTRAINT "locations_slug_format"
  CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');

ALTER TABLE "locations"
  ADD CONSTRAINT "locations_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;

CREATE INDEX "locations_organization_id_index" ON "locations" ("organization_id");
CREATE INDEX "locations_geo_point_index" ON "locations" USING GIST ("geo_point");
