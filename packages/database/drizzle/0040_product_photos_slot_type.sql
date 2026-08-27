-- Migration 0040 : ajout du type de slot sémantique aux photos produit (G8B-3).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'product_photo_slot_type') THEN
    CREATE TYPE "product_photo_slot_type" AS ENUM (
      'HERO_PROFILE',
      'THREE_QUARTER_FRONT',
      'SECONDARY_VIEW',
      'THREE_QUARTER',
      'SIGNATURE_DETAIL',
      'FULL_BIKE',
      'DRIVETRAIN',
      'BRAKES_TIRES',
      'BATTERY',
      'MOTOR',
      'DISPLAY',
      'CHARGER'
    );
  END IF;
END $$;

ALTER TABLE "product_photos" ADD COLUMN IF NOT EXISTS "slot_type" "product_photo_slot_type";
