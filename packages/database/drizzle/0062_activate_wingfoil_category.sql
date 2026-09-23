-- Migration 0062 : activation de la famille commerciale canonique wingfoil.
-- Cette migration ne convertit aucun produit historique utilisant `surf`.
INSERT INTO "categories" ("slug", "name", "is_active")
VALUES ('wingfoil', 'Wingfoil', true)
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "is_active" = true,
  "updated_at" = now();
