-- Migration 0015 : garde-fou désactivation de catégorie.
-- Refuse la désactivation (is_active true → false) d'une catégorie si :
--   (a) des produits PUBLISHED l'utilisent directement ;
--   (b) des produits PUBLISHED utilisent un de ses descendants actifs ;
--   (c) elle a des descendants actifs (qui deviendraient orphelins d'un parent actif).
-- L'admin doit d'abord archiver ou déplacer ces produits, puis désactiver
-- les sous-catégories avant de désactiver la catégorie parente.

-- Fonction récursive : collecte tous les descendants d'une catégorie.
CREATE OR REPLACE FUNCTION "category_descendants"(cat_id uuid)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  child_id uuid;
BEGIN
  FOR child_id IN
    WITH RECURSIVE descendants AS (
      SELECT id FROM categories WHERE parent_id = cat_id
      UNION ALL
      SELECT c.id FROM categories c
      INNER JOIN descendants d ON c.parent_id = d.id
    )
    SELECT id FROM descendants
  LOOP
    RETURN NEXT child_id;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION "guard_category_deactivation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  published_count integer;
  active_descendants integer;
BEGIN
  -- Ne déclenche que sur la transition is_active true → false.
  IF OLD.is_active = true AND NEW.is_active = false THEN
    -- (a) + (b) : produits PUBLISHED dans tout le sous-arbre (catégorie + descendants).
    SELECT count(*) INTO published_count
    FROM products
    WHERE publication_status = 'PUBLISHED'
      AND deleted_at IS NULL
      AND (
        category_id = OLD.id
        OR category_id IN (SELECT category_descendants(OLD.id))
      );

    IF published_count > 0 THEN
      RAISE EXCEPTION 'Désactivation refusée : % produit(s) publié(s) utilisent cette catégorie ou ses descendants. Archivez-les ou déplacez-les d''abord.', published_count;
    END IF;

    -- (c) : descendants actifs (qui perdraient un parent actif).
    SELECT count(*) INTO active_descendants
    FROM categories
    WHERE id IN (SELECT category_descendants(OLD.id))
      AND is_active = true;

    IF active_descendants > 0 THEN
      RAISE EXCEPTION 'Désactivation refusée : % sous-catégorie(s) active(s) existent. Désactivez-les d''abord.', active_descendants;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "before_deactivate_category"
  BEFORE UPDATE OF "is_active" ON "categories"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_category_deactivation"();
