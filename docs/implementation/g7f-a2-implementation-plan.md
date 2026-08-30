# G7F-A2 — Plan d'implémentation : métadonnées photo et gate de publication

- **Date** : 2026-08-08
- **Phase / lot** : 11 / Lot 7 — G7F-A2 : implémentation (migration, schéma,
  triggers, gate, tests)
- **Nature** : plan d'implémentation exclusivement ; aucun code n'est écrit
  dans ce document
- **ADR associé** :
  [ADR-020](../decisions/ADR-020-product-photo-metadata-and-publication-gate.md) —
  `Accepted — conception uniquement, implémentation en G7F-A2`
- **Dépendance amont** : G7F-A1 (conception, cet ADR) — terminé
- **Dépendance aval** : G7E (routes/pages/carte) ne peut pas exposer
  `searchPublicOffers` tant que G7F-A2 n'est pas terminé ; G7F-B (UI guidée,
  upload réel, CDN) dépend de G7F-A2

> **Note rétrospective (2026-08-30)** : ce document décrit uniquement le
> périmètre historique de G7F-A2 et ne constitue pas l’état courant de la
> livraison photo. Depuis ce lot, G8B-1 a livré l’upload R2 réel et G8B-3B4 a
> livré partiellement le Photo Coach, les slots contractuels, la persistance
> `slot_type`, la checklist et les overlays. ADR-031 et la migration `0050`
> ajoutent depuis un gate par slots pour la catégorie `bike` ; voir
> `docs/implementation/g8b-3b-assisted-bike-onboarding.md` pour les écarts
> restants.

## 1. Objet et périmètre

G7F-A2 implémente les décisions de l'ADR-020 :

- Migration PostgreSQL 0034 (enum, table, index, contraintes CHECK,
  triggers, fonction de comptage).
- Schéma Drizzle aligné (`packages/database/src/schema.ts`).
- Adapter PostgreSQL du publication gate
  (`packages/core/src/photos/postgres-publication-gate.ts`).
- Fonction `deleteProductPhoto`
  (`packages/core/src/photos/delete-product-photo.ts`).
- Mise à jour de `collectPublicationFailures` pour vérifier les photos.
- Câblage du gate dans les appelants de `searchPublicOffers`.
- Tests d'intégration PostgreSQL et tests unitaires.

### Hors périmètre de G7F-A2 (état historique)

- Aucun upload réel, appel R2, URL signée ou configuration fournisseur
  (G7F-B).
- Aucune UI (G7F-B).
- Aucun re-encoding d'image via `sharp`/imagor (G7F-B).
- Aucun CDN (G7F-B).
- Aucune règle par catégorie (G7F-B).
- Aucun changement Stripe, paiement, réservation ou pricing.

## 2. Migration 0034

### 2.1 Fichier

`packages/database/drizzle/0034_g7f_a_product_photos.sql`

### 2.2 Enum

```sql
CREATE TYPE product_photo_file_state AS ENUM (
  'PENDING_UPLOAD',
  'AVAILABLE',
  'REJECTED',
  'DELETED'
);
```

### 2.3 Table `product_photos`

```sql
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
  CONSTRAINT product_photos_sort_order_non_negative CHECK (sort_order >= 0)
);
```

Les colonnes techniques (`content_type`, `byte_size`, `width_px`, `height_px`,
`checksum_sha256`) sont **nullables** car l'état `PENDING_UPLOAD` ne doit pas
prétendre connaître ces métadonnées. La contrainte
`product_photos_state_invariants` garantit que `AVAILABLE` exige toutes les
métadonnées non nulles, et les contraintes de bornes nullables garantissent que
les valeurs respectent les limites techniques verrouillées pour G7F-A2 (10 MB,
200–8000 px, JPEG/PNG/WebP — voir ADR-020 §F.2). Ces valeurs pourront être
ajustées par migration future.

Un index unique sur `products(id, organization_id)` est requis pour la FK
composite (à ajouter si non existant) :

```sql
CREATE UNIQUE INDEX IF NOT EXISTS products_id_organization_id_unique
  ON products (id, organization_id);
```

```sql
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
```

### 2.5 Fonction `count_valid_product_photos`

La fonction `count_valid_product_photos` fait confiance à l'état `AVAILABLE` :
seules les photos dont l'upload a été validé (MIME, taille, dimensions,
checksum) par le processus d'upload (G7F-B) reçoivent l'état `AVAILABLE`. La
contrainte CHECK `product_photos_state_invariants` garantit au niveau
PostgreSQL qu'une photo `AVAILABLE` a toutes ses métadonnées techniques non
nulles, et les contraintes de bornes nullables
(`product_photos_content_type_valid`, `product_photos_byte_size_valid`,
`product_photos_dimensions_valid`) garantissent qu'elles respectent les bornes.
L'index unique partiel `product_photos_product_id_checksum_unique` empêche les
doublons de checksum au niveau schema. La fonction de comptage vérifie donc :
`file_state = 'AVAILABLE'`, `deleted_at IS NULL`, `checksum_sha256 IS NOT
NULL`, et compte les checksums DISTINCTS (défense supplémentaire).

```sql
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
```

### 2.6 Trigger `check_product_publication_photos`

`CREATE CONSTRAINT TRIGGER ... AFTER INSERT OR UPDATE ON products`, déclaré
`DEFERRABLE INITIALLY DEFERRED` (cohérent avec le pattern 0033 et l'ADR §C.5).
Si la transition est vers `PUBLISHED` et le compte de photos valides est < 3 →
`RAISE EXCEPTION`.

**Note de syntaxe** : la clause `OF publication_status` n'est pas supportée par
`CREATE CONSTRAINT TRIGGER` en PostgreSQL 16 (la clause `OF column` est
réservée aux triggers normaux, pas aux constraint triggers). Le trigger se
déclenche donc sur tout `INSERT OR UPDATE` et la fonction fait le filtrage
interne : elle sort immédiatement lorsque
`NEW.publication_status <> 'PUBLISHED'` ou lorsque l'UPDATE ne change pas le
`publication_status`.

Le caractère `DEFERRABLE INITIALLY DEFERRED` permet de valider à la fin de
transaction, ce qui est nécessaire car la publication peut impliquer plusieurs
modifications dans la même transaction (ex : ajout de photos + transition
`PUBLISHED`). Note : `CREATE CONSTRAINT TRIGGER` requiert `AFTER` (pas `BEFORE`)
selon la syntaxe PostgreSQL, ce qui est cohérent avec le pattern 0033.

```sql
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
  FOR EACH ROW
  DEFERRABLE INITIALLY DEFERRED
  EXECUTE FUNCTION check_product_publication_photos();
```

### 2.7 Trigger `guard_product_photo_deletion`

BEFORE UPDATE OR DELETE sur `product_photos`. Si le produit parent est
`PUBLISHED` et que la modification ferait passer le compte sous 3 →
`RAISE EXCEPTION`. La fonction trigger doit `SELECT ... FOR UPDATE` sur la ligne
`products` parent, car les triggers BEFORE ont un verrou sur la ligne
`product_photos` mais pas sur `products`. L'ordre de verrouillage unique est :
toujours verrouiller `products` avant `product_photos` pour éviter les
deadlocks.

```sql
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
```

### 2.7bis Trigger `guard_product_photo_immutability`

BEFORE UPDATE sur `product_photos`. Garantit l'immutabilité des champs
d'identité et des métadonnées techniques après `AVAILABLE`, et valide les
transitions de la machine d'états.

```sql
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
```

### 2.8 Rollback

La migration doit inclure les `DROP` inverses pour les tests upgrade/rollback
:

- `DROP TRIGGER` (trois triggers : `check_product_publication_photos`,
  `guard_product_photo_deletion`, `guard_product_photo_immutability`),
  `DROP FUNCTION` (quatre fonctions : `check_product_publication_photos`,
  `guard_product_photo_deletion`, `guard_product_photo_immutability`,
  `count_valid_product_photos`), `DROP INDEX` (y compris l'index unique
  partiel `product_photos_product_id_checksum_unique`),
  `DROP TABLE`, `DROP TYPE`.

## 3. Schéma Drizzle

### 3.1 Fichier

`packages/database/src/schema.ts`

### 3.2 Ajouts

- Enum `productPhotoFileState` : `'PENDING_UPLOAD' | 'AVAILABLE' | 'REJECTED'
  | 'DELETED'` (via `pgEnum`).
- Table `productPhotos` avec toutes les colonnes de la migration 0034,
  mappings camelCase → snake_case conformes aux conventions du dépôt.
- Types `ProductPhotoRecord`, `NewProductPhotoRecord` exportés.
- La table `productPhotos` référence `organizations` (RESTRICT) et
  `products` via FK composite `(productId, organizationId)` (CASCADE).
- `contentType`, `byteSize`, `widthPx`, `heightPx`, `checksumSha256`
  nullables (PENDING_UPLOAD ne connaît pas ces métadonnées).

### 3.3 Convention

- `bigint({ mode: 'number' })` pour `byteSize` (nullable).
- `integer` pour `widthPx`, `heightPx`, `sortOrder` (`widthPx`, `heightPx`
  nullables).
- `timestamp({ withTimezone: true, mode: 'date' })` pour `createdAt`,
  `updatedAt`, `deletedAt`.
- `deletedAt` nullable.

## 4. Adapter PostgreSQL du publication gate

### 4.1 Fichier

`packages/core/src/photos/postgres-publication-gate.ts` (à créer)

### 4.2 Classe

```typescript
export class PostgresPhotoPublicationGate
  implements PublicProductPublicationGate
```

### 4.3 Méthode `filterEligibleProductIds`

- **Une seule requête SQL** pour N produits.
- Compte les photos valides (`file_state = 'AVAILABLE'`, `deleted_at IS NULL`,
  checksums distincts via `COUNT(DISTINCT checksum_sha256)`) par produit.
- Filtre par les `productIds` en entrée.
- Retourne le `Set` des `productIds` avec ≥ 3 photos valides.
- Vérifie la cohérence `organization_id` / `product_id` : un produit ne peut
  pas être éligible pour une autre organisation (le `organization_id` du
  produit est vérifié dans la requête).

### 4.4 Requête SQL conceptuelle

La requête joint explicitement sur `organization_id` pour garantir la
cohérence multi-tenant au niveau du gate :

```sql
SELECT p.id
FROM products p
WHERE p.id = ANY($1::uuid[])
  AND p.deleted_at IS NULL
  AND (
    SELECT COUNT(DISTINCT pp.checksum_sha256)
    FROM product_photos pp
    WHERE pp.product_id = p.id
      AND pp.organization_id = p.organization_id
      AND pp.file_state = 'AVAILABLE'
      AND pp.deleted_at IS NULL
      AND pp.checksum_sha256 IS NOT NULL
  ) >= 3;
```

### 4.5 Fail-closed

**Une erreur PostgreSQL doit produire une erreur typée
`PUBLICATION_GATE_UNAVAILABLE`** (ou équivalent). `searchPublicOffers` doit la
convertir en erreur publique nettoyée (sans détail SQL, clé R2, organisation
interne ou nom de table). Ne jamais transformer silencieusement une panne DB en
« aucun résultat » (`Set` vide) — cela masquerait une panne et violerait le
contrat fail-closed. Le `Set` vide est retourné uniquement lorsque la requête
réussit et qu'aucun produit n'est éligible.

- **Aucune implémentation permissive** : pas de `() => true`, pas de fallback.

### 4.6 Export

La classe est exportée depuis `packages/core/src/photos/index.ts` (à créer)
et depuis `packages/core/src/index.ts` si nécessaire.

## 5. `deleteProductPhoto`

### 5.1 Fichier

`packages/core/src/photos/delete-product-photo.ts` (à créer en G7F-A2)

### 5.2 Signature

```typescript
export async function deleteProductPhoto(
  db: DatabaseClient,
  organizationId: string,
  photoId: string,
): Promise<void>;
```

### 5.3 Comportement

1. `SELECT ... FOR UPDATE` sur le produit parent (via la photo) pour verrouiller
   la ligne produit dans la transaction courante. **Ordre de verrouillage
   unique** : toujours verrouiller `products` avant `product_photos` pour éviter
   les deadlocks.
2. Compter les photos valides du produit via `count_valid_product_photos`.
3. Si le produit est `PUBLISHED` et que le compte après suppression serait < 3 →
   lever une erreur métier typée `PHOTO_DELETION_WOULD_BREAK_PUBLICATION`.
4. Soft delete de la photo : `deleted_at = now()`, `file_state = 'DELETED'`.
5. **G7F-A2 : soft delete métadonnées uniquement.** L'émission de l'outbox
   event `photo_object_cleanup` et le consumer worker sont reportés à G7F-B
   (aucun objet R2 n'existe encore en G7F-A2).

### 5.4 Defense-in-depth

Le trigger `guard_product_photo_deletion` (PostgreSQL, §2.7) est une
defense-in-depth : il rejette également la suppression si elle ferait passer le
compte de photos valides sous le seuil de 3 pour un produit `PUBLISHED`. La
vérification côté Core (étape 3) fournit un message métier explicite avant la
mutation ; le trigger garantit l'invariant au niveau base de données même en cas
de contournement de la fonction Core.

## 6. Mise à jour de `collectPublicationFailures`

### 6.1 Fichier

`packages/core/src/catalog/products.ts`

### 6.2 Ajout

Dans `collectPublicationFailures` (`packages/core/src/catalog/products.ts:242-282`),
ajouter après la vérification des variantes :

- Compter les photos valides (`file_state = 'AVAILABLE'`, `deleted_at IS NULL`,
  checksums distincts) pour le produit.
- Si le compte est < 3, ajouter un échec :
  `'Au moins 3 photos valides sont requises pour la publication.'`

Cette vérification côté Core est redondante avec le trigger PostgreSQL, ce qui
est intentionnel : le Core fournit un message métier explicite avant la
mutation, et le trigger garantit l'invariant au niveau base de données.

## 7. Câblage du gate dans les appelants

### 7.1 `searchPublicOffers`

`searchPublicOffers` (`packages/core/src/public-search/search-offers.ts:170-177`)
exige déjà un `publicationGate` explicite et fail-closed si absent. Le
câblage consiste à :

- Instancier `PostgresPhotoPublicationGate` dans les appelants (API routes
  G7E, tests d'intégration).
- Passer l'instance dans `options.publicationGate`.

### 7.2 Tests d'intégration `search-offers`

- `packages/core/src/public-search/search-offers.integration.test.ts` :
  remplacer le mock/stub du gate par `PostgresPhotoPublicationGate` réel
  sur une DB de test, ou conserver un stub pour les tests unitaires et
  ajouter un test d'intégration dédié au gate réel.

### 7.3 API routes G7E

- G7E (non démarré) devra instancier `PostgresPhotoPublicationGate` avec
  le `DatabaseClient` de la requête et le passer à `searchPublicOffers`.
- Aucun changement G7E dans ce plan — G7E est hors périmètre.

## 8. Tests

### 8.1 Tests de schéma PostgreSQL

Fichier : `packages/database/src/schema-g7f-a-photos.test.ts` (à créer)

- Création de la table, enum, index, contraintes CHECK.
- Contrainte `sort_order >= 0` : insertion avec `sort_order` négatif →
  erreur.
- **PENDING_UPLOAD sans métadonnées techniques** → accepté (colonnes
  nullables).
- **AVAILABLE sans une seule métadonnée technique** → refusé par
  `product_photos_state_invariants`.
- Contrainte `REJECTED` sans `rejection_reason` → erreur.
- Contrainte `DELETED` sans `deleted_at` → erreur.
- **Cross-tenant INSERT** : `product_photos` avec `organization_id` ≠
  `products.organization_id` → refusé par FK composite.
- **Cross-tenant UPDATE** : changer `organization_id` après création → refusé
  par trigger `guard_product_photo_immutability`.
- **Doublon checksum actif** : deux photos `AVAILABLE` même checksum même
  produit → refusé par index unique partiel
  `product_photos_product_id_checksum_unique`.
- **Syntaxe et comportement réel du constraint trigger PostgreSQL 16** → test
  DDL (vérifier que `CREATE CONSTRAINT TRIGGER ... AFTER INSERT OR UPDATE ON
  products` s'exécute sans erreur).
- Tests upgrade/rollback (création puis suppression de la migration).

### 8.2 Tests des triggers

- **Trigger `check_product_publication_photos`** :
  - Publication (`DRAFT` → `PUBLISHED`) avec 0, 1, 2 photos valides →
    erreur.
  - Publication avec 3 photos valides → succès.
  - Publication avec 3 photos dont 2 ont le même checksum (doublons) →
    erreur (compte distinct < 3).
  - Publication avec 3 photos `AVAILABLE` + 1 `PENDING_UPLOAD` → succès
    (seules `AVAILABLE` comptent).
  - Publication avec 3 photos `AVAILABLE` + 1 `DELETED` → succès.
  - Produit déjà `PUBLISHED` mis à jour sans changement de
    `publication_status` → pas de déclenchement.
  - `ARCHIVED` → `PUBLISHED` avec < 3 photos → erreur.
- **Trigger `guard_product_photo_deletion`** :
  - Produit `PUBLISHED` avec exactement 3 photos valides : suppression
    d'une photo → erreur.
  - Produit `PUBLISHED` avec 4 photos valides : suppression d'une photo →
    succès (reste 3).
  - Produit `PUBLISHED` avec 3 photos : soft delete d'une photo
    (`file_state` → `DELETED`) → erreur.
  - Produit `ARCHIVED` avec 3 photos : suppression d'une photo → succès
    (pas de protection hors `PUBLISHED`).
  - Produit `PUBLISHED` avec 3 photos : transition d'une photo
    `AVAILABLE` → `REJECTED` → erreur.
- **Trigger `guard_product_photo_immutability`** :
  - **Champs d'identité immuables** (`organization_id`, `product_id`,
    `storage_key`) → refusé par trigger.
  - **Checksum/métadonnées immuables après `AVAILABLE`** → refusé par
    trigger.
  - **Transitions d'état interdites** (`AVAILABLE` → `PENDING_UPLOAD`,
    `REJECTED` → `AVAILABLE`, `DELETED` → anything) → refusées par trigger.
  - Transition `PENDING_UPLOAD` → `AVAILABLE` → succès.
  - Transition `PENDING_UPLOAD` → `REJECTED` → succès.
  - Transition `AVAILABLE` → `DELETED` → succès (si produit non
    `PUBLISHED` ou compte reste ≥ 3).
  - Transition `REJECTED` → `DELETED` → succès.

### 8.3 Tests du publication gate

Fichier : `packages/core/src/photos/postgres-publication-gate.test.ts` (à
créer)

- **Gate batch** : N produits avec des comptes variés (0, 1, 2, 3, 5
  photos) → filtrage correct.
- **Gate batch avec doublons** : produit avec 3 photos dont 2 ont le même
  checksum → non éligible.
- **Multi-tenant** : un produit d'une organisation A ne peut pas être
  éligible pour une organisation B (vérification `organization_id`).
- **Fail-closed** : panne du gate transformée en erreur typée
  `PUBLICATION_GATE_UNAVAILABLE` (pas `Set` vide silencieux).
- **Batch unique** : vérifier qu'une seule requête est exécutée pour N
  produits (pas de N requêtes).
- **Produit soft-deleted** : produit avec `deleted_at` non null → non
  éligible même avec 3 photos.
- **Photos soft-deleted** : photos avec `deleted_at` non null → non
  comptées.
- **Photos non `AVAILABLE`** : photos `PENDING_UPLOAD`, `REJECTED`,
  `DELETED` → non comptées.
- **Produit PUBLISHED historique sans photos** → invisible dans
  `searchPublicOffers` (gate retourne non éligible).

### 8.4 Tests de concurrence

Fichier : `packages/core/src/integration/photos-concurrency.test.ts` (à
créer)

- **Publication concurrente avec ajout de photo** : deux transactions
  concurrentes, l'une publie le produit, l'autre ajoute la 3ᵉ photo. Le
  verrou `FOR UPDATE` sur le produit empêche la publication avant la fin de
  l'ajout.
- **Deux suppressions concurrentes (4 → 3, jamais 4 → 2)** : produit
  `PUBLISHED` avec 4 photos. Transaction A retire photo 1 (`SELECT FOR
  UPDATE` sur `products`, compte=4, après=3, OK). Transaction B retire
  photo 2 simultanément (`SELECT FOR UPDATE` sur `products` — BLOQUÉ par
  A). A commit, B obtient le verrou, compte maintenant=3, après=2 → REJET.
  Résultat : 4 → 3, jamais 4 → 2. Test avec deux connexions PostgreSQL et
  transactions concurrentes.
- **Publication + suppression concurrente** : une transaction publie, une
  autre supprime une photo. Le verrou sérialise et le trigger garantit
  l'invariant. Test avec deux connexions.

### 8.5 Tests de `collectPublicationFailures`

Fichier : `packages/core/src/catalog/products.test.ts` (existant, à étendre)

- Produit avec < 3 photos valides → échec `'Au moins 3 photos valides...'`.
- Produit avec ≥ 3 photos valides → pas d'échec lié aux photos.
- Produit avec 3 photos dont doublons → échec.

### 8.6 Tests de `deleteProductPhoto`

Fichier : `packages/core/src/photos/delete-product-photo.test.ts` (à créer)

- Produit `PUBLISHED` avec exactement 3 photos valides : suppression → erreur
  `PHOTO_DELETION_WOULD_BREAK_PUBLICATION`.
- Produit `PUBLISHED` avec 4 photos valides : suppression d'une photo → succès
  (reste 3).
- Produit `ARCHIVED` avec 3 photos : suppression d'une photo → succès (pas de
  protection hors `PUBLISHED`).
- **Aucun événement outbox sans consumer** : vérifier que G7F-A2 n'émet pas
  `photo_object_cleanup` (soft delete métadonnées uniquement, outbox reporté
  à G7F-B).
- Le trigger `guard_product_photo_deletion` rejette également la suppression
  (defense-in-depth).

## 9. Documentation

### 9.1 `agent-context.md`

Après exécution des tests, ajouter une entrée G7F-A2 dans la section
« Historique d'avancement » de `docs/implementation/agent-context.md` :

- Date de terminaison.
- Migration 0034 créée (enum, table, index, contraintes, triggers,
  fonction).
- Schéma Drizzle aligné.
- `PostgresPhotoPublicationGate` implémenté et testé.
- `deleteProductPhoto` implémenté et testé.
- `collectPublicationFailures` mis à jour.
- Nombre de tests et couverture.
- G7E débloqué (gate réel disponible).

### 9.2 `backlog.md`

Mettre à jour la ligne G7F-A dans `docs/implementation/backlog.md:147` pour
indiquer le statut terminé.

### 9.3 ADR-020

Si des ajustements sont nécessaires pendant l'implémentation (valeurs
finales de limites, formats, etc.), mettre à jour l'ADR-020 avec une note
de révision.

## 10. Ordre d'exécution

1. Créer la migration 0034 (enum, table, index unique partiel, contraintes
   CHECK, FK composite, trois triggers, deux fonctions trigger + fonction de
   comptage, rollback).
2. Mettre à jour le schéma Drizzle (`schema.ts`).
3. Créer `packages/core/src/photos/postgres-publication-gate.ts`.
4. Créer `packages/core/src/photos/delete-product-photo.ts`.
5. Créer `packages/core/src/photos/index.ts` (export).
6. Mettre à jour `collectPublicationFailures` dans `products.ts`.
7. Écrire les tests de schéma (`schema-g7f-a-photos.test.ts`).
8. Écrire les tests des triggers (intégration).
9. Écrire les tests du gate (`postgres-publication-gate.test.ts`).
10. Écrire les tests de concurrence (`photos-concurrency.test.ts`).
11. Étendre les tests `products.test.ts` pour `collectPublicationFailures`.
12. Exécuter `pnpm test` et corriger les échecs.
13. Exécuter `pnpm prettier --check .` et `git diff --check`.
14. Mettre à jour `agent-context.md` et `backlog.md`.
15. Mettre à jour ADR-020 si ajustements.

## 11. Critères d'acceptation

- La migration 0034 s'applique et se rollback sans erreur.
- Le schéma Drizzle est aligné avec la migration.
- Le trigger `check_product_publication_photos` rejette toute publication
  avec < 3 photos valides.
- Le trigger `guard_product_photo_deletion` rejette toute suppression
  ferait passer un produit `PUBLISHED` sous 3 photos.
- `PostgresPhotoPublicationGate.filterEligibleProductIds` retourne
  correctement les produits éligibles en une seule requête batch.
- Le gate est fail-closed (erreur PostgreSQL → erreur typée
  `PUBLICATION_GATE_UNAVAILABLE`, jamais `Set` vide silencieux).
- `collectPublicationFailures` vérifie les photos.
- `deleteProductPhoto` lève une erreur typée
  `PHOTO_DELETION_WOULD_BREAK_PUBLICATION` si la suppression ferait passer un
  produit `PUBLISHED` sous 3 photos.
- `deleteProductPhoto` n'émet pas d'outbox event `photo_object_cleanup`
  (reporté à G7F-B).
- Le trigger `guard_product_photo_immutability` rejette toute modification des
  champs d'identité et des métadonnées techniques après `AVAILABLE`.
- La machine d'états est respectée (transitions interdites rejetées).
- La FK composite multi-tenant rejette les INSERT cross-tenant.
- L'index unique partiel rejette les doublons de checksum `AVAILABLE`.
- Les tests de concurrence valident le verrouillage et les triggers sous
  charge concurrente (deux connexions PostgreSQL, 4 → 3 jamais 4 → 2).
- Aucune implémentation permissive (`() => true`) n'existe dans le dépôt.
- `pnpm prettier --check .` passe.
- `git diff --check` passe.
- `agent-context.md` et `backlog.md` mis à jour.
