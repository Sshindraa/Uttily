-- Migration 0060 : activation des seules familles commerciales neige
-- raquettes et luge. Aucun produit historique n'est converti.
INSERT INTO "categories" ("slug", "name", "is_active")
VALUES ('snowshoes', 'Raquettes', true)
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "is_active" = true,
  "updated_at" = now();

INSERT INTO "categories" ("slug", "name", "is_active")
VALUES ('sled', 'Luge', true)
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "is_active" = true,
  "updated_at" = now();
