# ADR-009 — Brouillon de réservation, prix, idempotence et holds

- **Statut** : Accepté (périmètre Lot 4 technique)
- **Date** : 2026-07-28
- **Décisions produit** : approuvées par délégation du porteur produit (voir `docs/product/lot4-arbitrage.md`)
- **Validations juridique/finance** : la validation juridique des politiques d'annulation est reportée au Lot 5 / activation en production (voir section « Périmètre d'acceptation »)

## 1. Contexte

Le Lot 4 prépare une réservation fiable avant paiement. Il s'appuie sur l'ADR-003 (allocation immédiate et hold temporaire) et l'ADR-005 (Vercel + Neon). PostgreSQL + PostGIS reste l'autorité transactionnelle. La contrainte d'exclusion `no_overlapping_blocks` sur `inventory_blocks` (migration 0017) protège déjà contre le chevauchement des blocs `ACTIVE` et `PAYMENT_PROCESSING`.

Le brouillon de réservation (`booking_drafts`) est l'entité centrale du Lot 4 : il capture la période client, les marges opérationnelles, le prix calculé, la politique d'annulation, et déclenche l'allocation atomique des exemplaires avec création de holds. L'idempotence garantit qu'une requête répétée ne crée jamais un doublon. Un worker expire les holds abandonnés.

Ce lot ne couvre pas la confirmation de réservation, le paiement, ni la caution (Lot 5).

## 1b. Périmètre d'acceptation

L'acceptation de cet ADR couvre **uniquement le Lot 4 technique** : création du modèle de données, calcul du prix et des jours civils, idempotence persistée, création atomique brouillon + lignes + allocations + holds, et expiration par batch.

**Ce que l'acceptation n'autorise pas** :

- Aucune échéance de remboursement n'est exécutée au Lot 4.
- Aucune base remboursable n'est calculée.
- Aucune API d'annulation ou de remboursement.
- Aucune politique d'annulation n'est présentée comme juridiquement validée.
- La confirmation de réservation reste impossible puisque taxes et commission sont encore indéterminées.

**Garde-fous au Lot 4** :

- `cancellation_policy_snapshot` conserve seulement `policy_code`, `policy_version` et `timezone`.
- Aucun calcul de remboursement, aucune base remboursable.
- Aucune API d'annulation ou de remboursement.
- Aucune politique présentée comme juridiquement validée.
- La confirmation reste impossible (taxes et commission indéterminées).

**Verrou juridique déplacé** :

La validation juridique des politiques d'annulation (voir `docs/product/lot4-legal-validation.md`) ne bloque plus l'implémentation technique du Lot 4. Elle bloque désormais :

- l'activation des politiques d'annulation en production ;
- tout calcul de remboursement ;
- la confirmation et le paiement du Lot 5 ;
- le passage public du MVP.

C'est cohérent avec le Lot 4 : il crée un prix, un brouillon, des allocations et des holds, mais n'annule ni ne rembourse aucune réservation.

## 2. Décisions produit applicables

Les décisions produit ont été rendues par délégation du porteur produit et sont documentées dans `docs/product/lot4-arbitrage.md`. Résumé :

1. **Annulation** : trois politiques prédéfinies (Flexible par défaut, Modérée, Ferme), fenêtre commerciale 24h après confirmation si retrait ≥ 7 jours, fuseau IANA du lieu, snapshot de politique.
2. **Prix TTC transparent** : `total_amount_minor` non nullable, `tax_status = UNDETERMINED` au Lot 4, champs fiscaux nullable, commission nullable (`null = UNDETERMINED`, `0 = non applicable`).
3. **Jours civils** : facturation par date civile locale du lieu de retrait, intervalle semi-ouvert, minimum 1 jour.
4. **Devise** : EUR uniquement, stockée dans le snapshot, incohérence refusée.
5. **Conditions réservables** : `NEW`, `GOOD`, `FAIR` (`POOR`, `BROKEN` exclus), `status = ACTIVE` indépendant.
6. **Authentification obligatoire** : `customer_user_id` non nullable, pas de checkout invité.
7. **Hold 10 min, marges 30 min** : snapshot des marges dans le brouillon, `blocked_period` dérivée, `no_overlapping_blocks` = autorité ultime.
8. **Cutoff strict** : `ACTIVE → PAYMENT_PROCESSING` atomique avant `expires_at`, `ACTIVE` expiré jamais convertible, `PAYMENT_PROCESSING` exclu du batch normal, réconciliation dédiée, compensation idempotente.
9. **Montants** : PostgreSQL `bigint`, Drizzle `bigint({ mode: "number" })`, TypeScript `number`, `Number.isSafeInteger` aux frontières.

**Réserves** : La conformité juridique des politiques d'annulation, la définition de la base remboursable, la décomposition fiscale, la commission et la compensation des paiements tardifs restent à valider (juridique/finance, Lot 5).

## 3. Portée Lot 4 et éléments reportés au Lot 5

### Inclus au Lot 4

- Tables `booking_drafts`, `booking_draft_lines`, `allocations`.
- Calcul des jours civils et du prix.
- Snapshot de prix et de politique d'annulation.
- Allocation atomique des exemplaires avec création de holds.
- Idempotence par clé et empreinte canonique.
- Worker d'expiration des holds (Vercel Cron).
- Le batch normal d'expiration n'expire JAMAIS un hold `PAYMENT_PROCESSING` (exclusion par le `WHERE` du batch).

### Reporté au Lot 5

- Confirmation de réservation (`Booking`, `BookingLine`).
- Paiement (`Payment`, `PaymentAttempt`, `PaymentWebhook`).
- Gestion de `PAYMENT_PROCESSING` (transition, réconciliation, compensation).
- Décomposition fiscale (`tax_status = APPLIED`).
- Commission appliquée.
- Caution (`Deposit`).
- Mécanique exacte du remboursement / compensation.
- Contrat et documents transactionnels.

## 4. Modèle booking_drafts

```text
booking_drafts
- id UUID PK
- organization_id UUID NOT NULL FK
- location_id UUID NOT NULL FK
- customer_user_id UUID NOT NULL FK
- status booking_draft_status NOT NULL DEFAULT 'DRAFT'
- customer_start_at timestamptz NOT NULL
- customer_end_at timestamptz NOT NULL
- blocked_start_at timestamptz NOT NULL
- blocked_end_at timestamptz NOT NULL
- timezone text NOT NULL              -- snapshot IANA du lieu
- prep_buffer_minutes integer NOT NULL -- snapshot
- cleanup_buffer_minutes integer NOT NULL -- snapshot
- currency text NOT NULL DEFAULT 'EUR'
- subtotal_amount_minor bigint NOT NULL
- mandatory_fees_amount_minor bigint NOT NULL DEFAULT 0
- total_amount_minor bigint NOT NULL   -- non nullable, prix public TTC
- tax_status tax_status NOT NULL DEFAULT 'UNDETERMINED'
- tax_amount_minor bigint              -- nullable
- tax_rate_bps integer                 -- nullable
- commission_amount_minor bigint       -- nullable (null = UNDETERMINED)
- billable_unit text NOT NULL DEFAULT 'DAY'
- billable_unit_count integer NOT NULL
- cancellation_policy_snapshot jsonb NOT NULL
- expires_at timestamptz               -- nullable, défini au passage HELD
- created_at timestamptz NOT NULL DEFAULT now()
- updated_at timestamptz NOT NULL DEFAULT now()
```

**Enum `booking_draft_status`** : `DRAFT`, `HELD`, `PAYMENT_PROCESSING`, `EXPIRED`, `CANCELLED`, `CONVERTED`.

**Enum `tax_status`** : `UNDETERMINED`, `NOT_APPLICABLE`, `APPLIED`.

**Snapshot de politique d'annulation** (`jsonb`) : `policy_code`, `policy_version`, `timezone`. Les échéances absolues calculées, `confirmed_at` et la fenêtre commerciale sont ajoutées au snapshot de réservation confirmée (Lot 5).

**Source de la politique d'annulation** : `organizations.default_cancellation_policy_code` (niveau organisation, pas variante). Valeur par défaut : `FLEXIBLE`. Choix parmi `FLEXIBLE | MODERATE | FIRM`. Les définitions des politiques (bornes, pourcentages, version) sont versionnées côté domaine. Au moment du brouillon, le snapshot copie `policy_code`, `policy_version` et le fuseau IANA du lieu (`timezone`). Aucune politique par variante au MVP.

**Contraintes** :

- `customer_end_at > customer_start_at` (intervalle strictement positif).
- `blocked_start_at <= customer_start_at` et `blocked_end_at >= customer_end_at` (la période bloquée englobe la période client).
- `total_amount_minor >= 0`, `subtotal_amount_minor >= 0`, `mandatory_fees_amount_minor >= 0`.
- `total_amount_minor <= 9007199254740991` (Number.MAX_SAFE_INTEGER).
- `currency = 'EUR'` au MVP (contrainte applicative).
- `tax_amount_minor IS NULL WHEN tax_status = 'UNDETERMINED'`.
- `tax_amount_minor = 0 WHEN tax_status = 'NOT_APPLICABLE'`.
- `tax_amount_minor IS NOT NULL WHEN tax_status = 'APPLIED'`.

## 5. Modèle booking_draft_lines

```text
booking_draft_lines
- id UUID PK
- draft_id UUID NOT NULL FK → booking_drafts
- variant_id UUID NOT NULL FK → product_variants
- quantity integer NOT NULL
- unit_price_amount_minor bigint NOT NULL
- billable_unit_count integer NOT NULL
- line_total_amount_minor bigint NOT NULL
- currency text NOT NULL DEFAULT 'EUR'
- variant_snapshot jsonb NOT NULL      -- snapshot descriptif minimal
- created_at timestamptz NOT NULL DEFAULT now()
```

**`variant_snapshot`** : nom du produit, nom de la variante, `sku_suffix` de la variante, attributs visibles au client. `internal_sku` est sur l'exemplaire (`inventory_items`), pas la variante. Suffixe pour comprendre le prix historique sans rejoindre le catalogue (qui peut évoluer).

**Contraintes** :

- `quantity > 0`, `billable_unit_count > 0`.
- `unit_price_amount_minor >= 0`, `line_total_amount_minor >= 0`.
- `line_total_amount_minor = unit_price_amount_minor * billable_unit_count * quantity` (vérifié en application).
- `currency = 'EUR'` au MVP.
- Tous les montants `<= Number.MAX_SAFE_INTEGER`.

## 5b. Source de prix au catalogue

L'ADR calcule un prix à partir d'une source catalogue. `booking_draft_lines.unit_price_amount_minor` est un snapshot figé, pas une source. La source de prix au MVP est modélisée par des colonnes ajoutées sur `product_variants` plutôt que par une table de tarifs dédiée (post-MVP).

```text
product_variants (colonnes ajoutées)
- daily_price_amount_minor bigint   -- nullable : prix par jour civil
- currency text NOT NULL DEFAULT 'EUR'
```

**Contraintes** :

- `daily_price_amount_minor > 0` lorsque renseigné (contrainte applicative, nullable).
- `daily_price_amount_minor <= 9007199254740991` (Number.MAX_SAFE_INTEGER).
- `currency = 'EUR'` au MVP (contrainte applicative).

**Réservabilité** : Une location gratuite est interdite au MVP : `daily_price_amount_minor > 0` lorsque renseigné. Une variante avec `daily_price_amount_minor IS NULL` n'est pas réservable (le loueur doit configurer le prix avant la mise en location).

**Procédure pour les variantes existantes** : après migration, toutes les variantes ont `daily_price_amount_minor = NULL` et ne sont donc pas réservables. Le loueur doit renseigner le prix via une mutation serveur (Server Action) avant qu'une variante soit réservable. L'impact sur la disponibilité : une variante dont le produit n'est pas `PUBLISHED` ou dont `is_active` est faux ou dont `daily_price_amount_minor IS NULL` n'apparaît pas dans la disponibilité.

**Mutation serveur du prix** : la mise à jour de `daily_price_amount_minor` est une Server Action autorisée côté serveur (rôle loueur/admin). Un changement de prix n'affecte pas les brouillons existants (snapshot figé).

**Règle de changement de prix** : le loueur peut modifier le prix (`daily_price_amount_minor`) à tout moment. Un brouillon existant conserve son snapshot : le prix est figé dans `booking_draft_lines.unit_price_amount_minor` au moment de la création du brouillon. La modification du catalogue n'affecte pas un brouillon existant.

**Post-MVP** : tarifs saisonniers, paliers (demi-journée, semaine), tarification horaire — via une table de tarifs dédiée. Aucune table de tarifs dédiée au MVP.

**Relation avec `booking_draft_lines`** : `unit_price_amount_minor` sur `booking_draft_lines` est un snapshot figé du `daily_price_amount_minor` de la variante au moment de la création du brouillon. Il n'est jamais recalculé après création.

## 6. Modèle allocations

```text
allocations
- id UUID PK
- draft_line_id UUID NOT NULL FK → booking_draft_lines
- inventory_block_id UUID NOT NULL FK → inventory_blocks
- status allocation_status NOT NULL DEFAULT 'ALLOCATED'
- created_at timestamptz NOT NULL DEFAULT now()
```

**Enum `allocation_status`** : `ALLOCATED`, `RELEASED`, `CONVERTED`.

L'exemplaire alloué est dérivé de `inventory_blocks.inventory_item_id`. `allocations` ne porte pas `inventory_item_id` directement pour garantir l'égalité avec le bloc.

**Contraintes uniques** :

- `UNIQUE (draft_line_id, inventory_block_id)` : un même bloc ne peut pas être alloué deux fois à la même ligne.
- `UNIQUE (inventory_block_id)` : une allocation référence exactement un bloc (pas d'allocation sans bloc).
- `inventory_block_id` est NOT NULL : pas d'allocation sans bloc correspondant.

**Contrainte applicative** : un même exemplaire ne peut pas être alloué à deux lignes différentes du même brouillon (vérifié en transaction lors de la création, via la jointure `inventory_blocks.inventory_item_id`).

**Cohérence** : une allocation ne peut exister que si le brouillon est `HELD` et le bloc est `ACTIVE` de type `HOLD`. La libération du hold (`RELEASED` ou `EXPIRED`) libère simultanément l'allocation.

## 7. Articulation avec inventory_blocks

Chaque allocation crée un `inventory_block` de type `HOLD` et de statut `ACTIVE`. Le bloc porte :

- `customer_start_at` / `customer_end_at` : période client (du brouillon).
- `blocked_start_at` / `blocked_end_at` : période bloquée (dérivée des marges figées).
- `expires_at` : échéance commune calculée une fois pour tout le brouillon avec l'horloge PostgreSQL : `draft_expires_at = transaction_timestamp() + interval '10 minutes'`. Cette valeur est copiée dans `booking_drafts.expires_at` ET dans chaque `inventory_blocks.expires_at` du brouillon. Tous les blocs d'un même brouillon partagent exactement la même échéance.
- `source_id` : `draft_id`.
- `organization_id` : du brouillon.

La contrainte `no_overlapping_blocks` (EXCLUDE USING gist) empêche le chevauchement de deux blocs `ACTIVE` ou `PAYMENT_PROCESSING` sur le même `inventory_item_id`. C'est la dernière ligne de défense contre la double allocation.

**Transitions cohérentes** :

- Brouillon `HELD` → bloc `ACTIVE`.
- Brouillon `PAYMENT_PROCESSING` → bloc `PAYMENT_PROCESSING`.
- Brouillon `EXPIRED` → bloc `EXPIRED` + allocation `RELEASED`.
- Brouillon `CANCELLED` → bloc `RELEASED` + allocation `RELEASED`.
- Brouillon `CONVERTED` (Lot 5) → bloc `CONVERTED` + allocation `CONVERTED`.

## 8. Snapshot de prix

Le snapshot de prix est figé dans le brouillon au moment de la création. Il comprend :

- `subtotal_amount_minor` : somme des `line_total_amount_minor`.
- `mandatory_fees_amount_minor` : frais obligatoires (0 au Lot 4).
- `total_amount_minor` : `subtotal + mandatory_fees` (prix public TTC, non nullable).
- `currency` : EUR.
- `tax_status` : `UNDETERMINED` au Lot 4.
- `tax_amount_minor` : `null` au Lot 4.
- `tax_rate_bps` : `null` au Lot 4.
- `commission_amount_minor` : `null` au Lot 4 (UNDETERMINED).
- `cancellation_policy_snapshot` : politique applicable figée.

Le snapshot de politique d'annulation au Lot 4 fige uniquement la définition et la version de la politique (`policy_code`, `policy_version`, `timezone`). Le snapshot de réservation confirmée (Lot 5) ajoutera `confirmed_at`, la fenêtre commerciale et les échéances absolues calculées.

**Immuable après création** : les champs monétaires et le snapshot de politique ne sont jamais modifiés après la création du brouillon. Une modification du catalogue ou du lieu ne affecte pas un brouillon existant.

**Invariant** : Le snapshot intégral (domain-invariants.md) concerne la réservation CONFIRMÉE (Lot 5). Au Lot 4, le brouillon porte déjà la structure complète, mais `tax_status = UNDETERMINED` et `commission = null` sont acceptés. La confirmation (Lot 5) exigera `tax_status != UNDETERMINED` et `commission IS NOT NULL`.

## 9. Calcul des jours civils

**Définition** : `customer_period` est un intervalle semi-ouvert `[customer_start_at, customer_end_at)`. Une unité est facturée pour chaque date civile locale intersectée par cet intervalle. La date locale correspondant exactement à la borne de fin exclue n'est pas facturée. Minimum : 1 jour.

**Algorithme** :

1. Convertir `customer_start_at` et `customer_end_at` (UTC) en dates civiles locales dans le fuseau IANA du lieu.
2. Si `start_local_date == end_local_date` : 1 jour (même si l'heure de fin est après l'heure de début).
3. Si `end_local_datetime` correspond exactement à minuit local (`00:00:00`) : la date de fin n'est pas comptée (intervalle semi-ouvert).
4. Sinon : `billable_unit_count = nombre de dates civiles distinctes entre start_local_date (inclus) et end_local_date (exclus si fin à minuit, inclus sinon)`.

**Exemples** (fuseau Europe/Paris) :

- 10h à 18h le 15 juin : 1 jour.
- 10h le 15 juin à 14h le 16 juin : 2 jours.
- 10h le 15 juin à 00h00 le 16 juin : 1 jour (borne de fin exclue).
- Passage à l'heure d'été (31 mars, jour à 23h) : 1 jour civil, pas 0,97 jour.
- `start >= end` : refusé (intervalle invalide).

**Stockage** : `billable_unit = 'DAY'`, `billable_unit_count` sur le brouillon et chaque ligne.

## 10. Modèle monétaire bigint/number

**Décision** :

- PostgreSQL : `bigint` (int8).
- Drizzle : `bigint({ mode: "number" })`.
- TypeScript et JSON : `number`.
- `Number.isSafeInteger` obligatoire aux frontières (API, sérialisation).
- Montants non négatifs.
- Contrainte : `amount_minor <= 9007199254740991` (Number.MAX_SAFE_INTEGER).
- Addition et multiplication vérifiées (overflow check).
- Aucune arithmétique flottante.
- Aucune conversion silencieuse depuis `bigint` JavaScript.
- Devise ISO 4217 explicite sur chaque montant.

**Note** : PostgreSQL `bigint` ne devient pas automatiquement `bigint` JavaScript. Le mode Drizzle `mode: "number"` est explicite : Drizzle convertit le `bigint` PostgreSQL en `number` JavaScript à la lecture. `JSON.stringify` lève une `TypeError` sur les `bigint` JavaScript ; c'est pourquoi le mode `number` est utilisé, avec `Number.isSafeInteger` aux frontières.

**Bornes métier** : Une location d'équipement ne dépassera jamais `Number.MAX_SAFE_INTEGER` centimes (~90 billions €). La contrainte SQL garantit la cohérence.

## 11. Idempotence

**Portée de la clé** : Une clé d'idempotence est fournie par le client (header `Idempotency-Key`). La clé est unique par `(organization_id, operation, key)` via la table `idempotency_records` (section 11b). La clé identifie une intention de création de brouillon.

**Contrainte unique** : `UNIQUE (organization_id, operation, key)` sur `idempotency_records` (section 11b).

**Empreinte SHA-256** : L'empreinte est calculée sur le payload métier canonique et versionné. Elle garantit que la même clé avec un payload différent est détectée comme un conflit.

**Payload métier canonique** :

- Version du schéma de payload (ex: `"v1"`).
- `organization_id`, `location_id`, `customer_user_id`.
- `customer_start_at`, `customer_end_at` (normalisés en UTC ISO 8601).
- Lignes triées par `variant_id` (ordre déterministe).
- Quantités.
- Exclusion des champs non sémantiques (timestamps client, identifiants de session, etc.).

**Normalisation** :

- Dates : UTC ISO 8601 avec `Z`.
- Ordre des champs : trié alphabétiquement.
- Tableaux : triés par clé déterministe (`variant_id`).
- Distinction champs absents et `null` : un champ absent n'est pas dans l'empreinte ; un champ `null` est représenté explicitement.
- Encodage : UTF-8, JSON canonique (pas d'espaces, pas de retours).

**Contrat** :

- **Même clé + même empreinte** : retourner exactement le résultat de création persisté, sans doublon.
- **Même clé + empreinte différente** : erreur de conflit explicite (409).
- **Deux requêtes concurrentes identiques** : une seule création (l'autre attend le verrou et retourne le résultat persisté).
- **Distinction** : la réponse de création persistée (POST) est distinguée de la représentation courante accessible par GET (qui peut avoir évolué).

## 11b. Modèle idempotency_records

L'idempotence est persistée dans une table dédiée `idempotency_records`. Aucun champ `idempotency_key` n'est ajouté sur `booking_drafts`.

```text
idempotency_records
- id UUID PK
- organization_id UUID NOT NULL
- operation text NOT NULL          -- ex: 'create_booking_draft'
- key text NOT NULL                -- clé fournie par le client
- request_fingerprint text NOT NULL -- SHA-256 hex
- status text NOT NULL              -- 'PENDING', 'COMPLETED', 'FAILED'
- resource_id UUID                  -- booking_drafts.id si réussi
- response_status_code integer      -- ex: 201
- response_body jsonb               -- réponse de création persistée
- created_at timestamptz NOT NULL DEFAULT now()
- completed_at timestamptz
- pending_timeout_at timestamptz    -- pour les PENDING : seuil d'abandon
```

**Contrainte unique** : `UNIQUE (organization_id, operation, key)`.

**Portée** : `(organization_id, operation, key)`. La clé est scoped par organisation et par type d'opération.

**Comportement échec** : `status = 'FAILED'` avec réponse persistée. Une nouvelle requête avec même clé + même empreinte retourne l'erreur persistée.

**Comportement succès** : `status = 'COMPLETED'` avec `resource_id`, `response_status_code` et `response_body` persistés. Une nouvelle requête avec même clé + même empreinte retourne exactement la réponse persistée, sans doublon.

**Rétention et TTL** : Le TTL de 24h est retiré ; il est remplacé par deux durées distinctes :

- `pending_timeout` : durée après laquelle un `PENDING` est considéré abandonné (ex: 5 minutes). Stocké dans `pending_timeout_at`.
- `retention` : Les clés `COMPLETED` ne doivent PAS être purgées au MVP. Une rétention limitée (ex: 90 jours) permettrait une deuxième création avec la même clé, violant l'invariant « aucun doublon ». Au MVP, les enregistrements `COMPLETED` sont conservés indéfiniment. Une procédure de purge post-MVP nécessitera une décision explicite sur la durée de vie métier et la garantie de non-doublon.

### Protocole d'exécution

- **Étape 1** : Réserver et committer la clé en `PENDING` (transaction séparée, courte). `INSERT INTO idempotency_records (organization_id, operation, key, request_fingerprint, status, created_at, pending_timeout_at) VALUES (...) ON CONFLICT (organization_id, operation, key) DO NOTHING RETURNING *`. Si `ON CONFLICT` ne retourne rien, un enregistrement existe déjà : lire et retourner sa réponse (si `COMPLETED`) ou attendre/gérer (si `PENDING`).
- **Étape 2** : Verrouiller cette ligne `PENDING` pendant la transaction de création (`SELECT ... FOR UPDATE`).
- **Étape 3** : Terminer atomiquement en `COMPLETED` avec `resource_id`, `response_status_code`, `response_body` dans la même transaction que la création du brouillon.
- **Étape 4** : En cas d'échec de la création, écrire `FAILED` avec la réponse d'erreur. Les erreurs métier prévues (validation, inventaire insuffisant, conflit) sont capturées dans un SAVEPOINT de la transaction externe qui conserve le verrou sur l'enregistrement `PENDING`. Le savepoint est annulé (`ROLLBACK TO SAVEPOINT`), puis l'enregistrement est mis à jour en `FAILED` avec la réponse d'erreur, et la transaction externe est committée. Le verrou sur la ligne `PENDING` est conservé pendant toute l'opération, empêchant toute course concurrente. Une panne ou erreur SQL non récupérable laisse l'enregistrement `PENDING`. Aucune écriture `FAILED` après rollback de la transaction principale. Une autre requête concurrente avec la même clé trouve l'enregistrement `PENDING` et attend (ou retourne une réponse 409 si l'enregistrement est `PENDING` depuis trop longtemps).
- **Étape 5** : Récupération d'un `PENDING` abandonné : un enregistrement `PENDING` dont `pending_timeout_at` est dépassé est considéré abandonné. La reprise respecte la règle centrale « même clé + empreinte différente = 409 » :
  1. Comparer l'empreinte entrante avec `request_fingerprint` avant tout traitement, quel que soit le statut. Si elle diffère : `409 IDEMPOTENCY_KEY_REUSED`. `request_fingerprint` n'est JAMAIS modifié.
  2. Si l'empreinte est identique et le `PENDING` est expiré (`pending_timeout_at < now()`), renouveler uniquement `pending_timeout_at` via une mise à jour conditionnelle :
     ```sql
     UPDATE idempotency_records
     SET pending_timeout_at = now() + interval '5 minutes'
     WHERE id = $id
       AND status = 'PENDING'
       AND request_fingerprint = $incoming_fingerprint
       AND pending_timeout_at < now()
     RETURNING *;
     ```
     Si la mise à jour retourne 0 ligne, une autre requête a déjà repris la clé ou le statut a changé.
  3. Après acquisition du verrou, revérifier le statut : si une autre requête a terminé en `COMPLETED` ou `FAILED` entre-temps, retourner sa réponse persistée (étape 1 du protocole).

## 12. Empreinte canonique de requête

L'empreinte est `SHA-256(payload_canonique_json)` en hexadécimal. Le payload canonique est construit comme suit :

```text
{
  "v": "v1",
  "organization_id": "uuid",
  "location_id": "uuid",
  "customer_user_id": "uuid",
  "customer_start_at": "2026-08-01T10:00:00Z",
  "customer_end_at": "2026-08-03T18:00:00Z",
  "lines": [
    { "variant_id": "uuid", "quantity": 2 }
  ]
}
```

Les champs monétaires ne sont pas dans l'empreinte (ils sont calculés server-side). Les champs non sémantiques (User-Agent, IP, session) sont exclus.

## 13. Allocation transactionnelle

Toute création réussie effectue dans une **seule transaction PostgreSQL** :

1. Création ou récupération idempotente (verrou sur la clé).
2. Validation mono-loueur (toutes les lignes appartiennent à la même organisation).
3. Validation devise (EUR au MVP).
4. Calcul du prix (jours civils, prix unitaires, total).
5. Sélection des exemplaires éligibles (`condition IN ('NEW','GOOD','FAIR')`, `status = 'ACTIVE'`, rattachés au lieu, sans bloc incompatible sur `blocked_period`).
6. Verrouillage des exemplaires (`SELECT ... FOR UPDATE SKIP LOCKED` sur `inventory_items` ou via la contrainte d'exclusion).
7. Création du brouillon `HELD` avec l'échéance commune (`expires_at = draft_expires_at` où `draft_expires_at` est calculé une fois au début de la transaction via `transaction_timestamp() + interval '10 minutes'`).
8. Création des lignes.
9. Création des `inventory_blocks` de type `HOLD` (statut `ACTIVE`, `expires_at = draft_expires_at`, `source_id = draft_id`).
10. Création des allocations (référence les lignes et les blocs créés aux étapes 8 et 9).
11. Persistance du snapshot (prix, politique, marges, timezone).
12. Résultat idempotent (retour du brouillon persisté).

**En cas d'inventaire insuffisant** : la transaction est annulée (ROLLBACK). Aucune création partielle ne subsiste. Le client reçoit une erreur explicite.

**Sélection déterministe** : Les exemplaires sont sélectionnés par ordre déterministe (ex: `ORDER BY internal_sku`) pour garantir la reproductibilité. `FOR UPDATE SKIP LOCKED` évite les blocages entre requêtes concurrentes. La contrainte `no_overlapping_blocks` est la dernière ligne de défense : si deux transactions tentent d'allouer le même exemplaire, l'une réussit et l'autre échoue sur la contrainte d'exclusion.

## 14. Contrainte de non-chevauchement

La contrainte existante `no_overlapping_blocks` (migration 0017) s'applique aux statuts `ACTIVE` et `PAYMENT_PROCESSING` :

```sql
EXCLUDE USING gist (
  "inventory_item_id" WITH =,
  tstzrange("blocked_start_at", "blocked_end_at") WITH &&
)
WHERE ("status" IN ('ACTIVE', 'PAYMENT_PROCESSING') AND "deleted_at" IS NULL);
```

Cette contrainte protège contre la double allocation même en cas de concurrence. Les blocs `RELEASED`, `EXPIRED`, `CONVERTED` et soft-deleted sont exclus.

**Nouvelles contraintes** :

- `UNIQUE (draft_line_id, inventory_block_id)` sur `allocations`.
- `UNIQUE (inventory_block_id)` sur `allocations`.
- `booking_drafts.customer_end_at > customer_start_at`.
- `booking_drafts.blocked_start_at <= customer_start_at AND blocked_end_at >= customer_end_at`.
- Montants `>= 0` et `<= Number.MAX_SAFE_INTEGER`.
- `currency = 'EUR'` au MVP (contrainte applicative).

## 15. Expiration batch

Le worker d'expiration libère les brouillons `HELD` expirés. Le batch sélectionne les **brouillons expirables**, pas les holds individuels. Un brouillon n'est expiré que si tous ses blocs peuvent être libérés atomiquement. Un brouillon dont un bloc est `PAYMENT_PROCESSING` est exclu du batch.

**Transaction unique par batch** : la sélection, le verrouillage et la mise à jour de tous les brouillons candidats se font dans UNE SEULE transaction PostgreSQL. Le batch est borné (ex: 10 brouillons) pour garder la transaction courte.

```sql
BEGIN;
SELECT bd.id, bd.expires_at
FROM booking_drafts bd
WHERE bd.status = 'HELD'
  AND bd.expires_at < now()
  AND NOT EXISTS (
    SELECT 1 FROM inventory_blocks ib
    WHERE ib.source_id = bd.id
      AND ib.type = 'HOLD'
      AND ib.status = 'PAYMENT_PROCESSING'
      AND ib.deleted_at IS NULL
  )
ORDER BY bd.expires_at
LIMIT $batch_limit
FOR UPDATE OF bd SKIP LOCKED;

-- Pour chaque brouillon sélectionné (dans la même transaction) :
-- 1. Verrouiller tous ses blocs : SELECT ... FROM inventory_blocks WHERE source_id = bd.id FOR UPDATE
-- 2. Verrouiller toutes ses allocations : SELECT ... FROM allocations ... FOR UPDATE
-- 3. Validation d'invariants (voir ci-dessous)
-- 4. Transition : blocs → EXPIRED, allocations → RELEASED, brouillon → EXPIRED
COMMIT;
```

Les verrous `FOR UPDATE` sur les brouillons survivent jusqu'au COMMIT de la transaction de batch. Les blocs et allocations sont verrouillés dans la même transaction. Aucune transaction séparée par brouillon.

**Validation d'invariants obligatoire** : Après verrouillage du brouillon, de tous ses blocs et allocations, et avant toute transition, le batch vérifie les invariants suivants :

- Le brouillon est `HELD`.
- Tous les holds attendus sont présents et `ACTIVE` (type `HOLD`, statut `ACTIVE`).
- Toutes les allocations sont `ALLOCATED`.
- L'échéance de chaque bloc est identique à `booking_drafts.expires_at`.
- Aucun bloc n'est `PAYMENT_PROCESSING`, `CONVERTED`, `RELEASED` ou `EXPIRED`.

Si l'un de ces invariants est rompu, le batch ne modifie RIEN pour ce brouillon et remonte une anomalie opérationnelle (log + métrique). Le brouillon est laissé dans son état actuel pour investigation manuelle. La transition `EXPIRED` n'est appliquée que si tous les invariants sont satisfaits.

**Ordre de verrouillage** : le worker et le futur paiement (Lot 5) doivent verrouiller la même racine dans le même ordre : **brouillon d'abord, puis tous ses blocs et allocations**. Le contrat Lot 5 doit spécifier ce même ordre pour éviter les deadlocks. Le verrouillage d'un hold individuel sans verrouiller le brouillon parent est interdit.

**Exclusion** : Les holds `PAYMENT_PROCESSING` ne sont JAMAIS inclus dans ce batch. Un brouillon dont au moins un bloc est `PAYMENT_PROCESSING` est exclu du batch.

**Index** : Index partiel sur `inventory_blocks (expires_at) WHERE type = 'HOLD' AND status = 'ACTIVE' AND deleted_at IS NULL` pour optimiser la sélection. Index sur `booking_drafts (expires_at) WHERE status = 'HELD'` pour la sélection des brouillons expirables.

**Idempotence** : Le batch est répétable. Si le worker est interrompu, la prochaine invocation reprend les brouillons non encore expirés. `SKIP LOCKED` garantit que deux invocations simultanées ne traitent pas les mêmes brouillons.

## 16. PAYMENT_PROCESSING — contrat futur (Lot 5)

Au Lot 4, aucune table de paiement n'existe. La transition `ACTIVE → PAYMENT_PROCESSING`, la réconciliation et la compensation sont des contrats spécifiés pour le Lot 5. Le Lot 4 garantit uniquement que le batch normal n'expire jamais un hold `PAYMENT_PROCESSING` (exclusion par le `WHERE`). Un hold ne peut pas passer à `PAYMENT_PROCESSING` au Lot 4 car aucune initiation de paiement n'existe.

**Contrat futur (Lot 5)** :

- **Transition** : `ACTIVE → PAYMENT_PROCESSING` doit être atomique et avoir lieu AVANT `expires_at`. L'initiation de paiement et le webhook prennent le verrou sur le brouillon racine, puis sur tous ses holds dans un ordre stable, dans la même transaction. Si `expires_at` est déjà dépassé au moment de la prise de verrou, la transition est refusée.
- **Ordre de verrouillage** : L'ordre de verrouillage est identique à celui du worker d'expiration (section 15) : brouillon d'abord, puis tous ses blocs, puis allocations. Aucun verrou de hold individuel sans le brouillon parent. Concrètement :
  1. Verrou du brouillon racine d'abord (`SELECT ... FOR UPDATE` sur `booking_drafts`).
  2. Verrou de tous ses holds dans un ordre stable (ex: `ORDER BY inventory_blocks.id`) dans la même transaction.
  3. Mise à jour atomique du brouillon et de tous ses holds.
  4. Aucun `PAYMENT_PROCESSING` partiel sur un brouillon multi-exemplaires : la transition `ACTIVE → PAYMENT_PROCESSING` s'applique à TOUS les blocs du brouillon simultanément, ou à aucun.
- **Exclusion du batch normal** : Les holds `PAYMENT_PROCESSING` sont exclus du batch d'expiration (section 15). Ils suivent une échéance de traitement séparée.
- **Délai de traitement** : 30 minutes. Un `PAYMENT_PROCESSING` ancien (au-delà de 30 min) ne provoque JAMAIS une libération automatique aveugle. Il passe par une **réconciliation dédiée** : vérification de l'état réel du paiement (hors verrou PostgreSQL), puis décision manuelle ou automatisée.
- **Aucune requête Stripe sous verrou** : Aucune requête réseau Stripe ne doit être faite pendant qu'un verrou PostgreSQL est conservé. La réconciliation lit l'état du paiement en base (mis à jour par le webhook), pas directement depuis Stripe.
- **Worker et webhook** : Les deux verrouillent la même ressource transactionnelle : le brouillon racine d'abord, puis tous ses holds dans un ordre stable, dans la même transaction. Le webhook convertit ; le worker expire. La première transaction gagne.

## 17. Compensation des paiements tardifs

Reporté au Lot 5. La mécanique exacte du remboursement reste à définir (open-questions.md).

**Contrat futur (Lot 5)** :

- **Scénario** : Un paiement est confirmé (webhook Stripe) après que le worker a libéré le hold (`EXPIRED` ou `RELEASED`).
- **Décision** : La confirmation externe tardive ne réactive pas le hold et ne réalloue pas les exemplaires. Elle déclenche une **compensation idempotente** : le paiement confirmé est enregistré, et un remboursement ou un avoir est initié.
- **Idempotence** : La compensation est idempotente : un même paiement confirmé ne déclenche qu'une seule compensation, même si le webhook est reçu plusieurs fois.

## 18. Exécution worker/Cron

**Recommandation** : Vercel Cron pour le MVP.

**Raison** : Vercel Cron est natif à l'hébergement (ADR-005), simple à configurer, et compatible avec le modèle serverless. Un endpoint Route Handler Next.js est appelé à intervalle régulier (ex: toutes les 60 secondes).

**Comparaison avec un worker permanent** : Un worker permanent (ex: `apps/worker` avec un loop) nécessite un processus long-running, ce qui est plus coûteux et plus complexe à opérer sur Vercel. Vercel Cron est préféré pour le MVP. Le worker `apps/worker` reste disponible pour les traitements secondaires (outbox, notifications, documents) qui ne sont pas du Lot 4.

**Configuration** :

- Endpoint : `/api/cron/expire-holds` (Route Handler Next.js).
- Méthode : `GET` (Vercel Cron déclenche les Cron Jobs par GET, pas POST).
- Fréquence : chaque minute (`* * * * *`).
- Authentification : secret partagé (`CRON_SECRET`) vérifié dans le header `Authorization`.
- Batch limit : configurable (ex: 10 brouillons par invocation).
- Pas de timer permanent en mémoire.

**Plan Vercel** : L'exécution chaque minute nécessite un plan Vercel Pro ou Enterprise. Le plan Hobby est limité à une exécution quotidienne. L'ADR suppose un plan Pro.

**Tolérance aux retards** : Vercel ne garantit pas une invocation parfaitement ponctuelle. Le batch est conçu pour être idempotent et tolérant aux retards (`SKIP LOCKED`, sélection par `expires_at < now()`).

**Sécurité** : Voir section 19.

## 19. Sécurité du Cron

**Authentification** :

- L'endpoint vérifie le header `Authorization: Bearer ${CRON_SECRET}`.
- Le secret est stocké dans les variables d'environnement Vercel.
- Méthode HTTP : `GET` uniquement (Vercel Cron utilise GET).
- Si le secret est absent ou incorrect : `401 Unauthorized`.

**Concurrence** :

- Plusieurs invocations simultanées sont sûres grâce à `FOR UPDATE SKIP LOCKED`.
- Chaque invocation traite un lot disjoint de brouillons.
- Aucun verrou n'est conservé entre les invocations.

**Limitation** :

- Le batch est borné (`LIMIT $batch_limit`) pour éviter les transactions longues.
- Une invocation qui dépasse le timeout Vercel (ex: 10s) est interrompue sans effet partiel (la transaction est annulée).

**Observabilité** :

- Log du nombre de holds expirés par invocation.
- Log des erreurs (hold introuvable, transition invalide).
- Métrique : durée du batch, nombre de holds traités.

## 20. Index et contraintes

### Index

```sql
-- Sélection des holds expirables
CREATE INDEX idx_inventory_blocks_expirable
  ON inventory_blocks (expires_at)
  WHERE type = 'HOLD' AND status = 'ACTIVE' AND deleted_at IS NULL;

-- Recherche d'allocations par brouillon
CREATE INDEX idx_allocations_draft_line
  ON allocations (draft_line_id);

-- Recherche d'allocations par bloc
CREATE INDEX idx_allocations_inventory_block
  ON allocations (inventory_block_id);

-- Index pour le traitement par brouillon (recherche de tous les blocs d'un brouillon donné)
CREATE INDEX idx_inventory_blocks_source_id
  ON inventory_blocks (source_id)
  WHERE deleted_at IS NULL;

-- Recherche de brouillons par client
CREATE INDEX idx_booking_drafts_customer_user
  ON booking_drafts (customer_user_id);

-- Recherche de brouillons par organisation
CREATE INDEX idx_booking_drafts_organization
  ON booking_drafts (organization_id);

-- Sélection des brouillons expirables pour le batch d'expiration
CREATE INDEX idx_booking_drafts_expirable
  ON booking_drafts (expires_at)
  WHERE status = 'HELD';

-- Récupération des PENDING abandonnés dans idempotency_records
CREATE INDEX idx_idempotency_records_pending_timeout
  ON idempotency_records (status, pending_timeout_at)
  WHERE status = 'PENDING';
```

### Contraintes

- `booking_drafts.customer_end_at > customer_start_at`.
- `booking_drafts.blocked_start_at <= customer_start_at`.
- `booking_drafts.blocked_end_at >= customer_end_at`.
- `booking_drafts.total_amount_minor >= 0 AND <= 9007199254740991`.
- `booking_drafts.currency = 'EUR'` (MVP, contrainte applicative).
- `booking_drafts.tax_amount_minor IS NULL WHEN tax_status = 'UNDETERMINED'`.
- `booking_drafts.tax_amount_minor = 0 WHEN tax_status = 'NOT_APPLICABLE'`.
- `booking_drafts.tax_amount_minor IS NOT NULL WHEN tax_status = 'APPLIED'`.
- `booking_draft_lines.quantity > 0`.
- `booking_draft_lines.billable_unit_count > 0`.
- `booking_draft_lines.unit_price_amount_minor >= 0`.
- `booking_draft_lines.line_total_amount_minor >= 0`.
- `UNIQUE (draft_line_id, inventory_block_id)` sur `allocations`.
- `UNIQUE (inventory_block_id)` sur `allocations`.
- `no_overlapping_blocks` (existant, migration 0017).
- `product_variants.daily_price_amount_minor > 0` (contrainte applicative, nullable).
- `product_variants.daily_price_amount_minor <= 9007199254740991` (contrainte applicative).
- `locations.prep_buffer_minutes >= 0` (contrainte applicative, défaut 30 minutes).
- `locations.cleanup_buffer_minutes >= 0` (contrainte applicative, défaut 30 minutes).
- `UNIQUE (organization_id, operation, key)` sur `idempotency_records` (voir section 11b).

### Contraintes CHECK PostgreSQL

Les contraintes suivantes sont des CHECK PostgreSQL, pas uniquement applicatives, pour garantir l'intégrité au niveau base :

```sql
-- Prix catalogue
ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_daily_price_positive
    CHECK (daily_price_amount_minor IS NULL OR daily_price_amount_minor > 0);

ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_daily_price_max
    CHECK (daily_price_amount_minor IS NULL OR daily_price_amount_minor <= 9007199254740991);

-- Marges lieu
ALTER TABLE locations
  ADD CONSTRAINT locations_prep_buffer_nonneg
    CHECK (prep_buffer_minutes >= 0);

ALTER TABLE locations
  ADD CONSTRAINT locations_cleanup_buffer_nonneg
    CHECK (cleanup_buffer_minutes >= 0);

-- Politique d'annulation par défaut au niveau organisation
ALTER TABLE organizations
  ADD CONSTRAINT organizations_default_cancellation_policy_valid
  CHECK (default_cancellation_policy_code IN ('FLEXIBLE', 'MODERATE', 'FIRM'));
```

## 21. Plan de tests

### Tests unitaires

- **Jours civils et DST** : location sur une seule date, franchissement de minuit, fin exactement à minuit, changement d'heure d'été/hiver, intervalle invalide.
- **Multiplication et overflow** : `unit_price * count * quantity` avec vérification `Number.isSafeInteger`, dépassement de `MAX_SAFE_INTEGER` détecté.
- **Politiques d'annulation et bornes exactes** : Flexible (24h), Modérée (5 jours / 24h), Ferme (14 jours / 7 jours), fenêtre commerciale 24h après confirmation si retrait ≥ 7 jours.
- **Empreinte canonique** : même payload sous différentes représentations JSON (ordre des champs, espaces) produit la même empreinte.
- **Conflit d'idempotence** : même clé + empreinte différente = erreur 409.
- **Transitions d'état** : `DRAFT → HELD`, `HELD → EXPIRED`, `HELD → CANCELLED`.

### Tests PostgreSQL (intégration)

- **Deux créations concurrentes pour le dernier exemplaire** : une réussit, l'autre échoue sur `no_overlapping_blocks` ou sur l'inventaire insuffisant.
- **Même clé concurrente** : une seule création, l'autre retourne le résultat persisté.
- **Même clé avec requêtes différentes** : erreur 409 (conflit d'empreinte).
- **Rollback complet si allocation insuffisante** : aucun brouillon, aucune ligne, aucune allocation, aucun bloc subsiste.
- **Exclusion POOR et BROKEN** : les items en `POOR` ou `BROKEN` ne sont pas sélectionnés.
- **Respect de blocked_period avec marges** : `blocked_start_at = customer_start_at - prep_buffer`, `blocked_end_at = customer_end_at + cleanup_buffer`.
- **Batchs concurrents SKIP LOCKED** : deux invocations du worker traitent des lots disjoints de brouillons.
- **Worker contre conversion** : le worker n'expire pas un hold déjà converti.
- **PAYMENT_PROCESSING jamais expiré par le batch normal** : le batch normal ne sélectionne que les brouillons `HELD` dont aucun bloc n'est `PAYMENT_PROCESSING`.

### Tests Lot 5 (contrat futur)

Les tests suivants supposent un modèle de paiement qui n'existera pas au Lot 4. Ils sont reportés au Lot 5 :

- **Worker contre transition PAYMENT_PROCESSING** : le worker n'expire pas un hold `PAYMENT_PROCESSING`.
- **HELD → PAYMENT_PROCESSING (refusée si expiré)** : la transition `HELD → PAYMENT_PROCESSING` est refusée si le brouillon est expiré au moment de la prise de verrou.
- **Webhook contre expiration** : le webhook qui tente une transition `ACTIVE → PAYMENT_PROCESSING` après `expires_at` est refusé.
- **Hold ACTIVE expiré non convertible** : même si le webhook arrive avant le worker, la conversion est refusée.

## 22. Alternatives rejetées

- **Tranche glissante de 24 heures** : effets contre-intuitifs lors des changements d'heure (jour à 23h ou 25h).
- **Journée commerciale selon horaires de retrait** : complexité accrue non justifiée au MVP.
- **`integer` (int4) en base** : marge future insuffisante ; `bigint` préféré avec mode `number` Drizzle.
- **`bigint` JavaScript avec sérialisation string** : complexité de sérialisation JSON (`TypeError`) non justifiée au MVP.
- **Brouillon invité** : brouillons orphelins, complexité nullable, traçabilité incomplète.
- **Fenêtre de grâce sur l'expiration** : dépendante du retard du Cron ; cutoff strict préféré.
- **Worker permanent pour l'expiration** : plus coûteux et complexe que Vercel Cron pour le MVP.
- **`POOR` réservable** : risque de litige sur la qualité au MVP.
- **Politique d'annulation unique** : trois politiques prédéfinies couvrent mieux les besoins du pilote.

## 23. Conséquences

- Quatre nouvelles tables : `booking_drafts`, `booking_draft_lines`, `allocations`, `idempotency_records`.
- Quatre nouveaux enums : `booking_draft_status`, `tax_status`, `allocation_status`, `cancellation_policy_code` (`FLEXIBLE`, `MODERATE`, `FIRM`).
- Une colonne `default_cancellation_policy_code` sur `organizations` (enum `cancellation_policy_code`, défaut `FLEXIBLE`).
- Un endpoint Cron : `/api/cron/expire-holds`.
- Une constante : `HOLD_DURATION_MINUTES = 10`.
- Des champs de marges sur `locations` : `prep_buffer_minutes`, `cleanup_buffer_minutes` (défaut 30).
- Le snapshot de politique d'annulation est figé dans le brouillon.
- La décomposition fiscale est reportée au Lot 5 (`tax_status = UNDETERMINED`).
- La commission est reportée au Lot 5 (`commission_amount_minor = null`).
- La confirmation de réservation est reportée au Lot 5.
- La compensation des paiements tardifs est reportée au Lot 5 (mécanique exacte).

## 24. Questions et périmètre d'acceptation

### Résolues par le déplacement du verrou juridique

1. **Validation juridique des politiques d'annulation** : cette validation ne bloque plus l'acceptation de l'ADR-009 pour le Lot 4 technique. Elle est déplacée vers « avant Lot 5 / activation en production » (voir section 1b). Le Lot 4 n'exécute aucune règle d'annulation financière : `cancellation_policy_snapshot` fige uniquement `policy_code`, `policy_version` et `timezone`, sans calculer d'échéances de remboursement.

### Réserves Lot 5 n'empêchant pas le Lot 4

2. **Taxes, facturation et rôle légal d'Uttily** : nécessaire avant la confirmation du Lot 5, mais n'empêche pas le Lot 4 car `tax_status = UNDETERMINED` (open-questions.md : OUVERT, Lot 5).
3. **Mode Stripe Connect et responsabilité juridique** : nécessaire pour la commission au Lot 5, mais n'empêche pas le Lot 4 car `commission_amount_minor = null` (open-questions.md : OUVERT, Lot 5).
4. **Compensation des paiements confirmés tardivement** : n'empêche pas le Lot 4 car la compensation est reportée au Lot 5 (open-questions.md : OUVERT, Lot 5).

**Conclusion** : L'ADR-009 est acceptée pour le périmètre du Lot 4 technique. Les réserves Lot 5 (validation juridique des politiques d'annulation, taxes, commission, compensation) restent des blocages pour le Lot 5 et l'activation en production.
