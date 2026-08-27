-- Migration 0047 : Clé étrangère composite organisation + établissement pour l'étanchéité multi-tenant (Chantier 15.1)

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'locations_org_id_unique'
  ) THEN
    ALTER TABLE locations
      ADD CONSTRAINT locations_org_id_unique UNIQUE (organization_id, id);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'location_schedule_exceptions_location_id_locations_id_fk'
  ) THEN
    ALTER TABLE location_schedule_exceptions
      DROP CONSTRAINT location_schedule_exceptions_location_id_locations_id_fk;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'location_schedule_exceptions_org_location_fk'
  ) THEN
    ALTER TABLE location_schedule_exceptions
      ADD CONSTRAINT location_schedule_exceptions_org_location_fk
      FOREIGN KEY (organization_id, location_id) REFERENCES locations(organization_id, id) ON DELETE CASCADE;
  END IF;
END $$;
