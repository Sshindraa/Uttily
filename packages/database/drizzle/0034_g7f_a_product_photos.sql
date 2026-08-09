-- Migration 0034 : G7F-A2 — Métadonnées photo produit et gate de publication.
--
-- Crée l'enum product_photo_file_state, la table product_photos avec FK
-- composite multi-tenant, contraintes CHECK d'état exhaustif, bornes
-- nullables, index (dont un index unique partiel sur checksum), une fonction
-- de comptage des photos valides, et trois triggers :
-- 1. check_product_publication_photos (CONSTRAINT TRIGGER DEFERRABLE) :
--    refuse la transition vers PUBLISHED si < 3 photos valides.
-- 2. guard_product_photo_deletion (BEFORE UPDATE OR DELETE) :
--    refuse la suppression d'une photo valide si le produit est PUBLISHED
--    et le compte après suppression serait < 3. Court-circuit : ne vérifie
--    que si l'opération retire réellement une photo valide.
-- 3. guard_product_photo_immutability (BEFORE UPDATE) :
--    immutabilité des champs d'identité et des métadonnées après AVAILABLE,
--    et validation des transitions de la machine d'états.
--
-- Aucun upload R2, aucun objet binaire, aucun outbox event, aucun worker.
-- Le soft delete est métadonnées uniquement (file_state → DELETED, deleted_at).

-- ========================================================================
-- 1. Enum product_photo_file_state
-- ========================================================================

CREATE TYPE product_photo_file_state AS ENUM (
  'PENDING_UPLOAD',
  'AVAILABLE',
  'REJECTED',
  'DELETED'
);

-- ========================================================================
-- 2. Index unique sur products(id, organization_id) — requis pour la FK composite
-- ========================================================================

CREATE UNIQUE INDEX IF NOT EXISTS products_id_organization_id_unique
  ON products (id, organization_id);

-- ========================================================================
-- 3. Table product_photos
-- ========================================================================

CREATE TABLE product_photos (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid          NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  product_id       uuid          NOT NULL,
  storage_key      text          NOT NULL,
  content_type     text,
  byte_size        bigint,
  width_px         integer,
  height_px        integer,
  checksum_sha256  text,
  sort_order       integer       NOT NULL DEFAULT 0,
  file_state       product_photo_file_state NOT NULL,
  rejection_reason text,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  deleted_at       timestamptz,

  -- FK composite multi-tenant : garantit product_photos.organization_id =
  -- products.organization_id au niveau PostgreSQL, même par SQL direct.
  CONSTRAINT product_photos_product_org_fkey
    FOREIGN KEY (product_id, organization_id)
    REFERENCES products(id, organization_id) ON DELETE CASCADE,

  -- Invariant d'état exhaustif : nullabilité selon file_state.
  CONSTRAINT product_photos_state_invariants CHECK (
    CASE
      WHEN file_state = 'PENDING_UPLOAD' THEN
        deleted_at IS NULL AND rejection_reason IS NULL
      WHEN file_state = 'AVAILABLE' THEN
        content_type IS NOT NULL AND byte_size IS NOT NULL
        AND width_px IS NOT NULL AND height_px IS NOT NULL
        AND checksum_sha256 IS NOT NULL
        AND deleted_at IS NULL AND rejection_reason IS NULL
      WHEN file_state = 'REJECTED' THEN
        rejection_reason IS NOT NULL AND deleted_at IS NULL
      WHEN file_state = 'DELETED' THEN
        deleted_at IS NOT NULL
      ELSE FALSE
    END
  ),
  -- Bornes nullables : s'appliquent uniquement lorsque la colonne est non nulle.
  CONSTRAINT product_photos_content_type_valid
    CHECK (content_type IS NULL OR content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT product_photos_byte_size_valid
    CHECK (byte_size IS NULL OR (byte_size > 0 AND byte_size <= 10485760)),
  CONSTRAINT product_photos_dimensions_valid
    CHECK ((width_px IS NULL OR (width_px >= 200 AND width_px <= 8000))
           AND (height_px IS NULL OR (height_px >= 200 AND height_px <= 8000))),
  CONSTRAINT product_photos_sort_order_non_negative CHECK (sort_order >= 0),
  -- storage_key non vide et préfixe obligatoire.
  CONSTRAINT product_photos_storage_key_not_empty CHECK (length(storage_key) > 0),
  CONSTRAINT product_photos_storage_key_prefix CHECK (storage_key ~ '^product-photos/'),
  -- checksum_sha256 format 64 hex si non null.
  CONSTRAINT product_photos_checksum_format
    CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
  -- rejection_reason non vide après trim si non null.
  CONSTRAINT product_photos_rejection_reason_not_empty
    CHECK (rejection_reason IS NULL OR btrim(rejection_reason) <> '')
);

-- ========================================================================
-- 4. Index
-- ========================================================================

CREATE INDEX product_photos_product_id_deleted_at_idx
  ON product_photos (product_id, deleted_at);

CREATE INDEX product_photos_organization_id_deleted_at_idx
  ON product_photos (organization_id, deleted_at);

CREATE INDEX product_photos_product_id_file_state_deleted_at_idx
  ON product_photos (product_id, file_state, deleted_at);

-- Index unique partiel : empêche deux photos AVAILABLE du même produit de
-- partager le même checksum (photos distinctes). Tenant-safe (product_id
-- appartient à une organisation) et compatible avec le soft delete.
CREATE UNIQUE INDEX product_photos_product_id_checksum_unique
  ON product_photos (product_id, checksum_sha256)
  WHERE file_state = 'AVAILABLE' AND deleted_at IS NULL AND checksum_sha256 IS NOT NULL;

-- storage_key UNIQUE global : une clé objet R2 ne peut être référencée que
-- par une seule ligne product_photos.
CREATE UNIQUE INDEX product_photos_storage_key_unique
  ON product_photos (storage_key);

-- ========================================================================
-- 5. Fonction count_valid_product_photos
-- ========================================================================

CREATE OR REPLACE FUNCTION count_valid_product_photos(p_product_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  valid_count integer;
BEGIN
  SELECT COUNT(DISTINCT checksum_sha256)
  INTO valid_count
  FROM product_photos
  WHERE product_id = p_product_id
    AND file_state = 'AVAILABLE'
    AND deleted_at IS NULL;
  RETURN valid_count;
END;
$$;

-- ========================================================================
-- 6. Trigger check_product_publication_photos (CONSTRAINT TRIGGER, DEFERRABLE)
-- ========================================================================

CREATE OR REPLACE FUNCTION check_product_publication_photos()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  valid_count integer;
BEGIN
  -- Filtrage interne : ne valider que les transitions vers PUBLISHED.
  IF (TG_OP = 'INSERT' AND NEW.publication_status = 'PUBLISHED')
     OR (TG_OP = 'UPDATE' AND OLD.publication_status <> 'PUBLISHED'
         AND NEW.publication_status = 'PUBLISHED') THEN
    valid_count := count_valid_product_photos(NEW.id);
    IF valid_count < 3 THEN
      RAISE EXCEPTION
        'Publication impossible : au moins 3 photos valides requises (actuel : %)',
        valid_count;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER check_product_publication_photos
  AFTER INSERT OR UPDATE ON products
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_product_publication_photos();

-- ========================================================================
-- 7. Trigger guard_product_photo_deletion (BEFORE UPDATE OR DELETE)
-- ========================================================================

CREATE OR REPLACE FUNCTION guard_product_photo_deletion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
  valid_count_after integer;
  product_id_to_check uuid;
BEGIN
  -- Court-circuit : ne vérifier le seuil que si l'opération retire réellement
  -- une photo valide. Une photo valide est AVAILABLE avec deleted_at IS NULL.
  -- Pour toute autre opération (mise à jour de sort_order, suppression de
  -- PENDING_UPLOAD ou REJECTED, opération ne réduisant pas le compte valide),
  -- le trigger retourne immédiatement sans refuser, même pour un produit
  -- PUBLISHED historique ayant moins de trois photos.
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

  -- FOR UPDATE sur la ligne products parent pour sérialiser les suppressions
  -- concurrentes et éviter les deadlocks (ordre de verrouillage : products
  -- avant product_photos). Le verrou n'est posé que si l'opération retire
  -- réellement une photo valide (court-circuit ci-dessus).
  SELECT publication_status INTO parent_status
  FROM products
  WHERE id = product_id_to_check
  FOR UPDATE;

  IF parent_status = 'PUBLISHED' THEN
    -- À ce point, on sait que l'opération retire une photo valide.
    -- Le compte après = compte actuel - 1.
    SELECT count_valid_product_photos(product_id_to_check) - 1
    INTO valid_count_after;

    IF valid_count_after < 3 THEN
      RAISE EXCEPTION
        'Suppression impossible : le produit est PUBLISHED et cette modification ferait passer le compte de photos valides sous le seuil de 3 (après : %)',
        valid_count_after;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_product_photo_deletion
  BEFORE UPDATE OR DELETE ON product_photos
  FOR EACH ROW
  EXECUTE FUNCTION guard_product_photo_deletion();

-- ========================================================================
-- 8. Trigger guard_product_photo_immutability (BEFORE UPDATE)
-- ========================================================================

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

  -- Métadonnées techniques immuables après AVAILABLE.
  IF OLD.file_state = 'AVAILABLE' THEN
    IF NEW.content_type IS DISTINCT FROM OLD.content_type
       OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
       OR NEW.width_px IS DISTINCT FROM OLD.width_px
       OR NEW.height_px IS DISTINCT FROM OLD.height_px
       OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256 THEN
      RAISE EXCEPTION
        'Les métadonnées techniques sont immuables après AVAILABLE.';
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

CREATE TRIGGER guard_product_photo_immutability
  BEFORE UPDATE ON product_photos
  FOR EACH ROW
  EXECUTE FUNCTION guard_product_photo_immutability();

-- ========================================================================
-- 9. Rollback (ordre inverse) — exécuté par les tests, pas par la migration.
-- ========================================================================
-- DROP TRIGGER IF EXISTS guard_product_photo_immutability ON product_photos;
-- DROP TRIGGER IF EXISTS guard_product_photo_deletion ON product_photos;
-- DROP TRIGGER IF EXISTS check_product_publication_photos ON products;
-- DROP FUNCTION IF EXISTS guard_product_photo_immutability();
-- DROP FUNCTION IF EXISTS guard_product_photo_deletion();
-- DROP FUNCTION IF EXISTS check_product_publication_photos();
-- DROP FUNCTION IF EXISTS count_valid_product_photos(uuid);
-- DROP INDEX IF EXISTS product_photos_storage_key_unique;
-- DROP INDEX IF EXISTS product_photos_product_id_checksum_unique;
-- DROP INDEX IF EXISTS product_photos_product_id_file_state_deleted_at_idx;
-- DROP INDEX IF EXISTS product_photos_organization_id_deleted_at_idx;
-- DROP INDEX IF EXISTS product_photos_product_id_deleted_at_idx;
-- DROP TABLE IF EXISTS product_photos;
-- DROP TYPE IF EXISTS product_photo_file_state;
