-- Migration 0038: Add immutable public_id to product_variants

-- 1. Ajouter la colonne public_id avec valeur par défaut gen_random_uuid()
ALTER TABLE "product_variants" ADD COLUMN "public_id" uuid DEFAULT gen_random_uuid();

-- 2. Backfill des lignes existantes pour garantir l'unicité et la non-nullité
UPDATE "product_variants" SET "public_id" = gen_random_uuid() WHERE "public_id" IS NULL;

-- 3. Contraintes : NOT NULL et UNIQUE
ALTER TABLE "product_variants" ALTER COLUMN "public_id" SET NOT NULL;
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_public_id_unique" UNIQUE ("public_id");

-- 4. Trigger d'immutabilité de public_id
DROP TRIGGER IF EXISTS "prevent_product_variants_public_id_mutation" ON "product_variants";
CREATE TRIGGER "prevent_product_variants_public_id_mutation"
  BEFORE UPDATE OF "public_id" ON "product_variants"
  FOR EACH ROW
  EXECUTE FUNCTION "prevent_public_id_mutation"();
