-- Migration 0039 : identifiant public opaque pour les photos produit.
-- L'ID primaire product_photos.id ne doit pas apparaître dans les URLs publiques.

ALTER TABLE "product_photos" ADD COLUMN "public_id" uuid DEFAULT gen_random_uuid();
UPDATE "product_photos" SET "public_id" = gen_random_uuid() WHERE "public_id" IS NULL;
ALTER TABLE "product_photos" ALTER COLUMN "public_id" SET NOT NULL;
ALTER TABLE "product_photos" ADD CONSTRAINT "product_photos_public_id_unique" UNIQUE ("public_id");

DROP TRIGGER IF EXISTS "prevent_product_photos_public_id_mutation" ON "product_photos";
CREATE TRIGGER "prevent_product_photos_public_id_mutation"
  BEFORE UPDATE OF "public_id" ON "product_photos"
  FOR EACH ROW
  EXECUTE FUNCTION "prevent_public_id_mutation"();
