-- Migration 0050 : enforcement des slots photo obligatoires du pilote vélo
-- (ADR-031). Les autres catégories conservent le seuil générique de trois
-- photos distinctes défini par ADR-020.

CREATE OR REPLACE FUNCTION count_valid_product_photo_slots(p_product_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT COUNT(DISTINCT slot_type)::integer
  FROM product_photos
  WHERE product_id = p_product_id
    AND file_state = 'AVAILABLE'
    AND deleted_at IS NULL
    AND checksum_sha256 IS NOT NULL
    AND slot_type IN (
      'HERO_PROFILE',
      'THREE_QUARTER_FRONT',
      'SECONDARY_VIEW'
    );
$$;

CREATE OR REPLACE FUNCTION check_product_publication_photos()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  category_slug text;
  valid_count integer;
  valid_slot_count integer;
BEGIN
  -- Filtrage interne : ne valider que les transitions vers PUBLISHED.
  IF (TG_OP = 'INSERT' AND NEW.publication_status = 'PUBLISHED')
     OR (TG_OP = 'UPDATE' AND OLD.publication_status <> 'PUBLISHED'
         AND NEW.publication_status = 'PUBLISHED') THEN
    SELECT c.slug
    INTO category_slug
    FROM categories c
    WHERE c.id = NEW.category_id;

    valid_count := count_valid_product_photos(NEW.id);
    IF valid_count < 3 THEN
      RAISE EXCEPTION
        'Publication impossible : au moins 3 photos valides requises (actuel : %)',
        valid_count;
    END IF;

    IF category_slug = 'bike' THEN
      valid_slot_count := count_valid_product_photo_slots(NEW.id);
      IF valid_slot_count < 3 THEN
        RAISE EXCEPTION
          'Publication impossible : un vélo doit posséder les trois slots photo canoniques (slots présents : %)',
          valid_slot_count;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_product_photo_deletion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
  category_slug text;
  valid_count_after integer;
  valid_slot_count_after integer;
  product_id_to_check uuid;
BEGIN
  -- Court-circuit : ne vérifier le seuil que si l'opération retire réellement
  -- une photo valide.
  IF TG_OP = 'DELETE' THEN
    IF NOT (OLD.file_state = 'AVAILABLE' AND OLD.deleted_at IS NULL) THEN
      RETURN OLD;
    END IF;
    product_id_to_check := OLD.product_id;
  ELSE -- UPDATE
    IF NOT (OLD.file_state = 'AVAILABLE' AND OLD.deleted_at IS NULL
            AND NOT (NEW.file_state = 'AVAILABLE' AND NEW.deleted_at IS NULL)) THEN
      RETURN NEW;
    END IF;
    product_id_to_check := NEW.product_id;
  END IF;

  -- Verrouille le parent avant de compter pour sérialiser les suppressions.
  SELECT p.publication_status, c.slug
  INTO parent_status, category_slug
  FROM products p
  INNER JOIN categories c ON c.id = p.category_id
  WHERE p.id = product_id_to_check
  FOR UPDATE OF p;

  IF parent_status = 'PUBLISHED' THEN
    IF category_slug = 'bike' THEN
      valid_slot_count_after := count_valid_product_photo_slots(product_id_to_check);

      -- Le trigger BEFORE voit encore OLD. Le slot ne disparaît que si OLD
      -- est la dernière photo valide de ce slot.
      IF OLD.slot_type IN (
        'HERO_PROFILE',
        'THREE_QUARTER_FRONT',
        'SECONDARY_VIEW'
      ) AND NOT EXISTS (
        SELECT 1
        FROM product_photos pp
        WHERE pp.id <> OLD.id
          AND pp.product_id = product_id_to_check
          AND pp.file_state = 'AVAILABLE'
          AND pp.deleted_at IS NULL
          AND pp.checksum_sha256 IS NOT NULL
          AND pp.slot_type = OLD.slot_type
      ) THEN
        valid_slot_count_after := valid_slot_count_after - 1;
      END IF;

      IF valid_slot_count_after < 3 THEN
        RAISE EXCEPTION
          'Suppression impossible : le vélo est PUBLISHED et cette modification ferait disparaître un slot photo canonique (slots après : %)',
          valid_slot_count_after;
      END IF;
    ELSE
      valid_count_after := count_valid_product_photos(product_id_to_check) - 1;
      IF valid_count_after < 3 THEN
        RAISE EXCEPTION
          'Suppression impossible : le produit est PUBLISHED et cette modification ferait passer le compte de photos valides sous le seuil de 3 (après : %)',
          valid_count_after;
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_product_photo_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Champs d'identité immuables après INSERT.
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.product_id <> OLD.product_id
     OR NEW.storage_key <> OLD.storage_key THEN
    RAISE EXCEPTION
      'organization_id, product_id et storage_key sont immuables après INSERT.';
  END IF;

  -- Métadonnées techniques et slot immuables après AVAILABLE.
  IF OLD.file_state = 'AVAILABLE' THEN
    IF NEW.content_type IS DISTINCT FROM OLD.content_type
       OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
       OR NEW.width_px IS DISTINCT FROM OLD.width_px
       OR NEW.height_px IS DISTINCT FROM OLD.height_px
       OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256
       OR NEW.slot_type IS DISTINCT FROM OLD.slot_type THEN
      RAISE EXCEPTION
        'Les métadonnées techniques et le slot sont immuables après AVAILABLE.';
    END IF;
  END IF;

  -- Machine d'états : transitions autorisées uniquement.
  IF NOT (
    (OLD.file_state = 'PENDING_UPLOAD' AND NEW.file_state IN ('AVAILABLE', 'REJECTED', 'DELETED'))
    OR (OLD.file_state = 'AVAILABLE' AND NEW.file_state = 'DELETED')
    OR (OLD.file_state = 'REJECTED' AND NEW.file_state = 'DELETED')
    OR (OLD.file_state = NEW.file_state)
  ) THEN
    RAISE EXCEPTION
      'Transition d''état non autorisée : % → %',
      OLD.file_state, NEW.file_state;
  END IF;

  RETURN NEW;
END;
$$;

-- Rollback documentaire : restaurer les fonctions de 0034 puis supprimer la
-- fonction count_valid_product_photo_slots(uuid).
