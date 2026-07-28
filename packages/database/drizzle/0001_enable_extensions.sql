-- Migration 0001 : extensions PostgreSQL.
-- PostGIS pour les types géographiques (locations.geo_point, recherche Lot 7).
-- btree_gist anticipé pour la contrainte d'exclusion InventoryBlock (Lot 3).
-- Ces extensions sont écrites explicitement en SQL (ADR-004) : Drizzle
-- ne garantit pas automatiquement leur présence.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
