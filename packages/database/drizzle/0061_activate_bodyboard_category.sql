-- Migration 0061 : activation de la famille commerciale canonique bodyboard.
-- Cette migration ne convertit aucun produit historique utilisant `surf`.
INSERT INTO "categories" ("slug", "name", "is_active")
VALUES ('bodyboard', 'Bodyboard', true)
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "is_active" = true,
  "updated_at" = now();
