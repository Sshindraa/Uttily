-- Migration 0010 : table categories (taxonomie globale gérée par l'admin Uttily).
-- Arborescence via parent_id (self-reference), profondeur maximale 3.
-- Les catégories sont globales (pas d'organization_id) pour garantir
-- une cohérence inter-loueurs et simplifier la recherche publique (Lot 7).
-- ID en UUID v4 (convention architecture, ADR-007).

CREATE TABLE "categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "parent_id" uuid,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Slug unique global.
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_slug_unique" UNIQUE ("slug");

-- Auto-référence parent_id.
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_parent_id_categories_id_fk"
  FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE restrict;

-- Format du slug.
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_slug_format"
  CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');

CREATE INDEX "categories_parent_id_index" ON "categories" ("parent_id");

-- Trigger : vérifie profondeur ET cycle avant INSERT/UPDATE.
-- Parcourt les ancêtres de NEW.parent_id en cherchant NEW.id dans la chaîne
-- (détecte qu'une catégorie deviendrait son propre ancêtre après mise à jour).
CREATE OR REPLACE FUNCTION "check_category_depth"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  new_depth integer;
  current_id uuid;
  visited uuid[] := ARRAY[]::uuid[];
  next_parent uuid;
BEGIN
  -- Auto-référence explicite.
  IF NEW.parent_id IS NOT NULL AND NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'Cycle détecté : une catégorie ne peut pas être son propre parent.';
  END IF;

  IF NEW.parent_id IS NULL THEN
    new_depth := 1;
  ELSE
    current_id := NEW.parent_id;
    new_depth := 1;
    WHILE current_id IS NOT NULL LOOP
      -- Détection de cycle : NEW.id apparaît dans la chaîne des ancêtres.
      IF current_id = NEW.id THEN
        RAISE EXCEPTION 'Cycle détecté : la catégorie % est déjà un ancêtre de %.', NEW.id, NEW.parent_id;
      END IF;
      -- Détection de cycle interne (parcours circulaire existant).
      IF current_id = ANY(visited) THEN
        RAISE EXCEPTION 'Cycle détecté dans la hiérarchie des catégories (id: %).', current_id;
      END IF;
      visited := visited || current_id;
      new_depth := new_depth + 1;

      SELECT parent_id INTO next_parent FROM categories WHERE id = current_id;
      IF next_parent IS NULL THEN
        EXIT;
      END IF;
      current_id := next_parent;

      IF new_depth > 100 THEN
        RAISE EXCEPTION 'Profondeur de catégorie excessive (> 100) : cycle probable.';
      END IF;
    END LOOP;
  END IF;

  IF new_depth > 3 THEN
    RAISE EXCEPTION 'Profondeur de catégorie maximale (3) dépassée.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "before_check_category_depth"
  BEFORE INSERT OR UPDATE OF "parent_id" ON "categories"
  FOR EACH ROW
  EXECUTE FUNCTION "check_category_depth"();

-- Invariant : une catégorie active ne peut pas avoir un parent inactif.
-- Couvre INSERT, UPDATE de parent_id, et réactivation (is_active false→true).
-- Empêche :
--   - de créer un enfant actif sous un parent inactif ;
--   - de déplacer un enfant actif sous un parent inactif ;
--   - de réactiver un enfant dont le parent reste désactivé.
CREATE OR REPLACE FUNCTION "check_category_parent_active"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_active boolean;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Si la catégorie est active, son parent doit l'être aussi.
  -- Verrou SHARE sur le parent pour éviter une course avec la désactivation
  -- concurrente du parent (qui prend un verrou ROW EXCLUSIVE via UPDATE).
  -- FOR SHARE bloque l'UPDATE du parent jusqu'à validation de cette transaction.
  IF NEW.is_active = true THEN
    SELECT is_active INTO parent_active FROM categories WHERE id = NEW.parent_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Catégorie parente introuvable (id: %).', NEW.parent_id;
    END IF;
    IF parent_active = false THEN
      RAISE EXCEPTION 'Invariant violé : une catégorie active ne peut pas avoir un parent inactif (parent_id: %).', NEW.parent_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "before_check_parent_active"
  BEFORE INSERT OR UPDATE OF "parent_id", "is_active" ON "categories"
  FOR EACH ROW
  EXECUTE FUNCTION "check_category_parent_active"();

