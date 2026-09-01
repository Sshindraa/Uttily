# Backlog de démarrage

Les lots sont séquentiels. Ne pas commencer un lot dépendant avant que ses invariants soient testés.

> La trajectoire globale des travaux restants est organisée dans la
> [roadmap de préparation opérationnelle et de passage à l'échelle](roadmap-operational-readiness-and-scale.md).
> Le présent backlog reste l'autorité des lots effectivement approuvés, en cours
> ou livrés ; la roadmap ne transforme pas une capacité future en lot autorisé.
> La taxonomie commerciale outdoor fermée est canonique dans
> [`docs/product/equipment-taxonomy.md`](../product/equipment-taxonomy.md) et
> ADR-035.

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

### Lot 7 — Découpage révisé (après arbitrage produit 2026-08-07)

> Voir `docs/product/lot7-arbitrage.md` pour les décisions produit approuvées et
> ADR-018 pour la conception de la tarification flexible. Le découpage antérieur
> reste conservé ci-dessus pour historique. Décisions clés : France première
> activation, architecture mondiale, activation pays explicite fail-closed ;
> FR+EN dès le lancement ; trois photos obligatoires avant publication
> publique ; tarification flexible par plans tarifaires.

| Groupe | Scope | Dépendances | Hors périmètre |
| --- | --- | --- | --- |
| G7B-R3 Round 2 — Correction ciblée des incohérences documentaires | ce cycle : correctif documentaire uniquement (13 corrections sur 11 fichiers) | G7B-R3 | aucun code/SQL |
| G7C-R3 — Alignement du schéma public géographique | corriger 0031 en place (viewport/bbox, countryCode, type de lieu, modèle de traductions par locale), stratégie activation pays fail-closed, tests complets upgrade/rollback — **Terminé** | G7B-R3 | recherche Core, géocodeur, photos, plans tarifaires |
| G7P-A — Fondations des plans tarifaires | schéma des plans, fenêtres tarifaires, versions et paliers ; tables pricing_plans + multi_day_discount_tiers + pricing_plan_windows + pricing_plan_translations, enum pricing_lifecycle_state (DRAFT/ACTIVE/RETIRED), clé métier excluant la version, immutabilité après activation, traductions FR+EN requises pour l'activation, fonction resolve_effective_pricing_plans, contraintes CHECK cohérence, migration, backfill variantes existantes vers DAILY — **Terminé Round 2 (schéma uniquement)** | G7B-R3 | moteur, UI |
| G7P-B — Moteur de pricing flexible | sélection déterministe, TIME_RANGE/DAY_RANGE, DST, horaires, réductions, snapshots étendus, retrait tardif, annulations horaires — **G7P-B1 terminé (moteur read-only, non intégré au flux de réservation) ; G7P-B2-A terminé — Round 3 (schéma + contraintes + triggers + tests, migration 0033, source_draft_line_id, copie exacte root, pas de re-validation catalogue, concurrence pg_advisory_lock) ; G7P-B2-B Round 2 terminé et validé (intégration dans createBookingDraftWithHold : union discriminée legacy/flexible, transition DRAFT → HELD, SET CONSTRAINTS ciblé, conversion local-to-UTC fail-closed, DAY_RANGE bornes premier/dernier jour, resolvedLocale du moteur, PricingWindowSnapshot persisté, billableUnitCount du moteur, dispatch fermé, isolation erreurs DB, 72 tests d'intégration) ; G7P-B2-C terminé (applyBookingConfirmation copie tous les champs flexibles root + lines, initiatePayment valide pricingSnapshotVersion fail-closed, document data loader sélectionne les champs flexibles, 22 tests d'intégration, aucune migration 0034 nécessaire)** | G7P-A, G7C-R3 | UI, paiement cross-currency, modifications de réservation avec variation financière |
| G7M (ou G7P-C) — Modifications de réservation financières | modifications de réservation avec variation financière (conception paiement/remboursement requise au préalable) — **Conception approuvée par ADR-023 (Accepted) le 2026-08-10 ; G7M-A livré le 2026-08-11 (schéma, migration 0036_g7m_a_amendment_schema.sql, triggers, tests — voir `docs/implementation/g7m-a-amendment-schema.md`) ; G7M-B1 livré le 2026-08-11 (projection canonique `getEffectiveBooking` read-only, tenant-safe, parsing JSONB, invariant financier ADR-023 §11.2 vérifié à chaque projection avec FINANCIAL_INVARIANT_VIOLATION — voir `docs/implementation/g7m-b1-effective-booking.md`) ; G7M-B2-A livré le 2026-08-12 (amendements NEUTRAL, `createNeutralBookingAmendment` transactionnel idempotent, optimistic locking, append-only, outbox BOOKING_AMENDED.v1, 37 tests unitaires + 13 tests d'intégration PostgreSQL - voir `docs/implementation/g7m-b2a-neutral-amendments.md`) ; G7M-B2-B1 livré le 2026-08-13 (amendements REFUND avant pickup, `createRefundBookingAmendment` transactionnel idempotent avec eventVersion 'v1', clé provider `refund_amendment_${refundId}` distincte de la clé outbox `refund_requested_${refundId}`, payload REFUND_REQUESTED.v1 4 UUIDs, statut refund PENDING, cap cumulatif par statut et concurrence sans deadlock - voir `docs/implementation/g7m-b2b1-refund-amendments.md`) ; G7M-B2-B2A livré et validé le 2026-08-13 (moteur Core tenant-safe, tests dédiés unitaires/PostgreSQL worker/webhook, régressions ciblées et suite Core — voir `docs/implementation/g7m-b2b2a-refund-execution.md`) ; G7M-B2-B2B livré le 2026-08-13 (route GET `/api/cron/process-refund-requests`, `CRON_SECRET`, validation TEST/LIVE, Vercel Cron, tests Web/PostgreSQL — voir `docs/implementation/g7m-b2b2b-refund-cron.md`).** Périmètre : amendements append-only sur réservation CONFIRMED uniquement, trois types NEUTRAL/SUPPLEMENT/REFUND, projection canonique `getEffectiveBooking`, hold delta-segment 10 min pour SUPPLEMENT, application atomique directe pour NEUTRAL/REFUND, dette de remboursement visible et auditée, UI client minimale réutilisant Stripe Elements. Dépendances de migration : nouvelles tables d'amendement, extension `refund_reason`/`refund_status`, relation `refunds`/`amendment_payments` (XOR), adaptation `condition_reports`/`damage_reports`, route cliente de paiement. | G7P-B2, ADR-023 | parcours client complet d'auto-service, Hosted Checkout/Payment Links/Terminal, cross-currency, modification après READY_FOR_PICKUP, STAFF |
| G7D — Core/read models de recherche uniquement | use case `searchPublicOffers`, read models, géographie viewport adaptative (exact Bbox), disponibilité booléenne, buffers, CTE/keyset — **G7D-A terminé et testé (83 tests : 34 intégration PostgreSQL, 14 curseur, 23 geo, 12 errors)** | G7C-R3, G7P-B2 | web, géocodeur configuré, routes, pages, carte |
| G7E — Routes/pages/carte/i18n & Pont Checkout | page/route, UX/a11y, carte déplaçable/zoomable, relance viewport, FR+EN, alternatives séparées — **G7E-A/B implémentés ; Pont Recherche Publique → Booking Checkout (G7E / Pont Checkout) implémenté et durci (migration 0038 avec public_id sur product_variants, read model getPublicOfferDetails réduit, résolveur resolvePublicBookingAuthority fail-closed, Server Action createBookingDraftAction avec hold atomique et idempotence déterministe, voir `docs/implementation/public-offer-booking-bridge.md`)** | G7D | dashboard, géocodeur configuré |
| G7F-A — Métadonnées photo et gating trois photos | table/colonnes photos, contrainte 3 photos obligatoires, gating publication et requête publique — **Terminé (G7F-A2)** | G7C-R3 | UI guidée, upload réel, CDN |
| G7F-B — UI guidée photos | tutoriel par catégorie, upload, fallback | G7F-A, politique image | CDN imposé |
| G7G — Dashboard | signal minimal maintenance/BROKEN, fuseaux — **Implémenté le 2026-08-09 : projection Core bornée, isolation PostgreSQL, bornes temporelles exactes, UI dashboard et tests dédiés** | G7B-R3 | workflow complet |
| G7H — Analytics | ledger first-party, 4 mesures, privacy-gated — **G7H-A terminé (fondations techniques : migration 0035, module Core product-analytics, tests unitaires et intégration PostgreSQL, ADR-022) ; G7H-B terminé (cablage de 3 evenements analytics dans les parcours applicatifs : PUBLIC_SEARCH_PERFORMED, BOOKING_ATTEMPTED, BOOKING_CONFIRMED, avec resolveur d'environnement pur et gate PRODUCTION impossible, enregistreur best-effort avec savepoint, ADR-022 amende section 2.8) ; activation production bloquée par question ouverte G7B-R3** | G7B-R3, validation privacy | provider externe, collecte avant validation |
| G7I — Validation transversale | tests transversaux Core PostgreSQL (chaîne publique, isolation tenant, intervalles semi-ouverts), security sentinel fail-closed (WebhookHandlerError + BookingDraftError), static accessibility guardrails, matrice de couverture complète — **Validé par CI PR #16 ; fusion sur main effectuée et validée (commit `19653fac`)** | G7C-R3–G7H | réouverture Lot 6 |

Dépendances explicites : G7C-R3 dépend de G7B-R3 ; G7P-A dépend de G7B-R3 ;
G7P-B dépend de G7P-A et G7C-R3 ; G7M/G7P-C dépend de G7P-B2 et d'une conception
paiement/remboursement (ADR-023 approuvée ; G7M-A, B1, B2-A et B2-B2A livrés,
wiring route/cron B2-B2B livré) ; G7D dépend de G7C-R3 et G7P-B2 ; G7E dépend de
G7D ; G7F-A dépend de G7C-R3 ; G7F-B dépend de G7F-A ; G7G/G7H dépendent de
G7B-R3 ; G7I dépend de tous.

G7M C1–C4 (C1 création locale durable de supplément, C2 initiation de paiement et commission, C3 webhook Stripe et application atomique, C4-S/C4-A cycle de vie, retry et réconciliation, C4-B compensation atomique des paiements tardifs) sont entièrement livrés et fusionnés sur `main` au commit `2121953a003cd359b3fcd32f25812e15099d3404`.

G7M-C5-A (fondation canonique de prévisualisation read-only et première interface loueur) est entièrement implémenté et validé : fonction Core `previewBookingAmendment`, action serveur `previewBookingAmendmentAction`, écran `/dashboard/[orgId]/operations/[bookingId]/amend`, tests unitaires Core (11/11), tests d'intégration PostgreSQL (12/12 sans écriture), tests Web (21/21). Voir `docs/implementation/g7m-c5a-amendment-preview-ui.md`.

G7M-C5-B (workflow de confirmation et application loueur) est entièrement implémenté et validé : orchestrateur Core `confirmBookingAmendment` avec dispatch automatique NEUTRAL/REFUND/SUPPLEMENT, Server Action `confirmBookingAmendmentAction`, interface de confirmation et écrans de succès dédiés, 21 tests unitaires Core, 13 tests d'intégration PostgreSQL réels, 17 tests actions Web, 18 tests UI Web. Voir `docs/implementation/g7m-c5b-amendment-confirmation.md`.

G7M-C5-C (paiement client authentifié du supplément via Stripe Elements) est entièrement implémenté, durci et validé dans la pile locale : read model Core `getSupplementCheckoutSummary` (SELECT pur, tenant-isolated, fail-closed, reprise du même PaymentIntent en état non terminal, conservation du fuseau horaire IANA autoritaire de `locations.time_zone`, 14 tests unitaires déterministes et 17 tests d'intégration PostgreSQL réels sans skip ni écriture), Server Action `initiateSupplementPaymentAction` (résolution serveur avec clause SQL WHERE customer, zéro fuite d'identifiant technique, 33 tests unitaires et 4 tests d'intégration PostgreSQL réels), page et composant `/checkout/amendment/[amendmentId]` (Stripe Elements, confirmation différée sans fausse annonce immédiate, 21 tests dont 7 Server Component, 12 helpers purs client et 2 tests de rendu statique), handoff loueur dans `amend-booking-form.tsx` avec composant dédié `SupplementPaymentHandoff` (bouton copier et lien voir réservation uniquement, aucun champ ni texte n'exposant l'URL ou l'UUID, 21 tests dans `amend-booking.test.tsx`). Suite Web locale : 286 passés, 126 ignorés, 0 échec. Lint, typecheck et build Web validés. Validation CI globale effectuée et verte (15 jobs parallèles). Voir `docs/implementation/g7m-c5c-customer-supplement-payment.md`.

Le lot fonctionnel G7M est ainsi complet. Aucun C5-D n'est prévu. G7M C1–C5 sont fusionnés sur main et validés par CI post-merge (15 jobs parallèles, qualité/tests/build verts).

Cette complétude couvre le périmètre legacy et les suppléments split livrés ;
les baisses, annulations en baisse et compensations tardives portant un snapshot
split restent fail-closed et sont suivies par ADR-029/ADR-030.


Le pont direct de réservation publique vers le checkout initial (G7E / Pont Checkout) est entièrement durci et validé : migration 0038 (`public_id` sur les variantes avec trigger d'immutabilité), read model canonique public `getPublicOfferDetails` sans fuite interne, résolveur d'autorité côté serveur `resolvePublicBookingAuthority` appliquant les mêmes règles d'éligibilité que la consultation, Server Action `createBookingDraftAction` avec hold atomique de 10 minutes et empreinte d'idempotence stable. Preuves de tests : 4 tests PostgreSQL Database, 31 tests Core, 17 tests ciblés Web, 429 tests globaux Web passés, 0 erreur lint/typecheck/build. Voir `docs/implementation/public-offer-booking-bridge.md`.

## G8A-0 — Baseline verte et déployable

**But** : transformer la branche actuelle en release candidate configurable et
fiable pour le staging, sans ajouter de fonctionnalité.

Critères d'acceptation :

- changement local séparé et validé pour le workflow sécurisé PostgreSQL et le
  seed ; changement Stripe/checkout séparé et validé ;
- ADR-025 explicitement rejetée pour ce lot ; l'onboarding Stripe-hosted de
  l'ADR-024 reste la solution autorisée et testée ;
- URL de retour Stripe issue de `PUBLIC_APP_URL`, validée par environnement ;
  frais marketplace issus du registre serveur fermé `split-13-7-v1`, sans taux
  fourni par l'environnement ou le navigateur ;
  compte connecté vérifié prêt avant création d'un paiement ;
- les remboursements split restent fail-closed conformément à `ADR-029` et
  `ADR-030` ; ce lot ne vaut ni approbation Finance/Juridique ni activation de
  leur exécution provider ;
- PostgreSQL local démarré depuis une base vierge, migrations et suites Web,
  Core PostgreSQL et worker vertes ; le test d'intégration hors PostgreSQL est
  explicitement sauté hors CI ;
- lint, format, types, tests et build verts ; dépôt propre après commits ; aucun
  secret LIVE ni fournisseur réel utilisé par le workflow local. Pour le staging
  Vercel Hobby, les quatre routes cron sont déclenchées par le Worker Cloudflare
  `uttily-staging-cron` ; aucun Cron Job Vercel à la minute n'est requis.

**Statut : clôturé le 2026-08-26.** La validation connectée a été effectuée avec un
utilisateur Clerk TEST dédié, membre `OWNER` de l'organisation de démonstration :
recherche Annecy → hold → paiement Stripe TEST → webhook signé → réservation
`CONFIRMED`. Le compte Connect a été projeté `ENABLED` après confirmation des
capacités Stripe. La preuve détaillée, sans secret ni donnée de carte, est conservée
dans `docs/implementation/g8a-0-smoke-test.md`. La CI complète post-merge est verte
au run [33003910905](https://github.com/Sshindraa/Uttily/actions/runs/33003910905).

**Après ce lot uniquement** : G8A déploiera Vercel, Neon, Clerk, Stripe TEST,
R2 et Resend pour un test staging réel.

## G8A — Staging réel

**Statut : clôturé le 2026-08-27.** Le premier ticket « provisionner R2 et Resend staging,
puis valider le traitement complet d'un événement `BOOKING_CONFIRMED` par le
worker » est validé le 2026-08-26 : bucket R2 EU privé, domaine Resend vérifié,
3 documents générés et vérifiés, email Resend TEST envoyé, événement outbox
`PROCESSED` avec 4 effets `COMPLETED`. Voir
`docs/implementation/g8a-staging-r2-resend-worker-smoke-test.md`.

Le déploiement Web staging, Clerk TEST, les variables Neon, le worker, le
scheduler, l'observabilité minimale, le rollback et le smoke test authentifié
complet sont validés dans
`docs/implementation/g8a-web-staging-deployment.md`.

## G8B — Préparation du pilote commercial

| Lot | Résultat | Dépendances | Statut |
| --- | --- | --- | --- |
| G8B-1 — Upload réel des photos produit | upload R2 sécurisé, validation serveur, trois photos avant publication, suppression/remplacement idempotents, URLs publiques contrôlées, UI accessible et tests | G7F-A2, ADR-026 | **Terminé le 2026-08-27 ; smoke test staging R2 validé** |
| G8B-2 — Géocodage réel | registre local-first, autocomplétion, benchmark fournisseur, cache et droits documentés, recherche réelle | ADR-017, ADR-021, ADR-027 | **En cours — G8B-2A, G8B-2B et G8B-2D livrés le 2026-08-27 ; moteur runtime PostgreSQL/PostGIS retenu, ingestion externe différée** |
| G8B-2D — Élargissement géographique PostGIS | paliers exact → 10 km → 25 km → 50 km, alternatives séparées, contrat de curseur versionné et tests PostgreSQL/UI | G8B-2A, G8B-2B, ADR-021, ADR-027 | **Terminé le 2026-08-27 ; validation locale Core/Web, PostgreSQL, lint, format, types et build** |
| G8B-3 — Pilote vélo France / Lyon | particuliers en location ponctuelle, vélos de ville et électriques, cible 2 loueurs/20 vélos, kit d'onboarding, contenu réel, juridique/RGPD et Go/No-Go | cadrage G8B-3, décision commerciale et juridique | **En cours — G8B-3A cadré le 2026-08-27 ; G8B-3B1/B2/B3 livrés ; G8B-3B4 clôturé techniquement ; G8B-3C bloqué faute de partenaire** |
| G8B-3B — Onboarding accompagné vélo | collecte structurée, déroulé opérateur, checklist et audit du dashboard | G8B-3A | **Terminé techniquement le 2026-08-31 — kit, établissement, plans tarifaires, readiness, gate sémantique vélo et badge professionnel auditable livrés ; validation externe du pilote restante** |
| G8B-3B1 — Établissement publiable | formulaire complet adresse, coordonnées, horaires, retrait et publication fail-closed | G8B-3B | **Terminé le 2026-08-27 — Core, dashboard et tests ciblés** |
| G8B-3B2 — Plans tarifaires loueur | création DRAFT, fenêtres, traductions, paliers et activation via dashboard | G8B-3B1, schéma G7P-A | **Terminé le 2026-08-27 — Core, dashboard, tests d'intégration et actions serveur** |
| G8B-3B3 — Readiness accompagnée | checklist serveur par organisation et liens vers les éléments manquants | G8B-3B1, G8B-3B2 | **Terminé le 2026-08-27 — Core, composant OnboardingReadinessCard, 7 jalons et tests** |
| G8B-3B4 — Standard visuel et confiance vélo | trois vues guidées et validées côté serveur, identité professionnelle factuelle, conception du badge vérifié | G8B-3B2, ADR-020, ADR-026, ADR-031, ADR-032 | **Terminé techniquement le 2026-08-31 : Photo Coach UI, overlays, checklist, contrat `BIKE_PHOTO_SLOTS`, migrations `0040`/`0050`, read model `getProfessionalVerification`, affichage public conditionnel et diagnostic dashboard ; aucune analyse IA n’est activée.** |
| G8B-3C — Contenu réel pilote | deux loueurs professionnels et vingt vélos réels publiables à Lyon | G8B-3B, partenaires signés | Bloqué — aucun partenaire engagé |
| G8B-3D — Go/No-Go LIVE | finance, juridique, RGPD, Stripe LIVE, observabilité et smoke final | G8B-3C, validations externes | Bloqué par décisions finance/juridique/RGPD |
| G8B-3E — Parcours locaux vélo | conseils structurés, sécurité, modération et actualisation | premiers partenaires, décision responsabilité/modération | Différé après les premiers partenaires |

## Chantier 21-U1 — Frontend par routes, features et UI

**Statut : Phase 0 clôturée le 2026-09-01 — ADR-033 accepté le 2026-08-31.** Les tranches livrées
séparent les primitives UI, officialisent les shells, extraient le cockpit
loueur et structurent la recherche, le checkout, les réservations, l'offre publique,
l'onboarding, la flotte, les établissements et la maintenance par domaine sans modifier
l'API publique de `@uttily/ui`, les URLs ou le comportement métier des routes. Le
checkout courant ajoute aussi les extractions accueil, sélection d'organisation
et support interne, supprime les façades devenues mortes et documente les
assets retirés. Le commit fonctionnel réécrit de clôture est
`ee382ac`. La base locale PostGIS a été migrée depuis zéro (50 entrées Drizzle),
la suite Database PostgreSQL a passé 24 fichiers et 816 tests sans skip, la suite
Core PostgreSQL 158 fichiers et 2 973 tests sans skip, et le restore drill réel a
rendu `PASS`. Le correctif d'orchestration séquence `test:full` avec
`--workspace-concurrency=1` et son garde-fou est couvert ; `pnpm check:fast`,
lint, format, typecheck, builds, smoke worker et Playwright public (16/16) sont
validés. Après rebase sur `origin/main=aa1350d`, les quatre commits sont
`ee382ac`, `04a9b88`, `4426da7` et `200a2f3`, avec un arbre fonctionnel inchangé
par rapport à la sauvegarde `05ac1c3`. La CI parallèle est entièrement verte au
run [#33498404591](https://github.com/Sshindraa/Uttily/actions/runs/33498404591),
y compris les six shards Core et Browser acceptance ; les E2E authentifiés ont
été validés avec les credentials Clerk TEST de la CI. La PR #40 est mergeable et
aucune tâche de Phase 1 n'est engagée.

| Lot | Périmètre | Statut |
| --- | --- | --- |
| 21-U1-A — Primitives UI Button/Icon | modules `button/` et `icon/`, exports racine et sous-chemins stables, tests conservés | **Terminé le 2026-08-31** |
| 21-U1-A2 — Primitives UI restantes | extraire `Input`, `Textarea`, `Select`, `Field`, `Card`, `Badge`, `Alert`, `Dialog`, `Tabs` et les états de chargement en modules composant-owned | **Terminé le 2026-08-31** |
| 21-U1-B — Shells applicatifs | déplacer les layouts de navigation vers `apps/web/src/components/shells/` | **Terminé le 2026-08-31** |
| 21-U1-C — Feature cockpit | extraire le dashboard loueur dans `apps/web/src/features/dashboard/` en gardant les actions côté serveur | **Terminé le 2026-08-31** |
| 21-U1-D — Extraction par domaine | migrer progressivement recherche, réservation, onboarding, flotte, établissements, maintenance et checkout ; aucune réécriture globale | **Terminé techniquement le 2026-09-01 — recherche, checkout, réservations, offre publique, onboarding, planning, opérations, amendements, équipe, réglages, finances, cockpit, accueil, sélection d'organisation, support interne, fiches, paiements, notifications, audit, écrans flotte, établissements et maintenance livrés ; façades mortes et assets non utilisés nettoyés** |
| 21-U1-D1 — Feature search | déplacer la présentation de recherche dans `apps/web/src/features/search/` et garder la route comme orchestration | **Terminé le 2026-08-31** |
| 21-U1-D2 — Feature checkout | déplacer les clients Stripe et les états de checkout initial/supplément dans `apps/web/src/features/checkout/` et garder les routes comme orchestration | **Terminé le 2026-08-31** |
| 21-U1-D3 — Feature réservations client | déplacer la liste, le détail et l'annulation dans `apps/web/src/features/bookings/` et garder les routes comme orchestration | **Terminé le 2026-08-31** |
| 21-U1-D4 — Feature offre publique | déplacer la fiche offre, le formulaire de réservation et ses styles dans `apps/web/src/features/offers/` et garder la route comme orchestration | **Terminé le 2026-08-31** |
| 21-U1-D5 — Feature onboarding | déplacer l’entrée organisation et le parcours unifié loueur dans `apps/web/src/features/onboarding/` et garder les routes comme orchestration | **Terminé le 2026-08-31** |
| 21-U1-D6 — Feature liste flotte | déplacer la présentation de la liste « Mes équipements » dans `apps/web/src/features/bikes/` et garder la route comme orchestration | **Terminé le 2026-08-31** |
| 21-U1-D7 — Feature fiche équipement | déplacer la fiche unifiée, ses cartes d’action et ses styles dans `apps/web/src/features/bikes/` et garder la route comme orchestration | **Terminé le 2026-08-31** |
| 21-U1-D8 — Feature assistant équipement | déplacer le wizard de configuration (identité, photos, tarif, stock, publication) dans `apps/web/src/features/bikes/setup/` et garder la route comme orchestration | **Terminé le 2026-08-31** |
| 21-U1-D9 — Feature liste établissements | déplacer la liste des points de retrait dans `apps/web/src/features/locations/` et garder la route comme orchestration | **Terminé le 2026-08-31** |
| 21-U1-D10 — Feature formulaire établissement | déplacer les champs partagés, le parsing et le parcours de création dans `apps/web/src/features/locations/` et garder les actions serveur dans la route | **Terminé le 2026-08-31** |
| 21-U1-D11 — Feature détail établissement | déplacer le détail, les horaires exceptionnels et les styles dans `apps/web/src/features/locations/` et injecter les actions serveur | **Terminé le 2026-08-31** |
| 21-U1-D12 — Feature flotte physique | déplacer la liste unitaire, les synthèses et l’ouverture de maintenance dans `apps/web/src/features/fleet/` et garder la route comme orchestration | **Terminé le 2026-08-31** |
| 21-U1-D13 — Feature atelier | déplacer la liste des interventions et l'historique dans `apps/web/src/features/fleet/maintenance/` et garder la lecture Core dans la route | **Terminé le 2026-08-31** |
| 21-U1-D14 — Feature dossier maintenance | déplacer le détail du dossier et la remise en service dans `apps/web/src/features/fleet/maintenance/` et garder l'autorisation/lecture dans la route | **Terminé le 2026-08-31** |
| 21-U1-D15 — Feature planning opérationnel | déplacer la vue planning et la vue flotte hebdomadaire dans `apps/web/src/features/planning/` et garder l'autorisation, les filtres et la lecture Core dans la route | **Terminé le 2026-08-31** |
| 21-U1-D16 — Feature opérations réservation | déplacer la fiche opérationnelle et les flux de départ, retour et annulation dans `apps/web/src/features/operations/` et garder l'autorisation et la lecture Core dans la route | **Terminé le 2026-08-31** |
| 21-U1-D17 — Feature équipe | déplacer la présentation des membres et invitations dans `apps/web/src/features/team/` et garder la lecture, les permissions et les Server Actions dans la route | **Terminé le 2026-08-31** |
| 21-U1-D18 — Feature réglages | déplacer les vues entreprise et politiques dans `apps/web/src/features/settings/` et garder l'authentification, la lecture et les Server Actions dans les routes | **Terminé le 2026-08-31** |
| 21-U1-D19 — Feature amendements loueur | déplacer la vue d’amendement, le formulaire, la prévisualisation et les helpers dans `apps/web/src/features/operations/amendment/` et garder l’autorisation, les contrôles d’état et les lectures Core/DB dans la route | **Terminé le 2026-08-31** |
| 21-U1-D20 — Feature finances loueur | déplacer le hub revenus, versements et onboarding Stripe Connect dans `apps/web/src/features/finances/` et garder l'authentification, le read model et la résolution de statut dans la route | **Terminé le 2026-08-31** |
| 21-U1-D21 — Feature support interne | déplacer le cockpit support et sa recherche dans `apps/web/src/features/internal/` et garder la garde plateforme et les lectures Core dans la route | **Terminé le 2026-08-31** |
| 21-U1-D22 — Fiches support internes | déplacer les fiches organisation et réservation, leurs styles et leurs actions client dans `apps/web/src/features/internal/` et garder la garde plateforme, les lectures Core et les 404 dans les routes | **Terminé le 2026-08-31** |
| 21-U1-D23 — Consoles support internes | déplacer les consoles paiements, notifications et audit, leurs styles et leurs actions client dans `apps/web/src/features/internal/` et garder la garde plateforme, les filtres et les lectures Core dans les routes | **Terminé le 2026-08-31** |

## Chantier 21-U2 — Premières surfaces universelles « Mes équipements »

**Statut : tranches techniques et cadrage livrés le 2026-09-01 — Phase 2 ouverte
uniquement sur ce périmètre ; aucune tâche de Phase 1 n'est modifiée.** ADR-034 ajoute un
registre de présentation frontend avec fallback générique obligatoire. Les
surfaces liste et fiche historiques `/bikes` consomment `categorySlug` pour
présenter `equipment` et les catégories inconnues, tout en conservant les
libellés, caractéristiques et sections spécifiques du vélo. Les gardes
d'organisation, l'isolation tenant, le modèle Produit/Variante/Exemplaire, la
disponibilité transactionnelle, les prix et les URLs restent inchangés.

| Lot | Résultat | Statut |
| --- | --- | --- |
| 21-U2-A — Registre de présentation par catégorie | libellés singulier/pluriel, caractéristiques explicites, sections spécifiques, actions principales et fallback générique ; tests vélo, `equipment`, fallback et tenant | **Terminé le 2026-09-01 — ADR-034** |
| 21-U2-B — Liste et fiche génériques | branchement limité aux surfaces « Mes équipements », états vides, titres, badges, synthèse photo et actions ; règles Photo Coach vélo conservées | **Terminé le 2026-09-01 — validation ciblée Web et typecheck** |
| 21-U2-C — Photos et maintenance par catégorie | gestionnaire photo neutre hors vélo ; Photo Coach et trois slots canoniques conservés pour le vélo ; libellés du registre dans la flotte et toutes les surfaces de maintenance ; `categorySlug` exposé par les projections concernées, sans migration ni changement de mutation | **Terminé le 2026-09-01 — tests ciblés Web/Core et CI verte de la PR #42** |
| 21-U2-D — Taxonomie outdoor fermée | contrat typé serveur : quatre univers, familles et sous-types, statuts `ACTIVE`/`APPROVED_NEXT`/`APPROVED_LATER`/`INTERNAL_FALLBACK`, inconnus `UNSUPPORTED`, modes futurs de compléments | **Livré le 2026-09-01 — ADR-035 ; PR #43 fusionnée dans `b8a7a2e`, CI complète verte ; aucune donnée historique, recherche ou publication modifiée** |
| 21-U2-E — Activation kayak | catégorie canonique `kayak`, fixture `kayak-dev`, présentation des attributs existants, parcours loueur et public réutilisant les invariants génériques | **Livré le 2026-09-01 — commit `2570a81`, PR #44, CI complète verte avec Browser acceptance ; PostgreSQL local indisponible, suites d’intégration exécutées par la CI** |
| 21-U2-F — Activation surf | famille `surf` active avec sous-types `classic`, `longboard`, `softboard`, `bodyboard`, `skimboard` ; parcours génériques loueur/public et présentation surf neutre, sans règle vélo ni champ spécialisé nouveau | **Livré le 2026-09-01 — commit `cbcebc9`, PR #45, CI complète verte avec Browser acceptance Clerk TEST ; catégorie déjà seedée, aucune migration** |
| 21-U2-G — Hardening surf des surfaces existantes | audit ciblé liste/fiche, création/édition, recherche, maintenance, photos et sous-types ; Photo Coach vélo limité au vélo, upload neutre hors vélo, `categorySlug` conservé | **Livré le 2026-09-01 — correction minimale et tests ciblés Web/Core ; aucune migration ni nouvelle catégorie** |
| 21-U2-H — Activation ski | famille `ski` active avec sous-types `alpine`, `touring`, `cross-country` ; parcours génériques loueur/public et présentation ski neutre, sans snowboard ni règle vélo | **Livré le 2026-09-01 — tests ciblés Core/Web, typechecks et `check:fast` ; catégorie déjà seedée, aucune migration** |
| 21-U2-I — Hardening ski des surfaces existantes | audit des surfaces loueur/public, variantes, photos et maintenance ; libellé historique normalisé dans création/édition, doublon de fiche supprimé, fallback et règles vélo conservés | **Livré le 2026-09-01 — correction minimale, tests ciblés Web/Core et typecheck ; aucune migration ni nouvelle catégorie** |
| 21-U2-J — Activation snowboard | famille `snowboard` active sous un seul slug ; parcours loueur/public génériques, migration canonique 0052 sans conversion de `equipment`, photos neutres et aucun sous-type ou champ spécialisé | **Livré le 2026-09-01 — tests ciblés registre/Web/Core/Database, typechecks et `check:fast` ; intégrations exhaustives déléguées à la CI** |
| 21-U2-K — Activation canoë | famille `canoe` active sous un seul slug ; parcours loueur/public génériques, migration canonique 0053 sans conversion de `equipment`, présentation nautique neutre et aucun sous-type ou champ spécialisé | **Livré le 2026-09-01 — PR #50 puis hardening PR #51 fusionnés, CI complète verte avec Browser Clerk TEST ; paddle et pédalo restent inactifs** |
| 21-U2-L — Activation paddleboard | famille interne `paddleboard` active sous un seul slug ; libellés Paddle/Stand-up paddle, options `single`/`tandem` et `rigid`/`inflatable` dans les attributs existants, migration 0054 idempotente, sans conversion de `paddle`/`equipment`, règles génériques et accessoires non autonomes | **Livré le 2026-09-01 — commit de la tranche d'activation ; validations ciblées et CI exhaustive déléguée à la PR ; pédalo inchangé** |
| 21-U2-M — Taxonomy enforcement | registre fermé serveur autoritaire pour création, changement de catégorie, publication et restauration ; sept familles `ACTIVE` acceptées ; `equipment`, `paddle`, inconnues, personnalisées, inactives et approuvées exclues des mutations et de la recherche publique ; historique lisible sans conversion | **Livré le 2026-09-01 — tests ciblés Core/Web et typechecks verts ; aucune migration ni modification des invariants ; validation exhaustive déléguée à la CI** |
| 21-U2-N — Préparation pédalo | contrat initial `pedalboat` sous une seule famille ; libellés « Pédalo » / « Pedal boat », capacité éventuelle dans les attributs existants, présentation nautique générique et photos neutres | **Clôturé le 2026-09-01 — ADR-036 conservée comme historique, remplacée pour l'activation par ADR-037** |
| 21-U2-O — Activation pédalo | famille commerciale `pedalboat` `ACTIVE`, migration idempotente 0055, libellés FR/EN, parcours loueur/public génériques, seuil universel de photos, recherche, hold, paiement TEST et réservation ; aucune conversion historique, règle spécialisée, pack ou autre catégorie | **Livré le 2026-09-01 — PR #56 fusionnée dans `9fabdad`, CI complète verte avec Browser Clerk TEST** |
| 21-U2-P — Onboarding autonome — premier équipement | parcours guidé catégorie → produit → variante → exemplaire → lieu → tarif → photos → disponibilité → publication pour les huit familles `ACTIVE`, contrôle serveur des familles et de la readiness réservable, checklist bloquante et réservation TEST post-publication ; Photo Coach uniquement pour `bike`, photos neutres ailleurs, sans packs ni opérations groupées | **Livré le 2026-09-02 — commit `80de4bb`, PR #57, CI complète verte avec Browser Clerk TEST** |
| 21-U2-Q — Duplication contrôlée d’un équipement | action générique loueur pour les huit familles `ACTIVE` ; nouveau produit `DRAFT` à slug unique, copie du catalogue et des variantes descriptives uniquement, idempotence et verrou d’organisation, checklist de publication reprise ; aucun stock, tarif, snapshot, photo, réservation, maintenance ou publication copié | **Implémenté le 2026-09-02 — validations ciblées et typechecks locaux ; CI complète et Browser Clerk TEST en attente sur la PR** |

### Recherche par intention — UX accueil et résultats (2026-08-31)

Palette transversale mise à jour à la demande du porteur de produit : gamme
`#8CB6BF`, rôles et contrastes dans le [design system](../product/design-system.md).
Propagation par les tokens Client/Pro/Support, apparences embarquées et modèles
email ; Sora, composition des pages et règles métier inchangées.

Périmètre et limites : [home-search-next-level.md](home-search-next-level.md).

- Chantier 1 : quatre critères, panneaux dédiés, calendrier inclusif avec horaires
  facultatifs, résultats directs et barre fixe au défilement de l'accueil.
- Chantier 2 : synonymes FR/EN contrôlés, catégories hiérarchiques actives réelles,
  destinations récentes de session et contexte `peopleCount` sans effet sur la
  quantité ni sur le prix. Aucun élargissement silencieux des demandes précises.
- La composition automatique, les capacités et les accessoires inclus (V3–V5 du
  document produit) ne sont **pas livrés** : décisions produit et ADR requises.
  Les prix publics restent ceux d'un équipement, avec avertissement pour les groupes.

## Chantier 20-B — Recovery & Disaster Readiness

**Statut : livré sur `chantier/20-b-recovery` depuis `origin/main` au SHA
`bd0450d05a56ccf7a7c058c7d42ac496894fa4bb` (validation finale dans le rapport
de commit).**

Le périmètre FAST ajoute un restore drill PostgreSQL local et fail-closed,
exécutable par `pnpm recovery:restore-drill`, la procédure migrations/rollback,
le registre des migrations risquées, huit runbooks d'incident et la procédure
de rotation des secrets. Aucun SQL de production, aucune migration existante,
aucun secret réel et aucun fournisseur distant n'est modifié. Voir
[`chantier-20b-recovery.md`](chantier-20b-recovery.md) et
[`docs/runbooks/`](../runbooks/).

La preuve de restauration Neon/PITR, les RPO/RTO par environnement, les droits
Vercel/Neon et les contacts d'escalade restent à confirmer par un opérateur
autorisé.

### Maintenance CI

Les actions GitHub utilisées ont signalé une dépréciation prochaine du runtime
Node.js 20 interne à certaines actions. Le dépôt exécute déjà Node.js 24 et
aucune action actuellement utilisée ne force Node.js 20 côté projet. La mise à
jour des actions concernées sera traitée comme maintenance CI non bloquante,
avant leur échéance, sans modifier le périmètre fonctionnel de G8B.

## Horizons stratégiques post-MVP — option C

> Direction approuvée par ADR-019. Cette section n'est pas une autorisation
> d'implémenter ces capacités pendant le Lot 7 et ne change pas ses dépendances.

| Horizon | Résultat recherché | Condition d'ouverture |
| --- | --- | --- |
| Equipment Graph | ontologie des équipements, usages, compatibilités, accessoires et règles de sécurité | données MVP réelles, catégories prioritaires validées, ADR dédié |
| Digital Equipment Passport | historique vérifiable d'un exemplaire, QR/NFC et interopérabilité progressive | usage opérationnel validé, accès et rétention cadrés, ADR dédié |
| Rental Intelligence | prévision de demande, flotte, maintenance et recommandations de prix explicables | données suffisantes, métrique de valeur, human-in-the-loop, privacy review |
| Agent-ready Commerce | recherche, devis, hold et checkout accessibles à des partenaires/agents autorisés | Core public stable, sécurité, consentement, protocole évalué au moment du lot |
| Réseau et circularité | distribution multicanale, entretien, transfert, reconditionnement et revente | densité et rétention prouvées, cadre juridique et modèle économique validés |

Garde-fou de planification : une fondation future n'est avancée dans le backlog
que si elle sert un besoin actuel ou évite une impasse structurelle démontrée.
