# ADR-020 — Métadonnées photo produit et gate de publication publique

- **Statut** : Accepted — conception et implémentation G7F-A2 livrées ; extensions
  G8B-1 et G8B-3B4 partiellement livrées
- **Date** : 2026-08-08
- **Phase** : 11 / Lot 7 — G7F-A1 : décision et conception ; G7F-A2 : implémentation
  (migration, schéma Drizzle, triggers, gate PostgreSQL, tests) ; G8B-1/G8B-3B4 :
  upload réel et Photo Coach hors périmètre initial
- **Décideurs** : Porteur produit Uttily, engineering
- **Relie à** : ADR-014, ADR-017, ADR-018 ;
  `docs/product/lot7-arbitrage.md` ;
  `docs/implementation/g7f-a2-implementation-plan.md`

> **Note de révision (2026-08-30)** : le standard produit vélo et la direction
> de confiance publique sont précisés dans
> `docs/product/g8b-3-bike-pilot-visual-trust-and-coach.md`. Le gate actuellement livré
> reste exclusivement technique : il ne reconnaît ni l'angle, ni le cadrage, ni
> la netteté. Le Photo Coach, ses slots contractuels et sa persistance sont
> désormais livrés en vertical slice, mais l'enforcement serveur par slot et le
> badge professionnel ne le sont pas encore. Toute validation serveur de slots
> visuels exige une évolution dédiée ; cette note ne prétend pas qu'elle est déjà
> implémentée.

## 1. Contexte

### 1.1 Exigence produit

Le produit exige trois photos valides minimum avant toute publication publique
d'une offre (`docs/product/lot7-arbitrage.md`). Cette règle doit être vérifiée
côté serveur (Core) ET côté PostgreSQL (trigger + contrainte), jamais
uniquement côté UI. Le fallback visuel est autorisé dans le dashboard, pendant
un brouillon ou lors d'une erreur technique d'affichage, mais ne permet jamais
de publier une offre possédant moins de trois photos valides.

### 1.2 État actuel vérifié

- La table `products` possède `publicationStatus` (enum `DRAFT | PUBLISHED |
  ARCHIVED`) mais aucune contrainte CHECK sur la publication au niveau
  PostgreSQL et aucun trigger de validation des prérequis de publication.
- `publishProduct` (`packages/core/src/catalog/products.ts:293-342`) valide :
  nom ≥ 2 caractères, description non vide, catégorie active, ≥ 1 variante
  active. **Aucune vérification de photos.**
- `collectPublicationFailures` (`packages/core/src/catalog/products.ts:242-282`)
  ne vérifie pas les photos.
- Aucun modèle photo n'existe en base.
- L'interface `PublicProductPublicationGate`
  (`packages/core/src/public-search/types.ts:157-162`) est définie et utilisée
  par `searchPublicOffers` (`packages/core/src/public-search/search-offers.ts:170-177`)
  en mode fail-closed si le gate est absent. **Aucune implémentation n'existe.**
- L'adapter R2 (`apps/worker/src/adapters/r2-object-storage.ts`, 607 lignes,
  G5H-A) est implémenté et testé : `@aws-sdk/client-s3` avec endpoint R2,
  bucket privé juridiction EU, `putIfAbsent` avec écriture conditionnelle
  (`IfNoneMatch: '*'`), checksum SHA-256 hex en custom metadata, aucun
  téléchargement public ni URL signée. Il n'est pas encore utilisé pour les
  photos.

### 1.3 Risque

G7E ne peut pas exposer `searchPublicOffers` tant que le publication gate
PostgreSQL réel n'est pas implémenté. Sans gate, la recherche publique
exposerait des produits sans photos, violant l'exigence produit et créant une
incohérence entre l'état métier (`PUBLISHED`) et la visibilité publique.

### 1.4 Périmètre de cet ADR

Cet ADR documente la conception initiale ; à sa date de rédaction, il ne créait
aucune migration, aucun schéma Drizzle, aucun trigger, aucun code logique,
aucun appel R2, aucune URL signée et aucune UI. L'implémentation G7F-A2 est
désormais livrée ; les extensions ultérieures sont décrites dans
`docs/implementation/g8b-1-product-photo-upload.md` et
`docs/implementation/g8b-3b-assisted-bike-onboarding.md`.

## 2. Décisions

### A. Modèle de métadonnées photo

#### A.1 Table `product_photos`

La table `product_photos` (à créer en G7F-A2) stocke exclusivement des
métadonnées. Aucune donnée binaire n'est persistée dans PostgreSQL.

| Colonne | Type | Contraintes | Description |
| --- | --- | --- | --- |
| `id` | uuid | PK, `defaultRandom` | Identifiant interne |
| `organization_id` | uuid | NOT NULL, FK → `organizations`, `ON DELETE RESTRICT` ; immuable après INSERT | Rattachement multi-tenant explicite |
| `product_id` | uuid | NOT NULL, FK composite → `products(id, organization_id)`, `ON DELETE CASCADE` ; immuable après INSERT | Produit propriétaire |
| `storage_key` | text | NOT NULL ; immuable après INSERT | Clé objet R2 opaque, sans URL publique persistée |
| `content_type` | text | **nullable** ; immuable après `AVAILABLE` | Type MIME réel validé (magic bytes) |
| `byte_size` | bigint | **nullable** ; immuable après `AVAILABLE` | Taille en octets |
| `width_px` | integer | **nullable** ; immuable après `AVAILABLE` | Largeur en pixels |
| `height_px` | integer | **nullable** ; immuable après `AVAILABLE` | Hauteur en pixels |
| `checksum_sha256` | text | **nullable** ; immuable après `AVAILABLE` | Checksum SHA-256 hex du contenu |
| `sort_order` | integer | NOT NULL, DEFAULT 0 | Ordre d'affichage |
| `file_state` | `product_photo_file_state` | NOT NULL | État du fichier |
| `rejection_reason` | text | nullable | Raison si `REJECTED` |
| `created_at` | timestamptz | NOT NULL, DEFAULT `now()` | Création |
| `updated_at` | timestamptz | NOT NULL, DEFAULT `now()` | Mise à jour |
| `deleted_at` | timestamptz | nullable | Soft delete |

Les colonnes techniques (`content_type`, `byte_size`, `width_px`, `height_px`,
`checksum_sha256`) sont **nullables** car l'état `PENDING_UPLOAD` ne doit pas
prétendre connaître ces métadonnées (l'upload R2 n'a pas encore eu lieu). Seul
l'état `AVAILABLE` exige toutes ces métadonnées non nulles et valides (garanti
par la contrainte CHECK `product_photos_state_invariants`, voir §A.5).

#### A.1bis Clé étrangère composite multi-tenant

La cohérence multi-tenant est garantie au niveau PostgreSQL par une **FK
composite** plutôt qu'une FK simple :

- Ajouter un `UNIQUE INDEX products_id_organization_id_unique
  ON products(id, organization_id)` (ou contrainte unique équivalente).
- Remplacer la FK simple `product_photos.product_id → products(id)` par une
  **FK composite** `product_photos(product_id, organization_id) →
  products(id, organization_id)`.
- Conserver la FK `organization_id → organizations(id)` séparée
  (`ON DELETE RESTRICT`).

Cette FK composite garantit `product_photos.organization_id =
products.organization_id` au niveau PostgreSQL, même par SQL direct (bypass
Core). Une ligne `product_photos` avec un `organization_id` ≠
`products.organization_id` est rejetée par la FK composite à l'INSERT.

#### A.1ter Immutabilité après INSERT / après AVAILABLE

Les champs d'identité (`organization_id`, `product_id`, `storage_key`) sont
**immuables après INSERT** (trigger `guard_product_photo_immutability`,
BEFORE UPDATE sur `product_photos`). Les métadonnées techniques
(`content_type`, `byte_size`, `width_px`, `height_px`, `checksum_sha256`) sont
**immuables après passage à `AVAILABLE`**. Seules les transitions contrôlées
vers `DELETED` et les colonnes `sort_order`, `rejection_reason`, `deleted_at`,
`updated_at` restent modifiables.

#### A.2 Enum `product_photo_file_state`

```text
PENDING_UPLOAD | AVAILABLE | REJECTED | DELETED
```

#### A.3 Clé R2

La clé R2 est `product-photos/{organizationId}/{productId}/{photoId}` où
`photoId` est l'UUID `id` de l'enregistrement PostgreSQL. Cette clé est opaque
et n'utilise jamais le nom de fichier utilisateur. Le nom de fichier
utilisateur est ignoré et non persisté.

#### A.4 Index

- `(product_id, deleted_at)` — requêtes par produit, soft delete
- `(organization_id, deleted_at)` — requêtes par organisation, soft delete
- `(product_id, file_state, deleted_at)` — comptage des photos valides par
  produit (utilisée par le trigger et le publication gate)
- Index unique partiel `product_photos_product_id_checksum_unique
  ON product_photos (product_id, checksum_sha256)
  WHERE file_state = 'AVAILABLE' AND deleted_at IS NULL
  AND checksum_sha256 IS NOT NULL` — empêche deux photos `AVAILABLE` du même
  produit de partager le même checksum (photos distinctes). Cette contrainte est
  tenant-safe (`product_id` appartient à une organisation) et compatible avec le
  soft delete (partial index sur `deleted_at IS NULL`).

#### A.5 Contraintes CHECK

Les contraintes CHECK remplacent les anciennes contraintes partielles par un
invariant d'état exhaustif (`product_photos_state_invariants`) qui encode la
nullabilité selon l'état, plus des contraintes de bornes nullables (qui
s'appliquent uniquement lorsque la colonne est non nulle) :

```sql
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
CONSTRAINT product_photos_content_type_valid
  CHECK (content_type IS NULL OR content_type IN ('image/jpeg', 'image/png', 'image/webp')),
CONSTRAINT product_photos_byte_size_valid
  CHECK (byte_size IS NULL OR (byte_size > 0 AND byte_size <= 10485760)),
CONSTRAINT product_photos_dimensions_valid
  CHECK ((width_px IS NULL OR (width_px >= 200 AND width_px <= 8000))
         AND (height_px IS NULL OR (height_px >= 200 AND height_px <= 8000))),
CONSTRAINT product_photos_sort_order_non_negative CHECK (sort_order >= 0)
```

- **PENDING_UPLOAD** : métadonnées techniques nullables, pas de `deleted_at`,
  pas de `rejection_reason`.
- **AVAILABLE** : toutes métadonnées techniques NOT NULL + dans bornes, pas de
  `deleted_at`, pas de `rejection_reason`.
- **REJECTED** : `rejection_reason` NOT NULL, métadonnées partielles OK (la
  validation a pu échouer avant la complétude), pas de `deleted_at`.
- **DELETED** : `deleted_at` NOT NULL, métadonnées conservées (celles déjà
  connues au moment du soft delete).

#### A.6 Principes

- Aucune donnée binaire dans PostgreSQL.
- Aucune URL R2 signée persistée : les URLs signées sont générées à la
  demande, courte durée, jamais stockées en base.
- Aucune URL publique directe : la livraison publique passe par un CDN
  (G7F-B) qui masque le bucket R2.
- `organization_id` explicite sur chaque ligne pour le respect multi-tenant,
  cohérent avec les conventions du dépôt.

### B. Cycle de vie des photos

#### B.1 États et machine d'états

- **PENDING_UPLOAD** : enregistrement créé, upload R2 pas encore effectué. La
  clé R2 est réservée. Métadonnées techniques nullables. Timeout : si pas de
  transition vers `AVAILABLE` après un délai configurable, nettoyage par worker.
- **AVAILABLE** : fichier réellement présent dans R2, validé (MIME, taille,
  dimensions, checksum). Toutes métadonnées techniques NOT NULL + dans bornes.
  **Seul cet état compte pour le seuil des 3 photos.**
- **REJECTED** : validation a échoué (MIME non autorisé, taille/dimensions
  hors bornes, checksum mismatch). Objet R2 supprimé ou jamais uploadé.
  `rejection_reason` renseigné. Métadonnées partielles OK.
- **DELETED** : soft delete par le loueur ou retrait automatique. `deleted_at`
  positionné. Métadonnées conservées (celles déjà connues).

**Machine d'états autorisée** (implémentée via trigger BEFORE UPDATE sur
`product_photos` qui vérifie les transitions autorisées) :

```text
PENDING_UPLOAD → AVAILABLE | REJECTED | DELETED
AVAILABLE      → DELETED
REJECTED       → DELETED
DELETED        → (terminal, aucune résurrection implicite)
```

Aucune transition non listée n'est autorisée. En particulier :
- `AVAILABLE → PENDING_UPLOAD` est interdit.
- `REJECTED → AVAILABLE` est interdit.
- `DELETED → anything` est interdit (pas de résurrection).
- `AVAILABLE → REJECTED` est interdit (un fichier validé ne peut pas être
  « invalidé » ; il doit être supprimé via `DELETED`).

#### B.2 Échec partiel PostgreSQL/R2

Si l'écriture R2 réussit mais la transaction PostgreSQL échoue (ou inversement
pour la suppression), l'objet R2 devient orphelin ou l'enregistrement
PostgreSQL reste sans objet. Le nettoyage est assuré par un worker périodique :

- scan des objets R2 sans enregistrement PostgreSQL correspondant ;
- scan des enregistrements `PENDING_UPLOAD` expirés ;
- suppression des objets R2 orphelins après confirmation.

#### B.3 Nettoyage des objets supprimés — reporté à G7F-B

G7F-A2 ne réalise aucun upload R2 réel. Aucun objet R2 n'existe encore en
G7F-A2. L'émission de l'outbox event `photo_object_cleanup` et le consumer
worker sont **reportés à G7F-B**.

- **G7F-A2** : soft delete métadonnées uniquement (`file_state` → `DELETED`,
  `deleted_at` positionné). Aucun outbox event émis, aucun consumer défini.
- **G7F-B** : ajout du consumer worker, outbox event `photo_object_cleanup`,
  idempotence, tests worker. Le délai de conservation entre soft delete et
  suppression physique de l'objet R2 est configurable (question ouverte —
  voir §5).

Ne pas émettre `photo_object_cleanup` sans consumer défini évite de prétendre
supprimer un objet R2 qui n'existe pas encore.

### C. Publication

#### C.1 Définition exacte d'une « photo valide »

Une photo est considérée valide pour le seuil de publication si et seulement
si toutes les conditions suivantes sont réunies :

1. `file_state = 'AVAILABLE'`
2. `deleted_at IS NULL`
3. `content_type` non null et dans la liste autorisée (JPEG, PNG, WebP —
   verrouillé pour G7F-A2, voir §F)
4. `byte_size` non null et dans les bornes (`> 0 AND <= 10485760` — verrouillé
   pour G7F-A2, voir §F)
5. `width_px` et `height_px` non nulls et dans les bornes (`200–8000` —
   verrouillé pour G7F-A2, voir §F)
6. `checksum_sha256` non null et correspondant au contenu R2
7. Photos distinctes : `checksum_sha256` différents (pas de doublons du même
   fichier — garanti par index unique partiel au niveau schema)

La fonction `count_valid_product_photos` fait confiance à l'état `AVAILABLE` :
seules les photos dont l'upload a été validé (MIME, taille, dimensions,
checksum) par le processus d'upload (G7F-B) reçoivent l'état `AVAILABLE`. La
contrainte CHECK `product_photos_state_invariants` garantit au niveau
PostgreSQL qu'une photo `AVAILABLE` a toutes ses métadonnées techniques non
nulles, et les contraintes de bornes nullables
(`product_photos_content_type_valid`, `product_photos_byte_size_valid`,
`product_photos_dimensions_valid`) garantissent qu'elles respectent les bornes.
La fonction de comptage vérifie donc : `file_state = 'AVAILABLE'`,
`deleted_at IS NULL`, `checksum_sha256 IS NOT NULL`, et compte les checksums
DISTINCTS. L'index unique partiel `product_photos_product_id_checksum_unique`
est une défense supplémentaire au niveau schema contre les doublons de
checksum.

#### C.2 Règle des trois photos

Un produit `PUBLISHED` doit avoir au moins 3 photos valides et distinctes.
La vérification est double :

- **Côté serveur (Core)** : `collectPublicationFailures` et
  `publishProduct` vérifient le compte de photos valides dans la même
  transaction que la transition vers `PUBLISHED`.
- **Côté PostgreSQL (trigger)** : le trigger `check_product_publication_photos`
  (`CREATE CONSTRAINT TRIGGER ... AFTER INSERT OR UPDATE ON products`,
  `DEFERRABLE INITIALLY DEFERRED`) compte les photos valides via la fonction
  `count_valid_product_photos(productId)`. Si la transition est vers
  `PUBLISHED` et le compte est < 3 → `RAISE EXCEPTION`. La clause
  `OF publication_status` n'est pas supportée par `CREATE CONSTRAINT TRIGGER`
  en PostgreSQL 16 ; la fonction fait le filtrage interne (sort immédiate
  lorsque `NEW.publication_status <> 'PUBLISHED'` ou lorsque l'UPDATE ne
  change pas le `publication_status`).

#### C.3 Protection contre la suppression sous le seuil

Le trigger `guard_product_photo_deletion` (BEFORE UPDATE OR DELETE sur
`product_photos`) vérifie : si le produit parent est `PUBLISHED` et que la
modification (soft delete, hard delete, ou transition `file_state` hors
`AVAILABLE`) ferait passer le compte de photos valides sous 3 → `RAISE
EXCEPTION`. Le trigger ne vérifie le seuil que si l'opération retire
réellement une photo valide (`OLD.file_state = 'AVAILABLE' AND OLD.deleted_at
IS NULL` pour DELETE ; `OLD était valide ET NEW n'est plus valide` pour
UPDATE). Pour toute autre opération (mise à jour de `sort_order`, suppression
de `PENDING_UPLOAD` ou `REJECTED`, opération ne réduisant pas le compte
valide), le trigger retourne immédiatement sans refuser, même pour un produit
`PUBLISHED` historique ayant moins de trois photos.

#### C.4 Comportement lors de la suppression d'une photo publiée

**Choix : refus de suppression** si elle ferait passer le produit `PUBLISHED`
sous le seuil de 3 photos.

**Justification** : le retrait automatique de visibilité créerait une
incohérence entre l'état métier (`PUBLISHED`) et la visibilité publique
(invisible). Le loueur doit explicitement archiver le produit d'abord
(`PUBLISHED` → `ARCHIVED`), puis supprimer la photo. Cela évite les effets de
bord silencieux et maintient l'intégrité métier. Le loueur peut toujours
archiver le produit, puis supprimer des photos librement.

#### C.5 Transaction et verrouillage

- `publishProduct` : `SELECT ... FOR UPDATE` sur le produit (déjà en place,
  `packages/core/src/catalog/products.ts:300-311`), compter les photos dans
  la même transaction. Le trigger `DEFERRABLE INITIALLY DEFERRED` valide à la
  fin de transaction.
- `deleteProductPhoto` : `SELECT ... FOR UPDATE` sur le produit parent,
  vérifier le compte dans la même transaction avant la mutation.
- **Ordre de verrouillage unique** : toujours verrouiller `products` avant
  `product_photos` pour éviter les deadlocks. Le trigger
  `guard_product_photo_deletion` (BEFORE UPDATE OR DELETE sur `product_photos`)
  doit également `SELECT ... FOR UPDATE` sur la ligne `products` parent dans sa
  fonction trigger, car les triggers BEFORE ont un verrou sur la ligne
  `product_photos` mais pas sur `products`.

### D. Publication gate

#### D.1 Implémentation PostgreSQL batch

L'implémentation de `PublicProductPublicationGate` est fournie par la classe
`PostgresPhotoPublicationGate` (fichier
`packages/core/src/photos/postgres-publication-gate.ts`, à créer en G7F-A2).

#### D.2 Méthode `filterEligibleProductIds(db, productIds)`

- **Une seule requête SQL** pour N produits (pas de N requêtes).
- Compte les photos valides (`file_state = 'AVAILABLE'`, `deleted_at IS NULL`,
  checksums distincts) par produit.
- Retourne le `Set` des `productIds` avec ≥ 3 photos valides.
- Vérifie la cohérence `organization_id` / `product_id` : un produit ne peut
  pas être éligible pour une autre organisation.

#### D.3 Fail-closed

**Une erreur PostgreSQL doit produire une erreur typée
`PUBLICATION_GATE_UNAVAILABLE`** (ou équivalent). `searchPublicOffers` doit la
convertir en erreur publique nettoyée (sans détail SQL, clé R2, organisation
interne ou nom de table). Ne jamais transformer silencieusement une panne DB en
« aucun résultat » (`Set` vide) — cela masquerait une panne et violerait le
contrat fail-closed. Le `Set` vide est retourné uniquement lorsque la requête
réussit et qu'aucun produit n'est éligible.

- **Aucune implémentation permissive** : pas de `() => true`, pas de fallback.

#### D.4 Batch unique

Un seul appel pour N produits, pas N requêtes. La requête utilise une
agrégation `GROUP BY product_id` avec `COUNT(DISTINCT checksum_sha256)` sur
les photos valides, filtrée par les `productIds` en entrée.

### E. Évolution par catégorie

#### E.1 MVP

3 photos valides minimum, indépendamment de la catégorie. La règle est
uniforme pour toutes les catégories au lancement.

#### E.2 Conception extensible

Une table future `category_photo_requirements` (versionnée) pourra être créée
lorsque les consignes par catégorie seront introduites :

- `category_id` (FK → `categories`)
- `min_photos` (integer)
- `required_views` (jsonb — vues requises, angles, etc.)
- `version` (integer) — version de la règle
- `is_active` (boolean)

Les règles versionnées permettent d'évoluer sans casser les anciennes
publications : un produit publié sous la règle v1 reste valide tant qu'il
satisfait v1. Le publication gate peut charger la règle applicable par
catégorie et l'appliquer.

**Ne pas inventer maintenant de taxonomie rigide de vues** — la conception est
extensible mais le MVP reste 3 photos génériques.

#### E.3 G7F-B / G8B-3B4 / ADR-031

G7F-B/G8B-3B4 traite désormais les consignes/slots vélo, l'UI guidée et le
tutoriel d'upload. Le contrat `BIKE_PHOTO_SLOTS`, la migration `0040`, la
persistance de `slot_type`, le Photo Coach et ses overlays sont livrés. ADR-031
approuve l'évolution limitée au pilote vélo : la catégorie `bike` doit posséder
`HERO_PROFILE`, `THREE_QUARTER_FRONT` et `SECONDARY_VIEW`, en plus des trois
checksums distincts. Les autres catégories restent sur la règle générique du
MVP jusqu'à l'adoption d'une règle dédiée.

### F. Sécurité et limites techniques

#### F.1 Validation MIME réelle

Lire les magic bytes du fichier, pas seulement l'extension. Types autorisés
au MVP : JPEG (`image/jpeg`), PNG (`image/png`), WebP (`image/webp`). Refuser
SVG (peut contenir du JavaScript), GIF animé, BMP, TIFF, HEIC.

#### F.2 Limites techniques — verrouillées pour G7F-A2

Les contraintes structurelles suivantes sont **verrouillées pour G7F-A2** et
implémentées via CHECK constraints au niveau PostgreSQL. Elles pourront être
ajustées par migration future.

- **MIME** : JPEG, PNG, WebP (liste dans CHECK `product_photos_content_type_valid`,
  évolutive via migration).
- **byte_size** : `> 0 AND <= 10485760` (10 MB plafond technique, CHECK
  `product_photos_byte_size_valid`).
- **dimensions** : `200–8000` px (bornes techniques, CHECK
  `product_photos_dimensions_valid`).
- **checksum_sha256** : NOT NULL quand `AVAILABLE` (garanti par
  `product_photos_state_invariants`).

#### F.3 Règles qualité produit — reportées à G7F-B

Les règles suivantes sont **reportées à G7F-B** (qualité produit, pas
structurelles) :

- Qualité minimale (résolution, compression).
- Cadrage et consignes par catégorie.
- Re-encoding EXIF (stripper les métadonnées sensibles via `sharp`/imagor).
- Modération automatique (NSFW, copyright).

Aucune question ouverte ne reste non résolue qui empêcherait d'écrire les CHECK
de G7F-A2. Les valeurs actuelles (10 MB, 200–8000 px, JPEG/PNG/WebP) sont
verrouillées pour G7F-A2.

#### F.3 Checksum SHA-256

Calculé sur le contenu complet du fichier, stocké dans `checksum_sha256`.
Permet la détection de doublons (photos distinctes) et l'intégrité du
contenu.

#### F.4 Noms de fichiers utilisateurs non utilisés comme clés R2

La clé R2 est `product-photos/{organizationId}/{productId}/{photoId}` où
`photoId` est un UUID généré serveur. Le nom de fichier utilisateur est
ignoré et non persisté.

#### F.5 Protection SVG/script et contenu hostile

- Refuser SVG (peut contenir du JavaScript).
- Valider que le `content_type` détecté (magic bytes) correspond au
  `content_type` déclaré.
- Re-encoder les images via `sharp`/imagor (G7F-B) pour stripper les
  métadonnées EXIF sensibles et les payloads cachés.
- Pour le MVP, la validation MIME réelle (magic bytes) aura lieu lors de
  l'upload réel en G7F-B. En G7F-A2, seul l'état `AVAILABLE` (positionné par le
  processus d'upload) est vérifié par la fonction de comptage PostgreSQL. Le
  re-encoding est reporté à G7F-B (voir §F.3).

#### F.6 URLs temporaires/signées

Générées à la demande via l'adapter R2 (presigned URLs), courte durée (ex.
15 minutes — durée exacte reportée à G7F-B). Jamais persistées en base.
Utilisées pour l'affichage dashboard et la livraison publique via CDN
(G7F-B).

#### F.7 Aucune fuite de clé interne ou de bucket

- Les clés R2 ne sont jamais exposées dans le read model public.
- Les URLs publiques passent par un CDN (G7F-B) qui masque le bucket R2.
- Les URLs signées sont courte durée et liées à l'organisation.

## 3. Alternatives étudiées

### 3.1 Stockage binaire dans PostgreSQL

Stockage direct des fichiers en `bytea` dans PostgreSQL.

Avantages :

- Transactionnalité native avec les métadonnées.

Inconvénients :

- Gonflement de la base, impact sur les sauvegardes et la réplication.
- Coût de stockage élevé vs R2.
- Contradiction avec l'adapter R2 existant (ADR-014).

**Rejeté** : R2 est le stockage objet, PostgreSQL ne stocke que les
métadonnées.

### 3.2 URL signée persistée en base

Persistance d'une URL signée dans `product_photos`.

Avantages :

- Lecture directe sans régénération.

Inconvénients :

- Les URLs signées expirent : une URL persistée devient invalide.
- Risque de fuite si l'URL est exposée dans un read model.
- Contradiction avec le principe de courte durée.

**Rejeté** : les URLs signées sont générées à la demande, jamais persistées.

### 3.3 Gate permissif (`() => true`)

Implémentation permissive du publication gate pour débloquer G7E.

Avantages :

- Débloque immédiatement G7E.

Inconvénients :

- Violation directe de l'exigence produit (3 photos minimum).
- `searchPublicOffers` exposerait des produits sans photos.
- Contournement de la sécurité métier.

**Rejeté** : le gate est fail-closed et nécessite une implémentation
PostgreSQL réelle.

### 3.4 Suppression automatique de visibilité

Retrait automatique de la visibilité publique lorsqu'une photo est supprimée
et le compte passe sous 3.

Avantages :

- Pas de blocage pour le loueur.

Inconvénients :

- Crée une incohérence entre l'état métier (`PUBLISHED`) et la visibilité
  publique (invisible).
- Effet de bord silencieux non explicite.
- Violation de l'invariant : un produit `PUBLISHED` doit avoir ≥ 3 photos
  valides.

**Rejeté** : refus de suppression explicite. Le loueur doit archiver le
produit d'abord.

## 4. Conséquences

### Positives

- Exigence produit (3 photos minimum) garantie côté serveur ET PostgreSQL.
- G7E peut exposer `searchPublicOffers` de manière sécurisée après G7F-A2.
- Modèle extensible pour les consignes par catégorie (G7F-B) sans casser le
  MVP.
- Sécurité : validation MIME réelle, checksum, clés R2 opaques, aucune fuite
  de bucket.
- Réutilisation de l'adapter R2 existant (ADR-014, G5H-A).

### Négatives

- G7E ne peut pas exposer `searchPublicOffers` tant que G7F-A2 n'est pas
  terminé.
- Les produits existants sans photos ne pourront pas être (re)publiés.
- Complexité des triggers PostgreSQL (trois triggers + fonction de comptage).
- Nettoyage des orphelins R2 requis (worker périodique — reporté à G7F-B).
- Le re-encoding des images (EXIF stripping) est reporté à G7F-B.

### Rétrocompatibilité

- La migration ne crée aucune photo fictive.
- Le publication gate rend invisibles les produits `PUBLISHED` sans 3 photos
  valides (invisible dans `searchPublicOffers`, mais état métier `PUBLISHED`
  conservé en base).
- Toute **nouvelle transition** vers `PUBLISHED` exige 3 photos (trigger
  `check_product_publication_photos`). L'invariant au niveau PostgreSQL est :
  « toute **transition** vers `PUBLISHED` exige 3 photos ».
- L'invariant au niveau du gate est : « tout produit **visible** dans
  `searchPublicOffers` possède 3 photos valides ». Les produits `PUBLISHED`
  historiques sans photos sont `PUBLISHED` en base mais invisibles
  publiquement.
- Un `UPDATE` d'un produit déjà `PUBLISHED` sans changement de
  `publication_status` reste autorisé (le trigger ne se déclenche que sur
  transition vers `PUBLISHED`).
- Un produit `PUBLISHED` historique sans photos qui est archivé puis
  re-publié devra avoir 3 photos (transition `ARCHIVED` → `PUBLISHED` = nouvelle
  transition).
- Aucune migration rétroactive des produits existants n'est requise par cet
  ADR. Ne pas affirmer simultanément « tout `PUBLISHED` possède 3 photos »
  (FAUX pour les historiques) ET conservation des `PUBLISHED` historiques sans
  photos.

## 5. Questions ouvertes reportées

Les limites techniques (taille, dimensions, formats) sont **verrouillées pour
G7F-A2** (voir §F.2) et pourront être ajustées par migration future. Les
questions suivantes restent ouvertes pour G7F-B et sont tracées dans
`docs/implementation/open-questions.md` :

1. ~~**Limites finales de taille**~~ : **Résolu pour G7F-A2** — `byte_size > 0
   AND <= 10485760` (10 MB). Ajustable par migration future.
2. ~~**Limites finales de dimensions**~~ : **Résolu pour G7F-A2** —
   `200–8000` px. Ajustable par migration future.
3. ~~**Formats autorisés**~~ : **Résolu pour G7F-A2** — JPEG, PNG, WebP
   uniquement. HEIC/AVIF et confirmation finale des formats restent ouverts
   pour G7F-B.
4. **Modération automatique** : détection de contenu inapproprié (NSFW,
   copyright) ? Manuelle pour le MVP ? — reporté à G7F-B.
5. **Règles précises par catégorie** : nombre minimum par catégorie, vues
   requises, angles — reporté à G7F-B.
6. **Durée de conservation des objets supprimés** : 30 jours ? 90 jours ?
   Suppression immédiate après confirmation ? — reporté à G7F-B (avec le
   consumer worker `photo_object_cleanup`).
7. ~~**Re-encoding des images**~~ : **Résolu** — reporté à G7F-B avec
   `sharp`/imagor (voir §F.3).
8. **URLs signées : durée exacte** : 15 minutes ? 1 heure ? Configurable par
   usage (dashboard vs public) ? — reporté à G7F-B.

## 6. Références factuelles

- Interface `PublicProductPublicationGate` :
  `packages/core/src/public-search/types.ts:157-162`.
- Usage dans `searchPublicOffers` :
  `packages/core/src/public-search/search-offers.ts:170-177`.
- `publishProduct` : `packages/core/src/catalog/products.ts:293-342`.
- `collectPublicationFailures` :
  `packages/core/src/catalog/products.ts:242-282`.
- Adapter R2 : `apps/worker/src/adapters/r2-object-storage.ts` (607 lignes,
  G5H-A).
- Enum `product_publication_status` : `packages/database/src/schema.ts`.
- Migrations 0031-0033 : `packages/database/drizzle/`.
- ADR-014 §2.4 : stockage objet R2, Q9 URLs signées ouverte.
- ADR-017 §5 : réserves différées sur les images publiques (CDN/vendor,
  limites finales, politique d'upload).
- Exigence produit : `docs/product/lot7-arbitrage.md`.
