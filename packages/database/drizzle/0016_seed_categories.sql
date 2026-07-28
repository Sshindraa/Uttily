-- Migration 0016 : seed idempotent de catégories minimales.
-- Sans ce seed, aucun produit ne peut être publié sans intervention SQL manuelle
-- (l'interface d'administration des catégories est reportée au Lot 2C).
-- Idempotent par slug (ON CONFLICT (slug) DO NOTHING). Les UUIDs sont auto-générés.

INSERT INTO "categories" ("slug", "name", "is_active")
VALUES
  ('equipment',  'Équipements',         true),
  ('surf',       'Surf',                true),
  ('paddle',     'Paddle',              true),
  ('bike',       'Vélos',               true),
  ('ski',        'Ski & Snowboard',     true),
  ('camping',    'Camping & Outdoor',   true),
  ('climbing',   'Escalade',            true),
  ('diving',     'Plongée',             true),
  ('other',      'Autres',              true)
ON CONFLICT ("slug") DO NOTHING;
