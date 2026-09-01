-- Migration 0054 : activation de la famille commerciale canonique paddleboard.
-- Cette migration ne convertit aucun produit historique utilisant `equipment` ou `paddle`.

INSERT INTO "categories" ("slug", "name", "is_active")
VALUES ('paddleboard', 'Paddle', true)
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "is_active" = true,
  "updated_at" = now();
