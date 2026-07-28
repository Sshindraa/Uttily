-- Migration 0006 : table location_opening_hours.
-- Plusieurs créneaux par jour autorisés : pas de UNIQUE(location_id, weekday).
-- Contrainte : open_time < close_time.

CREATE TABLE "location_opening_hours" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "location_id" uuid NOT NULL,
  "weekday" smallint NOT NULL,
  "open_time" time NOT NULL,
  "close_time" time NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "opening_hours_weekday_range" CHECK ("weekday" >= 0 AND "weekday" <= 6),
  CONSTRAINT "opening_hours_open_before_close" CHECK ("open_time" < "close_time")
);

ALTER TABLE "location_opening_hours"
  ADD CONSTRAINT "opening_hours_location_id_locations_id_fk"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE cascade;

CREATE INDEX "opening_hours_location_id_index" ON "location_opening_hours" ("location_id");
