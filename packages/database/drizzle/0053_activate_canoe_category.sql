-- Migration 0053 : activation de la famille commerciale canonique canoë.
-- Cette migration ne convertit aucun produit historique utilisant `equipment`.

INSERT INTO "categories" ("slug", "name", "is_active")
VALUES ('canoe', 'Canoës', true)
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "is_active" = true,
  "updated_at" = now();
