-- Migration 0012 : table product_variants.
-- Chaque produit a au moins une variante (variante "Standard" créée
-- atomiquement à la création du produit).
-- product_id est immuable : une variante ne peut pas changer de produit.
-- Invariant "au moins une variante active" garanti par trigger BEFORE.

CREATE TABLE "product_variants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" uuid NOT NULL,
  "name" text NOT NULL,
  "sku_suffix" text,
  "attributes" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "is_active" boolean NOT NULL DEFAULT true,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_product_id_products_id_fk"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE cascade;

CREATE INDEX "product_variants_product_id_index" ON "product_variants" ("product_id");

-- Trigger : product_id immuable.
CREATE OR REPLACE FUNCTION "prevent_product_id_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    RAISE EXCEPTION 'product_variant.product_id est immuable.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "before_update_product_id"
  BEFORE UPDATE OF "product_id" ON "product_variants"
  FOR EACH ROW
  EXECUTE FUNCTION "prevent_product_id_change"();

-- Trigger : empêche la désactivation ou suppression de la dernière variante active.
-- Verrouille d'abord le produit parent (sérialisation des opérations concurrentes),
-- puis compte les autres variantes actives.
CREATE OR REPLACE FUNCTION "guard_last_active_variant"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  active_count integer;
BEGIN
  -- Verrouille le produit parent pour sérialiser les désactivations concurrentes.
  PERFORM 1 FROM products WHERE id = OLD.product_id FOR UPDATE;

  -- Si la variante reste active et non supprimée, pas de garde-fou.
  IF TG_OP = 'UPDATE' AND NEW.is_active = true AND NEW.deleted_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Compte les autres variantes actives (hors celle en cours de désactivation/suppression).
  SELECT count(*) INTO active_count
  FROM product_variants
  WHERE product_id = OLD.product_id
    AND id <> OLD.id
    AND is_active = true
    AND deleted_at IS NULL;

  IF active_count = 0 THEN
    RAISE EXCEPTION 'Impossible de désactiver ou supprimer la dernière variante active du produit.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "before_delete_or_deactivate_variant"
  BEFORE DELETE OR UPDATE OF "is_active", "deleted_at" ON "product_variants"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_last_active_variant"();
