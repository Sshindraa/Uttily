-- Migration 0013 : table inventory_items (exemplaires physiques).
-- status (ACTIVE | RETIRED | LOST) = statut de gestion du parc.
-- condition (NEW | GOOD | FAIR | POOR | BROKEN) = état physique, indépendant.
-- Aucune contrainte artificielle BROKEN → RETIRED.
-- La disponibilité réelle (réservable ou non) est calculée au Lot 3 via InventoryBlock.

DO $$ BEGIN
  CREATE TYPE "inventory_condition" AS ENUM('NEW', 'GOOD', 'FAIR', 'POOR', 'BROKEN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "inventory_status" AS ENUM('ACTIVE', 'RETIRED', 'LOST');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "inventory_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "product_variant_id" uuid NOT NULL,
  "internal_sku" text NOT NULL,
  "serial_number" text,
  "condition" "inventory_condition" NOT NULL DEFAULT 'NEW',
  "status" "inventory_status" NOT NULL DEFAULT 'ACTIVE',
  "current_location_id" uuid NOT NULL,
  "notes" text,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- internal_sku unique par organisation (où non supprimé).
CREATE UNIQUE INDEX "inventory_items_organization_sku_active_unique"
  ON "inventory_items" ("organization_id", "internal_sku")
  WHERE "deleted_at" IS NULL;

-- serial_number unique par organisation (où renseigné et non supprimé).
CREATE UNIQUE INDEX "inventory_items_organization_serial_active_unique"
  ON "inventory_items" ("organization_id", "serial_number")
  WHERE "serial_number" IS NOT NULL AND "deleted_at" IS NULL;

ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;

ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_product_variant_id_product_variants_id_fk"
  FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE restrict;

ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_current_location_id_locations_id_fk"
  FOREIGN KEY ("current_location_id") REFERENCES "locations"("id") ON DELETE restrict;

CREATE INDEX "inventory_items_organization_id_index" ON "inventory_items" ("organization_id");
CREATE INDEX "inventory_items_product_variant_id_index" ON "inventory_items" ("product_variant_id");
CREATE INDEX "inventory_items_current_location_id_index" ON "inventory_items" ("current_location_id");

-- Trigger : vérifie que current_location_id ET product_variant appartiennent
-- à la même organisation que l'inventory_item (isolation multi-tenant).
CREATE OR REPLACE FUNCTION "check_inventory_org_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  loc_org uuid;
  variant_org uuid;
BEGIN
  -- (a) current_location_id ∈ même organisation.
  SELECT organization_id INTO loc_org FROM locations WHERE id = NEW.current_location_id;
  IF loc_org IS NULL OR loc_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'L''établissement courant n''appartient pas à la même organisation que l''exemplaire.';
  END IF;

  -- (b) product_variant → product ∈ même organisation.
  SELECT p.organization_id INTO variant_org
  FROM product_variants pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.id = NEW.product_variant_id;

  IF variant_org IS NULL OR variant_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'La variante du produit n''appartient pas à la même organisation que l''exemplaire.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "before_check_inventory_org"
  BEFORE INSERT OR UPDATE OF "current_location_id", "product_variant_id", "organization_id"
  ON "inventory_items"
  FOR EACH ROW
  EXECUTE FUNCTION "check_inventory_org_consistency"();
