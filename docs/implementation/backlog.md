# Backlog de démarrage

Les lots sont séquentiels. Ne pas commencer un lot dépendant avant que ses invariants soient testés.

## Lot 0 — Fondation du dépôt

**But** : créer le monorepo et l'outillage sans logique métier.

Critères d'acceptation :

- Application Next.js TypeScript initialisée.
- Packages `core`, `database`, `contracts`, `auth`, `ui` et `config` créés.
- Lint, formatage, vérification de types et tests exécutables en CI.
- Environnements local, staging et production documentés.
- Aucun secret versionné.

## Lot 1 — Identité, organisations et établissements

**But** : gérer l'accès B2B multi-tenant de manière sûre.

Critères d'acceptation :

- Utilisateur, organisation, membership et établissement persistés.
- Rôles `OWNER`, `ADMIN`, `MANAGER`, `STAFF` appliqués côté serveur.
- Un membre d'une organisation ne peut pas lire les données d'une autre.
- Un utilisateur peut appartenir à plusieurs organisations.
- Fuseau IANA et horaires configurables par établissement.

## Lot 2 — Catalogue et inventaire physique

**But** : permettre à un loueur de mettre en ligne un stock exploitable.

Critères d'acceptation :

- Catégorie, produit, variante et exemplaire physique sont distincts.
- Chaque exemplaire porte un état, un établissement et un identifiant interne.
- Un loueur ne peut modifier que son catalogue.
- Les produits incomplets ne sont pas publiables.
- Tests couvrant les autorisations et la cohérence du stock.

### Décisions prises (Lot 2A)

- **Catégories globales** : taxonomie partagée gérée par l'admin Uttily. Seed de 9 catégories racines. Arborescence profondeur ≤ 3. Désactivation refusée si produits PUBLISHED.
- **Variante par défaut** : chaque produit a au moins une `ProductVariant` (variante « Standard » créée atomiquement). `product_id` immuable. Dernière variante active protégée par trigger PostgreSQL.
- **Publication sans stock** : un produit peut être `PUBLISHED` sans exemplaire. L'indisponibilité temporaire est un état légitime. La publication exige : nom, description, catégorie active, ≥ 1 variante active.
- **Statut structurel** : `ACTIVE | RETIRED | LOST` (gestion du parc) découplé de `condition` (`NEW | GOOD | FAIR | POOR | BROKEN`, état physique). Pas de disponibilité au Lot 2 ; calculée au Lot 3 via `InventoryBlock`.
- **`ARCHIVED` vs `deleted_at`** : `publication_status` est un état métier réversible ; `deleted_at` est une suppression logique technique.
- **`InventoryMovement`** : journal append-only des transferts, idempotent via `idempotency_key`.
- **Cohérence multi-tenant** : garantie par triggers PostgreSQL (location et variante appartiennent à la même org que l'exemplaire).
- **Photos** : reportées au Lot 7. **MaintenanceRecord** : reporté au Lot 3/6.

### Découpage

- **Lot 2A** : schéma normalisé, domaine, permissions, tests PostgreSQL.
- **Lot 2B** : Server Actions et écrans de catalogue/inventaire.
- **Lot 2C** (optionnel) : historique des mouvements étendu et administration des catégories.

### Décisions prises (Lot 2B)

- **Contrat `ActionResult<T>`** : les Server Actions de mutation retournent une discriminated union `{ ok: true; data } | { ok: false; code; message; fieldErrors? }`. Les codes d'erreur sont une union fermée `ActionErrorCode` dans `@uttily/contracts` (cf. ADR-008).
- **Erreurs métier typées `CatalogError`** : le domaine catalog lève `CatalogError` (avec `code: ActionErrorCode`) au lieu d'`Error` générique. Les actions catchent `CatalogError` et mappent le code vers `ActionResult` — pas de string matching côté actions.
- **Conflits PostgreSQL par nom de contrainte** : les violations uniques (slug, SKU, serial) sont catchées par nom de contrainte (SQLSTATE 23505), pas par message. Les triggers `RAISE EXCEPTION` (P0001) sont identifiés par message dans le domaine (seul endroit avec string matching, justifié car PG ne fournit pas d'identifiant machine-readable).
- **`organizationId` injecté serveur** : jamais trusté du client. Les actions utilisent le binding par closure (`action.bind(null, orgId)`) — l'`organizationId` vient du paramètre de route, validé par `requireCatalogManagerOf` qui vérifie la membership.
- **Validation manuelle** : parseurs FormData explicites (pas de Zod). Validation UUID, enums, longueurs, trim. Production de `fieldErrors` en cas d'erreur.
- **Idempotence transfert** : `transferInventoryItem` conserve sa clé d'idempotence stable (générée à l'affichage du formulaire via `crypto.randomUUID()`, champ caché, réutilisée aux retries). Les autres mutations ne sont pas idempotentes ; la protection contre le double-submit est côté UI (`useFormStatus`).
- **Read models** : 6 read models dans `packages/core` pour les besoins d'affichage (`listProductSummaries`, `getProductDetails`, `listInventorySummaries`, `getInventoryDetails`, `listActiveVariantOptions`, `getProductPublicationReadiness`). Les Server Components appellent directement le core pour les lectures ; les Server Actions sont réservées aux mutations.
- **Écrans** : Server Components pour les lectures, Client Components colocalisés pour les mutations (`useActionState` + `useFormStatus`). UI minimaliste inline, accessibilité légère (labels, `aria-live`, native inputs). Pas de pagination au Lot 2B.
- **Actions delete non exposées** : `deleteProduct`/`deleteVariant`/`deleteInventoryItem` ne sont pas exposées au Lot 2B. La suppression métier réversible est couverte par `archive`/`deactivate`/`retire`. Le delete technique (`deletedAt`) sera exposé via un usage admin futur.
- **Layout dashboard** : navigation commune (Établissements, Catalogue, Inventaire, Équipe) dans `[orgId]/layout.tsx`. Auth déléguée au layout (défense en profondeur : les pages enfants gardent leur propre auth).

## Lot 3 — Disponibilité et blocages

**But** : empêcher toute double réservation.

Critères d'acceptation :

- `InventoryBlock` gère hold, réservation, maintenance et blocage manuel.
- Une contrainte PostgreSQL empêche les chevauchements incompatibles.
- Les périodes client et opérationnelles sont distinctes.
- Les recherches filtrent réellement les exemplaires disponibles.
- Un test d'intégration simule deux demandes concurrentes sur le dernier exemplaire.

## Lot 4 — Prix, brouillon et hold

**But** : préparer une réservation fiable avant paiement.

Critères d'acceptation :

- Prix calculé avec devise et montants entiers.
- Brouillon de réservation créé pour un seul loueur.
- Exemplaires alloués et hold expirant créés atomiquement.
- Même clé d'idempotence : même résultat, aucun doublon.
- Worker ou tâche planifiée libère les holds expirés de façon sûre.

## Lot 5 — Paiement et confirmation

**But** : confirmer une location payée sans incohérence.

Critères d'acceptation :

- Paiement Stripe associé à un brouillon et à une organisation.
- Signature des webhooks vérifiée et événements dédupliqués.
- Paiement réussi : hold converti en réservation, snapshot figé et outbox créée dans une transaction.
- Paiement échoué ou abandonné : hold libéré selon les règles.
- Aucun numéro de carte n'est persisté par Uttily.

## Lot 6 — Opérations et documents

**But** : exécuter la location sur le terrain.

Critères d'acceptation :

- L'employé peut préparer, remettre et réceptionner une réservation autorisée.
- Rapport d'état et dommage rattachés à l'exemplaire et à la réservation.
- Contrat, confirmation et reçu sont générés par le worker via l'outbox.
- Les actions importantes sont auditées.

## Lot 7 — Recherche publique et tableau de bord

**But** : rendre l'offre exploitable par les clients et les loueurs.

Critères d'acceptation :

- Recherche par destination, période, catégorie et rayon.
- Fiche produit affichant prix, conditions, loueur et lieu de retrait.
- Vue loueur des réservations du jour, retours et alertes de maintenance.
- Mesures minimales : recherche, résultat disponible, tentative de réservation et réservation confirmée.
