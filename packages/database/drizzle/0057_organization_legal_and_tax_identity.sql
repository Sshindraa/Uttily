-- Migration 0057 : Informations légales et fiscales du loueur (Lot 21-O1)

-- 1. Ajout des colonnes légales et fiscales sur organizations
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS legal_form text,
  ADD COLUMN IF NOT EXISTS registration_number text,
  ADD COLUMN IF NOT EXISTS vat_number text,
  ADD COLUMN IF NOT EXISTS registry_city text,
  ADD COLUMN IF NOT EXISTS capital_amount text,
  ADD COLUMN IF NOT EXISTS legal_representative_name text,
  ADD COLUMN IF NOT EXISTS registered_office_address text,
  ADD COLUMN IF NOT EXISTS registered_office_postal_code text,
  ADD COLUMN IF NOT EXISTS registered_office_city text,
  ADD COLUMN IF NOT EXISTS registered_office_country_code text DEFAULT 'FR';

-- 2. Ajout des contraintes de format
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_registration_number_format'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_registration_number_format
      CHECK (registration_number IS NULL OR registration_number ~ '^[0-9]{9}([0-9]{5})?$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_vat_number_format'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_vat_number_format
      CHECK (vat_number IS NULL OR vat_number ~ '^[A-Z]{2}[0-9A-Z]{2,12}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_registered_office_country_code_iso'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_registered_office_country_code_iso
      CHECK (registered_office_country_code IS NULL OR length(registered_office_country_code) = 2);
  END IF;
END $$;
