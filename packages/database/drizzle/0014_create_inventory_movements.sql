-- Migration 0014 : table inventory_movements (journal append-only des transferts).
-- Chaque transfert d'un exemplaire entre établissements crée un mouvement.
-- from_location_id = localisation courante verrouillée avant le transfert.
-- to_location_id = nouvelle localisation.
-- idempotency_key : unique par exemplaire, permet les retries sans doublon.
-- Append-only : UPDATE et DELETE interdits par trigger.

CREATE TABLE "inventory_movements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "inventory_item_id" uuid NOT NULL,
  "from_location_id" uuid,
  "to_location_id" uuid,
  "reason" text NOT NULL DEFAULT '',
  "created_by" uuid,
  "idempotency_key" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Idempotence : une clé d'idempotency unique par exemplaire.
CREATE UNIQUE INDEX "inventory_movements_item_idempotency_unique"
  ON "inventory_movements" ("inventory_item_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_inventory_item_id_inventory_items_id_fk"
  FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE restrict;

ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_from_location_id_locations_id_fk"
  FOREIGN KEY ("from_location_id") REFERENCES "locations"("id") ON DELETE restrict;

ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_to_location_id_locations_id_fk"
  FOREIGN KEY ("to_location_id") REFERENCES "locations"("id") ON DELETE restrict;

ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null;

CREATE INDEX "inventory_movements_inventory_item_id_index" ON "inventory_movements" ("inventory_item_id");

-- Trigger : append-only (UPDATE et DELETE interdits).
CREATE OR REPLACE FUNCTION "prevent_movement_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'inventory_movements est append-only : UPDATE et DELETE interdits.';
END;
$$;

CREATE TRIGGER "prevent_update_delete_movements"
  BEFORE UPDATE OR DELETE ON "inventory_movements"
  FOR EACH ROW
  EXECUTE FUNCTION "prevent_movement_mutation"();
