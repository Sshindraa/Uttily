-- Migration 0031 : G7C-R3 — fondations de recherche publique (alignement définitif).
--
-- Identifiants publics stables et immuables, pays commercialement activables,
-- destinations internationales avec bounding box et traductions par locale,
-- garde de publication minimale renforcée. Cette migration est volontairement
-- sans seed ni index géospatial : l'indexation de recherche publique relève
-- de G7D (non démarré).
--
-- La France sera le premier pays activé (par configuration opérationnelle
-- ultérieure, pas par seed dans cette migration).

-- 1. Table countries (pays commercialement activables)
CREATE TABLE "countries" (
  "country_code" text PRIMARY KEY,
  "is_active" boolean NOT NULL DEFAULT false,
  "default_currency" text NOT NULL,
  "default_locale" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "countries_country_code_format" CHECK ("country_code" ~ '^[A-Z]{2}$'),
  CONSTRAINT "countries_default_currency_iso" CHECK ("default_currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "countries_default_locale_format" CHECK ("default_locale" ~ '^[a-z]{2}(-[A-Z]{2})?$')
);

-- 2. Table destinations (évolution internationale, sans label — les libellés
--    sont dans destination_translations)
CREATE TABLE "destinations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "slug" text NOT NULL,
  "country_code" text NOT NULL,
  "place_type" text NOT NULL,
  "center" geometry(Point, 4326) NOT NULL,
  "bbox_south" double precision NOT NULL,
  "bbox_west" double precision NOT NULL,
  "bbox_north" double precision NOT NULL,
  "bbox_east" double precision NOT NULL,
  "is_active" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "destinations_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "destinations_slug_unique" UNIQUE ("slug"),
  CONSTRAINT "destinations_country_code_fk" FOREIGN KEY ("country_code") REFERENCES "countries"("country_code"),
  CONSTRAINT "destinations_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT "destinations_place_type_valid" CHECK ("place_type" IN ('COUNTRY', 'REGION', 'CITY', 'LOCALITY', 'POINT_OF_INTEREST')),
  CONSTRAINT "destinations_sort_order_nonneg" CHECK ("sort_order" >= 0),
  CONSTRAINT "destinations_center_not_empty" CHECK (NOT ST_IsEmpty("center")),
  CONSTRAINT "destinations_center_longitude_range" CHECK (ST_X("center") >= -180 AND ST_X("center") <= 180),
  CONSTRAINT "destinations_center_latitude_range" CHECK (ST_Y("center") >= -90 AND ST_Y("center") <= 90),
  CONSTRAINT "destinations_bbox_lat_range" CHECK ("bbox_south" >= -90 AND "bbox_south" <= 90 AND "bbox_north" >= -90 AND "bbox_north" <= 90),
  CONSTRAINT "destinations_bbox_lon_range" CHECK ("bbox_west" >= -180 AND "bbox_west" <= 180 AND "bbox_east" >= -180 AND "bbox_east" <= 180),
  -- bbox_south < bbox_north (strictement, vérifiable).
  -- NE PAS imposer bbox_west <= bbox_east : une zone traversant l'antiméridien
  -- (ex. Pacifique) a bbox_west > bbox_east (ex. west=170, east=-170).
  -- Les coordonnées bbox sont stockées en degrés décimaux (double precision),
  -- pas en geometry, pour simplifier les validations et permettre la
  -- représentation antiméridien.
  CONSTRAINT "destinations_bbox_south_lt_north" CHECK ("bbox_south" < "bbox_north"),
  CONSTRAINT "destinations_active_not_deleted" CHECK (NOT "is_active" OR "deleted_at" IS NULL)
);

-- 3. Table destination_translations (libellés par locale)
CREATE TABLE "destination_translations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "destination_id" uuid NOT NULL,
  "locale" text NOT NULL,
  "label" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "destination_translations_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "destinations"("id") ON DELETE CASCADE,
  CONSTRAINT "destination_translations_destination_locale_unique" UNIQUE ("destination_id", "locale"),
  CONSTRAINT "destination_translations_locale_format" CHECK ("locale" ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  CONSTRAINT "destination_translations_label_not_empty" CHECK (length(btrim("label")) > 0)
);

-- 4. organizations.public_display_name (conservé)
ALTER TABLE "organizations" ADD COLUMN "public_display_name" text;
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_public_display_name_not_empty"
  CHECK ("public_display_name" IS NULL OR length(btrim("public_display_name")) > 0);

-- 5. products.public_id (conservé, avec backfill)
ALTER TABLE "products" ADD COLUMN "public_id" uuid DEFAULT gen_random_uuid();
UPDATE "products" SET "public_id" = gen_random_uuid() WHERE "public_id" IS NULL;
ALTER TABLE "products" ALTER COLUMN "public_id" SET NOT NULL;
ALTER TABLE "products" ADD CONSTRAINT "products_public_id_unique" UNIQUE ("public_id");

-- 6. locations.public_id et is_publicly_listed (conservé, avec backfill)
ALTER TABLE "locations" ADD COLUMN "public_id" uuid DEFAULT gen_random_uuid();
UPDATE "locations" SET "public_id" = gen_random_uuid() WHERE "public_id" IS NULL;
ALTER TABLE "locations" ALTER COLUMN "public_id" SET NOT NULL;
ALTER TABLE "locations" ADD CONSTRAINT "locations_public_id_unique" UNIQUE ("public_id");
ALTER TABLE "locations" ADD COLUMN "is_publicly_listed" boolean NOT NULL DEFAULT false;

-- 7. Renforcer locations_public_listing_requirements
ALTER TABLE "locations" DROP CONSTRAINT IF EXISTS "locations_public_listing_requirements";
ALTER TABLE "locations"
  ADD CONSTRAINT "locations_public_listing_requirements"
  CHECK (
    NOT "is_publicly_listed"
    OR (
      "pickup_enabled"
      AND "geo_point" IS NOT NULL
      AND "deleted_at" IS NULL
      AND "address_line1" IS NOT NULL AND length(btrim("address_line1")) > 0
      AND "city" IS NOT NULL AND length(btrim("city")) > 0
      AND "country_code" IS NOT NULL
      AND "country_code" ~ '^[A-Z]{2}$'
    )
  );

-- 8. Fonction d'immutabilité des public_id (conservée)
CREATE OR REPLACE FUNCTION "prevent_public_id_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.public_id IS NULL OR NEW.public_id IS DISTINCT FROM OLD.public_id THEN
    RAISE EXCEPTION 'public_id is immutable and must not be null';
  END IF;
  RETURN NEW;
END;
$$;

-- 9. Triggers d'immutabilité des public_id (conservés)
CREATE TRIGGER "prevent_destinations_public_id_mutation"
  BEFORE UPDATE OF "public_id" ON "destinations"
  FOR EACH ROW
  EXECUTE FUNCTION "prevent_public_id_mutation"();

CREATE TRIGGER "prevent_products_public_id_mutation"
  BEFORE UPDATE OF "public_id" ON "products"
  FOR EACH ROW
  EXECUTE FUNCTION "prevent_public_id_mutation"();

CREATE TRIGGER "prevent_locations_public_id_mutation"
  BEFORE UPDATE OF "public_id" ON "locations"
  FOR EACH ROW
  EXECUTE FUNCTION "prevent_public_id_mutation"();

-- 10. Fonction : activation destination requiert pays actif + traductions FR+EN
CREATE OR REPLACE FUNCTION "check_destination_activation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  country_active boolean;
  has_fr boolean;
  has_en boolean;
BEGIN
  IF NEW.is_active = true THEN
    SELECT c.is_active INTO country_active
    FROM "countries" c
    WHERE c.country_code = NEW.country_code;
    IF country_active IS NULL OR country_active = false THEN
      RAISE EXCEPTION 'Destination cannot be activated: country % is not active', NEW.country_code;
    END IF;

    SELECT EXISTS(
      SELECT 1 FROM "destination_translations" dt
      WHERE dt.destination_id = NEW.id AND dt.locale = 'fr'
    ) INTO has_fr;
    IF has_fr = false THEN
      RAISE EXCEPTION 'Destination cannot be activated: missing FR translation';
    END IF;

    SELECT EXISTS(
      SELECT 1 FROM "destination_translations" dt
      WHERE dt.destination_id = NEW.id AND dt.locale = 'en'
    ) INTO has_en;
    IF has_en = false THEN
      RAISE EXCEPTION 'Destination cannot be activated: missing EN translation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 11. Trigger : activation destination
CREATE TRIGGER "before_check_destination_activation"
  BEFORE INSERT OR UPDATE OF "is_active", "country_code" ON "destinations"
  FOR EACH ROW
  EXECUTE FUNCTION "check_destination_activation"();

-- 12. Fonction : protection des traductions FR/EN d'une destination active
CREATE OR REPLACE FUNCTION "protect_destination_required_translations"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  dest_active boolean;
BEGIN
  SELECT d.is_active INTO dest_active
  FROM "destinations" d
  WHERE d.id = OLD.destination_id;

  IF dest_active = true THEN
    IF TG_OP = 'DELETE' AND OLD.locale IN ('fr', 'en') THEN
      RAISE EXCEPTION 'Cannot delete % translation of an active destination', OLD.locale;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.locale IN ('fr', 'en') THEN
      IF NEW.locale IS DISTINCT FROM OLD.locale THEN
        RAISE EXCEPTION 'Cannot change locale of % translation of an active destination', OLD.locale;
      END IF;
      IF NEW.destination_id IS DISTINCT FROM OLD.destination_id THEN
        RAISE EXCEPTION 'Cannot move % translation of an active destination to another destination', OLD.locale;
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- 13. Trigger : protection des traductions FR/EN
CREATE TRIGGER "before_protect_destination_translations"
  BEFORE DELETE OR UPDATE ON "destination_translations"
  FOR EACH ROW
  EXECUTE FUNCTION "protect_destination_required_translations"();

-- 14. Index justifiés (pas d'index spatial — pas de requête G7D réelle)
CREATE INDEX "countries_is_active_index" ON "countries" ("is_active") WHERE "is_active" = true;
CREATE INDEX "destinations_active_by_country_type_order_index" ON "destinations" ("country_code", "place_type", "sort_order") WHERE "is_active" = true AND "deleted_at" IS NULL;
CREATE INDEX "destination_translations_destination_locale_index" ON "destination_translations" ("destination_id", "locale");
CREATE INDEX "locations_publicly_listed_index" ON "locations" ("is_publicly_listed") WHERE "is_publicly_listed" = true;
