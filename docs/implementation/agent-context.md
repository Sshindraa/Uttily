# Contexte d'implémentation pour les agents

## Direction stratégique durable

La direction approuvée est l'**option C** (ADR-019) : Uttily devient
progressivement une infrastructure mondiale de l'accès au matériel combinant
OS loueur, marketplace, intelligence opérationnelle et distribution par
partenaires ou agents autorisés. Lire
`docs/product/long-term-vision.md` avant toute conception touchant l'IA, la
recherche, les actifs physiques, les intégrations ou les API publiques.

Cette direction ne permet pas d'ajouter spontanément des fonctionnalités hors
MVP. Elle impose surtout de préserver les identités stables, la provenance, les
événements métier, le versioning, l'exportabilité et la distinction entre faits,
recommandations automatisées et décisions humaines. PostgreSQL et les use cases
restent l'autorité. Aucun modèle d'IA ne peut contourner les autorisations, la
disponibilité, les snapshots financiers ou l'idempotence.

## Ce qui est construit

Le premier produit Uttily permet à un client de rechercher, réserver, payer puis récupérer un équipement auprès d'un loueur professionnel. Le loueur peut administrer son entreprise, ses établissements, son catalogue, ses exemplaires physiques et ses opérations de location.

Le produit ne cherche pas encore à couvrir toutes les catégories, tous les pays ni la location entre particuliers.

## Personae et permissions

| Persona | Peut faire |
| --- | --- |
| Visiteur | Rechercher et consulter l'offre publique. |
| Client | Réserver, payer, consulter ou annuler selon la politique applicable. |
| Owner | Gérer son organisation, ses établissements, son équipe et son activité. |
| Admin loueur | Gérer catalogue, prix, réservations et employés selon ses droits. |
| Employé | Préparer, remettre, réceptionner et signaler un problème sur le matériel. |
| Admin Uttily | Assister et administrer la plateforme selon un accès audité. |

Un même utilisateur peut être client et membre de plusieurs organisations. Les rôles sont déterminés dans la base Uttily, jamais uniquement dans le fournisseur d'identité.

## Modules initiaux

| Module | Responsabilité |
| --- | --- |
| Identity & Organizations | Utilisateurs, organisations, membres, rôles et établissements. |
| Catalog & Inventory | Produits, variantes, photos et exemplaires physiques. |
| Availability | Blocages, maintenance, recherche d'exemplaires et concurrence. |
| Pricing | Règles de prix, taxes, options et snapshots. |
| Pricing Plans | Moteur de tarification flexible (G7P-B1) : plans HOURLY/FIXED_DURATION/DAILY, devis read-only déterministe, arrondi half-up, résolution default/local, paliers multi-jours. G7P-B2-A Round 3 : fondations du schéma de snapshot flexible (migration 0033, colonnes sur booking_drafts/bookings/booking_draft_lines/booking_lines, contraintes CHECK exactes, `source_draft_line_id` FK DEFERRABLE + unicité, copie exacte root `bookings` → `booking_drafts`, copie exacte `booking_lines` via la source explicite, pas de re-validation du catalogue, triggers DEFERRABLE INITIALLY DEFERRED sur INSERT et UPDATE de `status`, immutabilité renforcée, concurrence prouvée par `pg_advisory_lock` et `pg_stat_activity`). G7P-B2-B Round 2 terminé et validé : intégration dans `createBookingDraftWithHold` (union discriminée legacy/flexible, dispatch fermé, transition DRAFT → HELD, SET CONSTRAINTS ciblé, resolvedLocale du moteur, PricingWindowSnapshot persisté et validé par trigger, billableUnitCount du moteur, isolation erreurs DB PRICING_CONTEXT_UNAVAILABLE, 72 tests d'intégration). G7P-B2-C implanté (migration des flux existants) : `applyBookingConfirmation` copie tous les champs flexibles (root + lines) depuis `booking_drafts`/`booking_draft_lines` vers `bookings`/`booking_lines`, `initiatePayment` valide `pricingSnapshotVersion` fail-closed (seules `legacy-daily-v1` et `flexible-pricing-v1` acceptées), document data loader (`load-document-render-data.ts`) sélectionne les champs flexibles pour les réservations flexibles uniquement, parser de snapshot (`parse-snapshot.ts`) accepte les nouvelles clés optionnelles, 22 tests d'intégration, aucune migration 0034 nécessaire (0033 a déjà toutes les colonnes et triggers). G7D-A (recherche publique) terminé : `searchPublicOffers` dans `packages/core/src/public-search/` (TIME_RANGE/DAY_RANGE, Bbox exact, keyset pagination, lookahead SQL, checkpoint de scan, batching pricing/dispo, curseur HMAC 32 octets, payload strict, cursorCodec fail-closed, 83 tests). |
| Bookings | Brouillons, holds, réservations, annulations et transitions d'état. |
| Payments & Deposits | Paiements, webhooks, remboursements, cautions et journal financier. |
| Fulfillment & Maintenance | Retrait, retour, état, dommages, retard et maintenance. Server Actions sécurisées (préparer, remettre, réceptionner, clôturer, rapport d'état, déclaration de dommage) avec autorisation serveur, idempotence et defense in depth (ADR-011, G4A). Interface dashboard des opérations terrain : liste, fiche détaillée, transitions, rapports d'état et dommages (ADR-011, G4B). |
| Notifications & Documents | Emails, contrats, reçus, QR codes et outbox. Architecture des documents transactionnels (ADR-013) : schéma PostgreSQL et contrats TypeScript livrés (G5B) ; read model documentaire, snapshot de rendu v1 figé, parser BOOKING_CONFIRMED.v1 strict, canonical JSON déterministe, fake renderer technique, tests unitaires et PostgreSQL livrés (G5C) ; module commun claim/lease/fencing, ObjectStorage fake, pipeline A/B/C, outbox_effects avec storage_key, tests d'intégration PostgreSQL livrés (G5D) ; pipeline d'emails transactionnels idempotent avec FakeTransactionalEmailSender, notification_deliveries, clés d'idempotence sans PII, recipient_email figé, transitions PENDING→SENT/FAILED, backoff, max attempts, finalisation PROCESSED, tests unitaires (16) et d'intégration PostgreSQL (40) livrés (G5E) ; intégration worker et observabilité livrées et validées (G5F). Suite worker : 441 tests au total avec PostgreSQL local (399 passed, 42 skipped sans DATABASE_URL), 0 failed — réellement tournés avec PostgreSQL local. Audit outbox-claim : 4 tests multi-tenant (4 passed, 0 skipped). Suite Core complète : 1494 passed, 0 failed, 0 skipped. Artefact Node exécutable (esbuild). API publique nettoyée : testing utils dans @uttily/core/testing, validateOutboxBatchLimit, phaseCPersist privée. Fournisseurs de production choisis par ADR-014 (Cloudflare R2 stockage juridiction `eu`, Resend email avec idempotence native 24 h + politique fail-closed) ; adapter R2 implémenté, testé G5H-A et câblé au worker G5H-C2C-B3 ; adapter Resend implémenté, testé G5H-B et câblé au worker G5H-C2C-B3 ; politique retry < 24 h et fail-closed conçue G5H-C1, implémentée G5H-C2A/C2B/C2C-A. Credentials R2 et Resend non configurés, bucket non créé, domaine non configuré, aucun email réel envoyé. Worker techniquement assemblé et bundle smoke-testé (câblage production livré G5H-C2C-B3, smoke test du bundle compilé livré G5H-C2C-B4). Fournisseurs non configurés, aucun déploiement effectué ; déploiement VPS et configuration réelle = lot distinct post-B4. **G5H-C1 (conception finale verrouillée)** : politique d'idempotence Resend < 24 h et fail-closed conçue et documentée dans ADR-013 §13. Décisions verrouillées : cutoff à 23 h (`PROVIDER_IDEMPOTENCY_WINDOW_SECONDS = 82 800`) ; nouvel état `REQUIRES_MANUAL_REVIEW` dans `notification_delivery_status` (immuable par le worker, résoluble par humain uniquement via use case administratif futur) ; nouvelle colonne `provider_first_attempt_started_at` (timestamptz, nullable, immuable une fois renseignée, persistée en Phase B avant appel externe) ; nouveaux failure codes `PROVIDER_RESULT_UNCERTAIN` et `EMAIL_RETRY_WINDOW_EXPIRED` (NOUVEAU) ; contrat Core `EmailSendResult` (discriminated union `SENT | DETERMINISTIC_REFUSAL | TRANSIENT_NOT_SENT | UNCERTAIN`, adapters conformes retournent `EmailSendResult` + pipeline Core conserve try/catch défensif autour de `await sender.send()` normalisant en `UNCERTAIN`) ; retry idempotent des résultats `UNCERTAIN` < 23 h avec même `providerIdempotencyKey` et même payload si `attempts < MAX_ATTEMPTS` ; mapping Resend complet (14 cas) ; machine d'états exhaustive (35 cas) ; migration 0029 unique transactionnelle (remplacement contrôlé des enums via rename + recreate + cast texte + drop old dans une seule migration — cible PostgreSQL 16, journal 28 → 29 migrations PAS 30, découpage en deux fichiers interdit car le runner Drizzle drizzle-orm 0.36.4 exécute toutes les migrations en attente dans une transaction commune) ; budget de retry email séparé basé exclusivement sur `outbox_effects.attempt_count` de l'effet `SEND_EMAIL` (pas `outbox_events.attempt_count` qui est un compteur de claims/observabilité) ; finalizer DB-only indépendant du claim normal pour crash après MAX_ATTEMPTS (`PROVIDER_RESULT_UNCERTAIN`) et cutoff 23 h sans appel (`EMAIL_RETRY_WINDOW_EXPIRED`), aucun appel fournisseur, `FOR UPDATE SKIP LOCKED`, invariant absolu aucune 6e requête fournisseur ; invariant de réservation atomique Phase B (lock + vérifications + incrément + timestamp + commit avant appel) ; exclusion du claim automatique pour `REQUIRES_MANUAL_REVIEW` + branche DB sûre pour delivery vieillissante (âge ≥ 23 h, aucun appel fournisseur) ; résolution manuelle atomique future (deux transactions administratives atomiques, pas de SQL manuel partiel). Aucun code, SQL, schéma TypeScript, pipeline, adapter ou worker modifié dans G5H-C1 — phase de conception uniquement. **G5H-C2 livré (C2A, C2B, C2C-A, C2C-B1, C2C-B2, C2C-B3, C2C-B4) ; câblage production livré G5H-C2C-B3 ; smoke test local du bundle compilé livré G5H-C2C-B4** : migration 0029 unique, mise à jour du contrat Core, mise à jour de l'adapter Resend, mise à jour du pipeline, finalizer DB-only, tests unitaires et d'intégration PostgreSQL. **G5H-C2A livré** : fondation PostgreSQL de la politique email fail-closed — schéma Drizzle mis à jour (enums `notification_delivery_status` + `document_processing_failure_code`, colonne `provider_first_attempt_started_at`, CHECK constraints `REQUIRES_MANUAL_REVIEW`, index partiels), migration 0029 unique transactionnelle (remplacement contrôlé des enums sans `ALTER TYPE ADD VALUE`, recréation des triggers et CHECK constraints), tests PostgreSQL réels (enums synchronisés, transitions d'état, immutabilité du timestamp, invariants CHECK, migration depuis 0028 avec conservation des données). |

## Stack de départ

- Next.js et TypeScript pour l'interface, le rendu serveur et les endpoints.
- PostgreSQL + PostGIS pour les données et la recherche géographique.
- ORM à choisir au premier lot, avec migrations SQL inspectables.
- Connexions Neon distinctes (G5G-C) : `DATABASE_URL` (endpoint pooled, runtime)
  et `DATABASE_DIRECT_URL` (endpoint direct, migrations Drizzle Kit uniquement).
  Le helper `resolveMigrationUrl` rejette fail-closed une `DATABASE_URL` distante
  sans `DATABASE_DIRECT_URL` et une `DATABASE_DIRECT_URL` contenant `-pooler`.
- Stockage objet compatible S3 pour photos et documents — Cloudflare R2 juridiction `eu` (ADR-014).
- Stripe Connect pour les paiements ; aucune carte bancaire n'est stockée par Uttily.
- Fournisseur OIDC (Clerk — ADR-006) pour l'identité ; autorisation métier dans PostgreSQL.
- Outbox PostgreSQL et worker séparé pour les tâches différées (VPS DigitalOcean Frankfurt, ADR-014).
- Email transactionnel via Resend avec idempotence native 24 h + politique fail-closed (ADR-014).

## Contrat de données

- Tous les montants : `amount_minor` entier et `currency` ISO 4217.
- Tous les instants : UTC. Chaque établissement possède un `time_zone` IANA.
- Toutes les tables liées à un loueur portent `organization_id`.
- Les identifiants sont des UUID v4 générés par PostgreSQL via `gen_random_uuid()`.
- Les documents, appels de paiement et webhooks conservent la référence du fournisseur externe.
- Les snapshots de réservation et les écritures du registre financier sont immuables.

## Définition de terminé

Une tâche est terminée lorsque :

1. ses critères du backlog sont satisfaits ;
2. les autorisations serveur sont appliquées ;
3. les tests appropriés passent ;
4. aucune règle de concurrence ou de multi-tenant n'est contournée ;
5. la documentation et les migrations sont à jour ;
6. le changement reste dans le périmètre du MVP.

## Statut G5H

- G5H-C2A : livré.
- G5H-C2B : livré et validé.
- G5H-C2C-A : livré (finalizer DB-only des emails, intégration au cycle worker, observabilité, validations vertes).
- G5H-C2C-B1 : livré (décision et conception du renderer PDF, ADR-015).
- G5H-C2C-B2 : livré (renderer PDF pdf-lib implémenté, police Inter embarquée, 3 templates v1, reproductibilité binaire prouvée inter-processus/source-dist/TZ, tests unitaires + tests pipeline PostgreSQL). G5H-C2C-B3 livré (câblage production createWorkerDependenciesFromEnv avec validation fail-fast, composition R2/Resend/pdf-lib/PostgreSQL, shutdown idempotent DB+R2, gestion SIGTERM/SIGINT via startWorker injectable, 69 tests index). G5H-C2C-B4 livré (Round 3) (smoke test local fake/mock du bundle compilé apps/worker/dist/index.js : harness apps/worker/scripts/smoke-built-worker.mjs importe le bundle esbuild, vérifie les exports, démarre startWorker avec fakes, émet SIGTERM factice, vérifie shutdown unique + retrait listeners, timeout ferme référencé 5000 ms (exit 70 si dépassé), terminaison naturelle au succès (pas de process.exit(0)), scrub des variables d'environnement fournisseur avant import, vérification de l'absence d'effets de bord à l'import (exitCode, listeners, console) avec capture des effets console différés via setImmediate pendant et après l'import, validation stricte de --timeout-ms (regex ^[0-9]+$ + Number.isSafeInteger + borne [50, 10000], fail-closed exit 64 sans interpolation), fileParallelism: false dans vitest.config.ts pour sérialiser les tests manipulant dist, 11 tests subprocess (bundle absent exit 2, hang/timeout exit 70 via fixture dev-only, succès exit 0 naturel avec stdout exact et stderr vide, console synchrone détectée exit 1, console différée setImmediate détectée exit 1, validation --timeout-ms exit 64 pour 5 cas invalides, fixtures absentes de dist) ; commandes smoke:built, smoke et smoke:verify ; 69 tests index, 441 tests worker au total avec PostgreSQL local (399 passed, 42 skipped sans DATABASE_URL)). Déploiement VPS et configuration réelle = lot distinct post-B4 (non livré).
- worker : techniquement assemblé et bundle smoke-testé (câblage production createWorkerDependenciesFromEnv livré G5H-C2C-B3, finalizer C2C-A livré, renderer PDF C2C-B2 livré, smoke test du bundle compilé livré G5H-C2C-B4). Fournisseurs non configurés, aucun déploiement effectué. Déploiement VPS et configuration réelle (Neon, R2, Resend, secrets, Docker) = lot distinct post-B4.

## Statut G5I

- G5I-A : Packaging Docker implémenté, validé statiquement ET en runtime Docker (G5I-B). Livrables : `Dockerfile.worker` (multi-stage 4 stages builder/runtime-base/validation/production, `node:24-slim`, production = stage par défaut = dernier FROM), `.dockerignore` (règle générale `**/.env*` avec exception `!**/.env.example`), `docker-compose.worker.yml` (durcissement : non-root UID/GID 1001, read_only, cap_drop ALL, no-new-privileges, mem_limit 512m, cpus 1.0, stop_grace_period 2m, logging json-file roté, env_file externe), `apps/worker/.env.example` (modèle versionnable à valeurs factices), guide ops `docs/implementation/g5i-a-worker-local-packaging.md`, test de validation statique `apps/worker/src/docker-packaging.test.ts` (71 tests, sans daemon Docker). Correctif packaging : `postgres` déplacé de `devDependencies` à `dependencies` dans `apps/worker/package.json` (dépendance runtime externalisée par esbuild, importée par `dist/index.js`). Police Inter TTF copiée dans le stage runtime-base (`/app/assets/fonts/`) car chargée depuis disque au runtime par le renderer PDF. **Aucun déploiement exécuté.** G5I-A : validation statique uniquement (daemon Docker non démarré). G5I-B : Colima démarré avec autorisation, validations Docker runtime EXÉCUTÉES avec succès (Docker Engine 29.5.2, Compose 5.3.1) : build, inspection, smoke, échec config, Compose !override, démarrage PostgreSQL éphémère + SIGTERM (532ms, exit 0). Correctifs runtime G5I-B : `pnpm deploy --legacy` (pnpm v10) et chemins absolus pour `COPY --from=builder`. Suite worker : 449 tests au total (407 passed, 42 skipped sans DATABASE_URL ; 449 passed, 0 skipped avec DATABASE_URL), 0 failed. Déploiement VPS réel = lot distinct futur.

## Statut G5J

- G5J-A/G5J-B : ADR-016 (Accepted) — audit_log append-only. G5J-A : étude, comparaison d'options (A/B/C/D), décision (Option A : FK `ON DELETE RESTRICT` + trigger). G5J-B : implémentation — migration 0030 (`DROP + ADD CONSTRAINT`, fonction `prevent_audit_log_mutation`, trigger `prevent_update_delete_audit_log`), schéma Drizzle `onDelete: 'restrict'`, tests dédiés (`schema-audit-log.test.ts` : structure, comportement, TRUNCATE, rejeu, migration 0029→0030, rollback), cleanup `identity.test.ts` (retrait `db.delete(auditLog)` inutile), compteurs 29→30. Soft-delete utilisateur uniquement au MVP ; hard-delete fail-closed. Politique RGPD suppression/anonymisation = décision juridique séparée (open-questions.md).

### État laissé par le crash de la cinquième tentative

- `SEND_EMAIL.attempt_count = 5`.
- `notification_deliveries.status = 'PENDING'`.
- `outbox_events.status = 'PROCESSING'` avec une `lease` expirée.
- Le claim `READY_FOR_TRANSACTIONAL_EMAIL` ne sélectionne plus cet événement (budget SEND_EMAIL épuisé).
- Le finalizer DB-only de G5H-C2C-A est responsable de le faire passer en `REQUIRES_MANUAL_REVIEW`.

### Atomicité du finalizer DB-only

- Chaque candidat est finalisé dans un savepoint PostgreSQL distinct.
- Si la revalidation, le cardinal d'un SELECT ou d'un UPDATE échoue, le savepoint est roulé entièrement vers l'arrière : aucune mutation partielle n'est persistée.
- Un candidat incohérent n'empêche pas les autres candidats du batch d'être finalisés.
- `inconsistentCount` compte tout candidat sélectionné par le `FOR UPDATE SKIP LOCKED` initial mais qui n'a pas pu être finalisé atomiquement après verrouillage et revalidation (lignes manquantes, statuts invalides, échec de cardinalité d'UPDATE, etc.).
- `inconsistentCount` compte également les combinaisons statut/lease incohérentes sélectionnées sous verrou : `PENDING` avec une `lease` non nulle, et `PROCESSING` sans `lease`.
- Les combinaisons structurellement interdites par la contrainte PostgreSQL (un seul de `lease_token` / `lease_until` NULL) ne sont pas simulées ni prétendues couvertes.

## Statut G7B-R3

- G7B-R3 (arbitrage produit et ADR-018) : cycle courant. Décisions produit
  approuvées le 2026-08-07, consignées dans `docs/product/lot7-arbitrage.md`.
  France première activation, architecture mondiale, activation pays explicite
  fail-closed. FR+EN dès le lancement. Trois photos obligatoires avant
  publication publique. Tarification flexible par plans tarifaires
  (`HOURLY`/`FIXED_DURATION`/`DAILY`) conçue dans ADR-018.
  ADR-018 (tarification flexible, recherche temporelle, modifications de
  réservation) : Accepted — conception approuvée, implémentation non démarrée.
  ADR-009 et ADR-017 révisés. g7a, open-questions, backlog et architecture mis
  à jour. Aucun code, SQL, schéma, migration, test ou UI modifié dans ce cycle.
- Sujets juridiques et de paiement explicitement réservés : annulations
  horaires, modification avec changement de prix, fournisseur géocodage final,
  futures devises, fiscalité par pays.

## Statut G7C

- G7C-R3 : migration 0031 alignée en place (pays, destinations i18n, traductions,
  locations renforcées, tests complets). **G7C-R3 : terminé le 2026-08-07.**
  (validation des tests upgrade/rollback et corrections effectuée). Pas de migration
  0032. La migration 0031 crée : table `countries` (country_code PK, is_active
  DEFAULT false, default_currency NOT NULL sans DEFAULT, default_locale NOT NULL
  sans DEFAULT), table `destinations` modifiée (sans label, avec country_code FK,
  place_type, center, bbox_south/west/north/east, is_active, sort_order,
  deleted_at), table `destination_translations` (destination_id FK ON DELETE
  CASCADE, locale, label, UNIQUE(destination_id, locale)),
  organizations.public_display_name, products.public_id, locations.public_id +
  is_publicly_listed (contrainte renforcée avec address_line1, city, country_code),
  triggers d'immutabilité + check_destination_activation +
  protect_destination_required_translations, index. Tests dédiés
  `schema-lot7.test.ts` (67 tests). Schéma Drizzle `schema.ts` aligné (tables
  countries, destinations, destination_translations ; types Country, NewCountry
  exportés).
- G7P-A Round 2 (fondations PostgreSQL des plans tarifaires) : terminé le
  2026-08-07 (schéma uniquement). Migration 0032 (corrigée en place) crée
  l'enum `pricing_lifecycle_state` (DRAFT/ACTIVE/RETIRED), les tables
  `pricing_plans`, `pricing_plan_windows`, `multi_day_discount_tiers`,
  `pricing_plan_translations`, la colonne `locations.operating_currency`
  (backfill depuis `organizations.default_currency`). Clé métier excluant la
  version, cycle de vie fermé DRAFT→ACTIVE→RETIRED, immutabilité après
  activation, résolution default/local indépendante du numéro de version,
  traductions FR+EN requises pour l'activation, fenêtres et paliers gelés
  dans la version, weekday_mask 1–127, paliers threshold >= 2 avec monotonie,
  montants <= 9007199254740991. `daily_price_amount_minor` conservé pour
  compatibilité Core (double lecture transitional). Le prochain groupe est
  G7P-B (moteur de calcul).
- G7D-A (Core `searchPublicOffers`) : terminé — 83 tests, Bbox exact, keyset pagination, lookahead SQL, checkpoint de scan, batching pricing/dispo, curseur HMAC 32 octets, payload strict, cursorCodec fail-closed, TIME_RANGE/DAY_RANGE. Dépend de G7C-R3 et G7P-B2.
- G7F-A2 (métadonnées photo et gate de publication) : terminé. Migration 0034
  (enum `product_photo_file_state`, table `product_photos` avec FK composite
  multi-tenant, contraintes CHECK d'état exhaustif, bornes nullables, index
  unique partiel sur checksum, index unique global sur storage_key, fonction
  `count_valid_product_photos`, trois triggers : `check_product_publication_photos`
  CONSTRAINT TRIGGER DEFERRABLE, `guard_product_photo_deletion` BEFORE UPDATE OR
  DELETE avec court-circuit, `guard_product_photo_immutability` BEFORE UPDATE).
  Schéma Drizzle aligné (`productPhotoFileState` pgEnum, `productPhotos` pgTable,
  types `ProductPhotoRecord`/`NewProductPhotoRecord`).
  `PostgresPhotoPublicationGate` implémenté (batch, fail-closed
  `PUBLICATION_GATE_UNAVAILABLE`, aucune entrée vide sans SQL).
  `deleteProductPhoto` implémenté (transaction, SELECT FOR UPDATE, multi-tenant,
  idempotence, aucun outbox event).
  `collectPublicationFailures` étendu (seuil 3 photos valides distincts).
  69 tests (47 schéma, 9 gate, 7 delete, 3 concurrence, 3 collect) tous passing.
  Aucun R2, aucun worker, aucun outbox photo, aucune UI, aucun G7E.
- G7E-A (Web public sans fournisseur externe) : implémenté le 2026-08-09 ;
  G7E-B (carte et viewport) implémenté dans son prolongement.
  Route `/{locale}/search` (`fr`/`en`), formulaire `DAY_RANGE`/`TIME_RANGE`,
  destinations actives et traduites chargées par le Core, filtre catégorie,
  résultats exacts accessibles, pagination keyset HMAC fail-closed et endpoint
  `GET /api/public/search` no-store. Le moteur G7D-A est câblé avec le
  `PostgresPhotoPublicationGate` G7F-A2 réel. Secret obligatoire
  `PUBLIC_SEARCH_CURSOR_SECRET` (minimum 32 octets). G7E-B ajoute la carte
  MapLibre/MapTiler progressive, la relance explicite par viewport, les curseurs
  liés à la zone et les sections EXACT/VIEWPORT_ALTERNATIVE. Voir
  `docs/implementation/g7e-b-public-search-map.md` et ADR-021.
- G7G (dashboard loueur) : implémenté le 2026-08-09. Le read model Core
  `listMaintenanceDashboardSignals` est organization-scoped, read-only et borné
  ; il projette les exemplaires `BROKEN` et les blocs `MAINTENANCE` actifs ou
  commençant dans les 24 heures, applique les bornes `[start, end)`, l'isolation
  PostgreSQL et l'ordre déterministe. `/dashboard/[orgId]` rend les trois types
  de signaux avec le fuseau IANA et un lien vers le détail inventaire. Tests
  unitaires et intégration PostgreSQL dédiés ajoutés ; aucun workflow de
  maintenance ou changement de schéma n'est introduit.
- G7H-A (fondations analytics produit) : implémenté le 2026-08-10. Migration
  0035 introduit `product_analytics_events` (raw ledger append-only, rétention
  90 jours via trigger PostgreSQL) et `product_analytics_daily` (agrégats
  quotidiens ne contenant que des compteurs sans identifiant source, soumis à
  validation privacy, rétention 24 mois). Modèle de compaction : compteurs
  compactés accumulent les événements supprimés, compteurs totaux (publics) =
  compacted + raw restant. Advisory lock `pg_advisory_xact_lock` par (day,
  environment) partagé entre agrégation et purge. Décodeur bigint runtime
  (`decodeNonNegativeBigInt`) valide les valeurs avant conversion. Le module Core
  `packages/core/src/product-analytics/` expose `recordProductAnalyticsEvent`,
  `aggregateProductAnalyticsDays`, `purgeExpiredProductAnalytics` et
  `getProductAnalyticsSummary`. Quatre mesures : `searches`,
  `searchesWithResults`, `bookingAttempts`, `bookingsConfirmed`. Tests
  unitaires et intégration PostgreSQL dédiés (incluant concurrence réelle à
  deux connexions). ADR-022 Accepted. Activation
  production bloquée par question ouverte G7B-R3 (consentement, validation
  privacy/juridique). Voir
  `docs/implementation/g7h-a-analytics-foundations.md`.
- G7H-B (cablage des evenements analytics) : implante le 2026-08-10. Trois
  evenements cables dans les parcours applicatifs reels :
  `PUBLIC_SEARCH_PERFORMED` (apres une recherche publique reussie, sourceId =
  `crypto.randomUUID()` capture une fois par execution),
  `BOOKING_ATTEMPTED` (apres `reserveKey` et avant la transaction metier,
  sourceId = `reservation.record.id`, partage LEGACY/FLEXIBLE via helper),
  `BOOKING_CONFIRMED` (dans la transaction de confirmation apres outbox, isole
  par savepoint, sourceId = `bookingId`, occurredAt = `confirmedAt` retourne
  par PostgreSQL). Enregistreur best-effort `safeRecordAnalyticsEvent` /
  `safeRecordAnalyticsEventInTransaction` avec union fermee
  RECORDED/DUPLICATE/DISABLED/FAILED, jamais de rethrow. Resolveur d'environnement
  pur `resolveAnalyticsEnvironment` : DEVELOPMENT/TEST autorises, PRODUCTION
  toujours DISABLED, aucun flag ne peut l'activer. Aucune donnee sensible
  collectee. ADR-022 amende (section 2.8). Voir
  `docs/implementation/g7h-b-analytics-wiring.md`.
- G7M-B2-B2A livré et validé le 2026-08-13 : moteur Core
  `REFUND_REQUESTED.v1` tenant-safe avec claim borné, leases/fencing, provider
  hors transaction, metadata refund fermée, retries et projection webhook
  taguée. Preuves dédiées : 12 tests unitaires, 26 tests PostgreSQL worker et
  18 tests PostgreSQL webhook tagués sélectionnés, 0 échec ; le fichier
  webhook complet passe sans skip. Régressions distinguées : 218
  tests unitaires adapters/webhook/amendment, 34 tests PostgreSQL
  `compensation-execution`, 10 tests PostgreSQL `booking-amendments`, le
  fichier webhook complet (93 tests). La suite Core complète antérieure à ce
  test de preuve non fonctionnel a passé 92 fichiers, 2 392 tests, 0 échec et
  0 skip ; aucun nouveau total Core n'est déduit. Aucun wiring worker/cron de
  production.
  Voir `docs/implementation/g7m-b2b2a-refund-execution.md`.
  G7M-B2-B2B livré : route GET `/api/cron/process-refund-requests` protégée par
  `CRON_SECRET`, validation `STRIPE_ENVIRONMENT`, appel de
  `executeRefundRequestBatch` et déclaration Vercel Cron ; aucun runtime
  `apps/worker`. Voir `docs/implementation/g7m-b2b2b-refund-cron.md`.
- G7M-C1 implémenté : `createSupplementBookingAmendment` crée localement et
  atomiquement les amendements `SUPPLEMENT/HOLD_PENDING`, les allocations et
  delta-segments, les holds de dix minutes, `amendment_payments`/attempts et
  l'outbox fermée `BOOKING_AMENDMENT_REQUESTED.v1`, sans appel Stripe. La
  preuve dédiée compte 13 tests unitaires/contrat et 10 tests PostgreSQL réels
  passés avec `DATABASE_URL`, couvrant replay, tenant, rollback, concurrence,
  source block absent et supplément sans delta physique. Le fichier est
  skippable hors CI sans PostgreSQL et ce cas n'est pas compté comme preuve.
  La validation ciblée historique C1 comptait 171/171 tests du module
  `booking-amendments` et 23/23 tests du fichier isolé
  `expire-booking-drafts-batch.test.ts`. Une première suite Core a obtenu
  2 403/2 404 avec un timeout isolé hors C1 ; la seconde a été interrompue
  avant son résumé et n'est pas revendiquée. La validation Core globale
  définitive reste pending CI. Voir
  `docs/implementation/g7m-c1-supplement-local.md`. G7M-C2 est livré et validé
  par 13/13 tests PostgreSQL réels, 7/7 tests unitaires de commission et
  90/90 tests Fake/Stripe du contrat metadata. Le module
  `booking-amendments` au jalon C2 comptait 191/191 (111 unitaires, 80
  PostgreSQL) ; le périmètre courant après C3 passe 213/213 (121 unitaires,
  92 PostgreSQL), 0 skip ;
  les tests `get-effective-booking` 25 et 31 passent isolément 1/1 chacun et
  le fichier complet passe 34/34. Les deux timeouts historiques sous charge
  module sont documentés comme intermittents et non reproduits dans cette
  validation ; aucun timeout global n'a été modifié. La validation Core globale
  définitive reste pending CI. Voir
  `docs/implementation/g7m-c2-supplement-payment.md`. G7M-C3 est implémenté
  dans le commit local empilé sur C2 : le webhook `AMENDMENT` résout les tentatives par provider ID ou
  metadata, valide l’autorité et applique atomiquement les blocks, allocations,
  segments, paiement et outbox `BOOKING_AMENDED.v1` ; `RETAIN` conserve le block
  source et `REPLACE` le remplace. Les projections `requires_action`,
  `processing`, `payment_failed` et `canceled` sont monotones ; le succès tardif
  est projeté avec un résultat interne réservé à la compensation C4. Validation
  ciblée unitaire/statique C3 verte (10/10 projection, `handleWebhook` 34/34,
  metadata 8/8, commission 7/7, delta-segments 4/4, adapters Fake/Stripe
  172/172) ; preuves PostgreSQL C3 vertes (`apply-supplement-amendment`
  12/12 et `handle-webhook` 93/93, 0 skip). Les corrections de revue restent
  locales ; la validation Core globale définitive reste pending CI. Voir
  `docs/implementation/g7m-c3-supplement-webhook.md`. G7M-C4-S est implémenté
  localement comme migration 0037 sans nouvelle table, colonne ou enum :
  `READY_TO_APPLY → EXPIRED` est autorisé et le retry
  `FAILED → PENDING_PROVIDER` exige un unique attempt N+1
  `PENDING_PROVIDER` sans provider. La preuve PostgreSQL C4-S, l'upgrade réel
  0036→0037 et l'idempotence du journal sont documentés dans
  `docs/implementation/g7m-c4s-supplement-retry-schema.md`. G7M-C4-A (expiration,
  retry N+1 et réconciliation) est implémenté localement dans Core et documenté
  dans `docs/implementation/g7m-c4a-supplement-lifecycle.md`. G7M-C4-B (compensation
  atomique des suppléments payés tardivement, wiring webhook C3, extension refund
  execution et routes cron existantes `expire-holds`/`reconcile-payments`) est
  entièrement implémenté et validé dans le worktree (non commité) par 26/26 tests Core C4-B (`supplement-compensation.integration.test.ts`),
  26/26 tests refund execution, 105/105 tests webhook & lifecycle, 11/11 tests expire-holds,
  9/9 tests reconcile-payments, 256/256 tests booking-amendments séquentiels ; documenté dans
  `docs/implementation/g7m-c4b-supplement-compensation.md`. G7M C2–C4 sont fusionnés sur main. G7M-C5-A est implémenté et validé : fonction canonique read-only `previewBookingAmendment`, types fermés, Server Action `previewBookingAmendmentAction`, interface loueur `/dashboard/[orgId]/operations/[bookingId]/amend`, tests unitaires Core (11/11), tests d'intégration PostgreSQL (10/10 sans écriture), tests Web (21/21) et build Next.js validé. Voir `docs/implementation/g7m-c5a-amendment-preview-ui.md`.

  Mise à jour G7M-C2 : la mention historique « Stripe SUPPLEMENT et UI »
  ci-dessous est supersédée pour Stripe ; seule l'UI reste à implémenter.
- ADR-017 Accepted (révisé 2026-08-07, G7C-R3 terminé le 2026-08-07). ADR-018 Accepted (G7P-A Round 2 terminé le 2026-08-07, schéma uniquement ; G7P-B2-A terminé, G7P-B2-B Round 2 terminé et validé, G7P-B2-C implanté le 2026-08-08). ADR-023 Accepted le 2026-08-10 (modifications financières append-only des réservations avant retrait, G7M/G7P-C : conception approuvée ; G7M-A livré le 2026-08-11 — schéma, migration 0036_g7m_a_amendment_schema.sql, triggers d'immutabilité et de transition, tests PostgreSQL 103 tests, voir `docs/implementation/g7m-a-amendment-schema.md` ; G7M-B1 livré le 2026-08-11 — projection canonique `getEffectiveBooking` read-only, tenant-safe, parsing JSONB validé, 46 tests unitaires + 34 tests d'intégration PostgreSQL (0 skip, preuves réelles avec PostgreSQL/PostGIS), invariant financier ADR-023 §11.2 vérifié à chaque projection avec FINANCIAL_INVARIANT_VIOLATION, voir `docs/implementation/g7m-b1-effective-booking.md` ; G7M-B2-A livré le 2026-08-12 — amendements NEUTRAL, `createNeutralBookingAmendment` transactionnel idempotent, optimistic locking `expectedLastAppliedAmendmentNumber`, append-only, outbox BOOKING_AMENDED.v1, 37 tests unitaires + 13 tests d'intégration PostgreSQL (50 tests au total), voir `docs/implementation/g7m-b2a-neutral-amendments.md` ; G7M-B2-B1 livré le 2026-08-13 — amendements REFUND avant pickup, `createRefundBookingAmendment` transactionnel idempotent avec `eventVersion: 'v1'`, clés provider `refund_amendment_${refundId}` et outbox `refund_requested_${refundId}` distinctes, payload `REFUND_REQUESTED.v1` 4 UUIDs (`{ organizationId, bookingId, amendmentId, refundId }`), statut refund `PENDING` sans appel provider à l'étape B2-B1, rollback atomique DB avec réservation idempotence `PENDING`, cap cumulatif par statut et concurrence sans deadlock, voir `docs/implementation/g7m-b2b1-refund-amendments.md` ; G7M-B2-B2A livré et validé dans `docs/implementation/g7m-b2b2a-refund-execution.md` (12 tests unitaires dédiés, 26 tests PostgreSQL worker, 18 tests PostgreSQL webhook tagués, sans skip) ; G7M-B2-B2B livré par route/cron Vercel sans runtime `apps/worker` ; reste à implémenter : Stripe SUPPLEMENT et UI ; périmètre : amendements NEUTRAL/SUPPLEMENT/REFUND sur réservation CONFIRMED uniquement, hold delta-segment 10 min pour SUPPLEMENT, application atomique directe pour NEUTRAL/REFUND, dette de remboursement visible et auditée via `FAILED_REQUIRES_MANUAL_ACTION`/`SETTLED_OFF_PLATFORM`, UI client minimale réutilisant Stripe Elements, OWNER/ADMIN/MANAGER uniquement, EUR uniquement, pas de modification à partir de READY_FOR_PICKUP ; dépendances de migration : nouvelles tables d'amendement, extension `refund_reason`/`refund_status`, adaptation `condition_reports`/`damage_reports`, route cliente de paiement).
