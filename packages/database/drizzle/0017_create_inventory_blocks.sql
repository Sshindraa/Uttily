-- Migration 0017 : table inventory_blocks (blocages de disponibilité).
-- Un blocage réserve un exemplaire pour une période donnée. Les types :
--   HOLD             = réservation temporaire en attente de paiement
--   BOOKING          = réservation confirmée
--   MAINTENANCE      = indisponibilité pour maintenance
--   MANUAL_BLOCK     = blocage manuel (hors-service, événementiel, etc.)
-- Les statuts :
--   ACTIVE            = blocage actif (empêche tout chevauchement)
--   PAYMENT_PROCESSING = blocage actif pendant le paiement
--   CONVERTED         = hold converti en booking (ne bloque plus, le bloc
--                       BOOKING prend le relais sur la même période)
--   RELEASED          = blocage libéré manuellement (ne bloque plus)
--   EXPIRED           = hold expiré (ne bloque plus)
-- La contrainte d'exclusion EXCLUDE USING gist empêche le chevauchement
-- de blocs ACTIVE ou PAYMENT_PROCESSING pour un même exemplaire.
-- btree_gist est déjà activé (migration 0001).

DO $$ BEGIN
  CREATE TYPE "inventory_block_type" AS ENUM('HOLD', 'BOOKING', 'MAINTENANCE', 'MANUAL_BLOCK');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "inventory_block_status" AS ENUM('ACTIVE', 'PAYMENT_PROCESSING', 'CONVERTED', 'RELEASED', 'EXPIRED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "inventory_blocks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "inventory_item_id" uuid NOT NULL,
  "type" "inventory_block_type" NOT NULL,
  "status" "inventory_block_status" DEFAULT 'ACTIVE' NOT NULL,
  "customer_start_at" timestamp with time zone NOT NULL,
  "customer_end_at" timestamp with time zone NOT NULL,
  "blocked_start_at" timestamp with time zone NOT NULL,
  "blocked_end_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone,
  "source_id" uuid,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at" timestamp with time zone
);

ALTER TABLE "inventory_blocks"
  ADD CONSTRAINT "inventory_blocks_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict;

ALTER TABLE "inventory_blocks"
  ADD CONSTRAINT "inventory_blocks_inventory_item_id_inventory_items_id_fk"
  FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE restrict;

ALTER TABLE "inventory_blocks"
  ADD CONSTRAINT "inventory_blocks_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null;

-- Contraintes CHECK : cohérence des périodes.
-- La période bloquée doit être valide (fin > début).
ALTER TABLE "inventory_blocks"
  ADD CONSTRAINT "inventory_blocks_blocked_period_valid"
  CHECK ("blocked_end_at" > "blocked_start_at");

-- La période client doit être valide (fin > début).
ALTER TABLE "inventory_blocks"
  ADD CONSTRAINT "inventory_blocks_customer_period_valid"
  CHECK ("customer_end_at" > "customer_start_at");

-- La période bloquée doit inclure la période client.
ALTER TABLE "inventory_blocks"
  ADD CONSTRAINT "inventory_blocks_blocked_includes_customer"
  CHECK ("blocked_start_at" <= "customer_start_at" AND "blocked_end_at" >= "customer_end_at");

-- Invariant : expires_at est non-null uniquement pour les HOLD.
ALTER TABLE "inventory_blocks"
  ADD CONSTRAINT "inventory_blocks_expires_at_hold_only"
  CHECK (
    ("type" = 'HOLD' AND "expires_at" IS NOT NULL)
    OR ("type" <> 'HOLD' AND "expires_at" IS NULL)
  );

-- Contrainte d'exclusion : empêche le chevauchement de blocs actifs ou en traitement
-- de paiement pour un même exemplaire. btree_gist est déjà activé (migration 0001).
-- inventory_item_id est un UUID globalement unique, pas besoin d'organization_id.
-- La contrainte s'applique uniquement aux statuts qui bloquent réellement
-- (ACTIVE et PAYMENT_PROCESSING). CONVERTED/RELEASED/EXPIRED ne bloquent plus.
ALTER TABLE "inventory_blocks"
  ADD CONSTRAINT "no_overlapping_blocks"
  EXCLUDE USING gist (
    "inventory_item_id" WITH =,
    tstzrange("blocked_start_at", "blocked_end_at") WITH &&
  )
  WHERE ("status" IN ('ACTIVE', 'PAYMENT_PROCESSING') AND "deleted_at" IS NULL);

-- Trigger : cohérence multi-tenant.
-- L'exemplaire doit appartenir à la même organisation que le bloc.
CREATE OR REPLACE FUNCTION check_block_org_consistency()
RETURNS TRIGGER AS $$
DECLARE
  item_org_id uuid;
BEGIN
  SELECT organization_id INTO item_org_id
  FROM inventory_items
  WHERE id = NEW.inventory_item_id;

  IF item_org_id IS NULL THEN
    RAISE EXCEPTION 'L''exemplaire % n''existe pas', NEW.inventory_item_id;
  END IF;

  IF item_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'L''exemplaire n''appartient pas à la même organisation que le bloc';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_check_block_org
  BEFORE INSERT OR UPDATE OF inventory_item_id, organization_id ON "inventory_blocks"
  FOR EACH ROW
  EXECUTE FUNCTION check_block_org_consistency();

-- Index pour la recherche de disponibilité (filtrer par item + période).
CREATE INDEX "inventory_blocks_item_period_idx"
  ON "inventory_blocks" ("inventory_item_id", "blocked_start_at", "blocked_end_at");

-- Index pour le nettoyage des holds expirés (worker Lot 4).
CREATE INDEX "inventory_blocks_expires_at_idx"
  ON "inventory_blocks" ("expires_at")
  WHERE "expires_at" IS NOT NULL;
