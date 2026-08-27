-- Migration 0046 : Ajout des détails d'établissement et exceptions de calendrier (Chantier 15A)

-- 1. Ajout des colonnes de contact et consignes sur locations
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS public_phone text,
  ADD COLUMN IF NOT EXISTS pickup_instructions text,
  ADD COLUMN IF NOT EXISTS return_instructions text;

-- 2. Création de l'énumération pour les exceptions de calendrier
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'location_schedule_exception_kind') THEN
    CREATE TYPE location_schedule_exception_kind AS ENUM ('CLOSED', 'OPEN_INTERVAL');
  END IF;
END $$;

-- 3. Création de la table location_schedule_exceptions
CREATE TABLE IF NOT EXISTS location_schedule_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  local_date text NOT NULL,
  kind location_schedule_exception_kind NOT NULL,
  open_time text,
  close_time text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT location_schedule_exceptions_location_date_unique UNIQUE (location_id, local_date),
  CONSTRAINT location_schedule_exceptions_date_format CHECK (local_date ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT location_schedule_exceptions_times_valid CHECK (
    kind = 'CLOSED' OR (open_time IS NOT NULL AND close_time IS NOT NULL AND open_time < close_time)
  )
);

CREATE INDEX IF NOT EXISTS location_schedule_exceptions_org_idx ON location_schedule_exceptions(organization_id);
CREATE INDEX IF NOT EXISTS location_schedule_exceptions_location_idx ON location_schedule_exceptions(location_id);
CREATE INDEX IF NOT EXISTS location_schedule_exceptions_date_idx ON location_schedule_exceptions(location_id, local_date);
