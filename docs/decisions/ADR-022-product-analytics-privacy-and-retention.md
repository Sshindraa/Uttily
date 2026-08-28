# ADR-022 — Analytics produit first-party et privacy-first

- **Statut** : Accepted
- **Date** : 2026-08-10
- **Décideurs** : Porteur produit Uttily, engineering
- **Relie à** : ADR-017, ADR-019 ; G7H-A ; G7B-R3

## 1. Contexte

Le backlog G7H demande un ledger analytics first-party pour quatre mesures
produit : `searches`, `searchesWithResults`, `bookingAttempts` et
`bookingsConfirmed`. La question ouverte G7B-R3 « Consentement, rétention et
agrégation analytics » bloque l'activation production G7H mais pas la
construction des fondations techniques.

Cette ADR décide les fondations techniques du ledger analytics. Elle ne décide
pas l'activation production, qui reste soumise à validation privacy et
juridique séparée.

## 2. Décisions

### 2.1 First-party uniquement, aucun provider externe

L'analytics produit est first-party : les événements sont stockés dans
PostgreSQL, agrégés et lus par Uttily. Aucun provider externe (Google
Analytics, Mixpanel, Segment, etc.) n'est introduit dans le périmètre MVP.

Cette décision préserve la confidentialité, évite la dépendance à un tiers et
garantit que PostgreSQL reste l'autorité transactionnelle. Un provider externe
pourra être ajouté ultérieurement via un ADR séparé.

### 2.2 Quatre mesures produit

Le ledger mesure quatre événements produit :

| Événement source | Mesures incrémentées |
| --- | --- |
| `PUBLIC_SEARCH_PERFORMED` | `searches` (+1), `searchesWithResults` (+1 si `hasResults`) |
| `BOOKING_ATTEMPTED` | `bookingAttempts` (+1) |
| `BOOKING_CONFIRMED` | `bookingsConfirmed` (+1) |

Les mesures sont des compteurs entiers non négatifs. Aucune dimension
démographique, géographique ou d'identification personnelle n'est collectée.

### 2.3 Schéma : raw ledger + agrégats quotidiens

Deux tables sont introduites :

**`product_analytics_events`** (raw ledger) :

- Append-only : INSERT uniquement, pas d'UPDATE ni de DELETE applicatif.
- Colonnes : `id` (UUID PK), `event_type` (enum), `environment` (enum
  `PRODUCTION`/`TEST`/`DEVELOPMENT`), `source_id` (UUID opaque de déduplication
  fourni par l'opération source, pas un acteur, utilisateur ou identifiant de
  session), `occurred_at` (timestamptz UTC),
  `has_results` (bool nullable, pour les recherches).
- Rétention : 90 jours calendaires UTC.
- Trigger PostgreSQL `guard_product_analytics_event_deletion` bloque tout DELETE
  d'un événement dont `occurred_at` est postérieur à `now() - interval '90
  days'`. Ce trigger utilise l'horloge PostgreSQL (`now()`), pas un paramètre
  applicatif, pour garantir que la borne de rétention ne puisse pas être
  contournée.

**`product_analytics_daily`** (agrégats quotidiens ne contenant que des compteurs sans identifiant source, soumis à validation privacy) :

- Clé métier : `(day, environment)` où `day` est une date UTC.
- Colonnes : quatre compteurs entiers non négatifs (`searches`,
  `searches_with_results`, `booking_attempts`, `bookings_confirmed`) et
  `updated_at`.
- Rétention : 24 mois calendaires.
- Aucune colonne d'identification, de session ou d'attribut personnel.

### 2.4 Environnements séparés

Les événements et agrégats portent un `environment` (`PRODUCTION`, `TEST`,
`DEVELOPMENT`). Les agrégats et résumés sont calculés et lus par environnement.
Cela permet d'isoler les données de test et de développement des données de
production sans mélanger les compteurs.

### 2.5 Purge conditionnelle : agrégat requis

La purge des événements raw n'a lieu que si l'agrégat quotidien correspondant
existe. Cette règle garantit qu'aucun événement n'est supprimé avant d'avoir
été capturé dans un agrégat. La purge est idempotente et peut être appelée
répétitivement.

### 2.6 Privacy by design

- Aucune donnée directement identifiante n'est stockée dans le ledger.
  `source_id` est un UUID technique de déduplication, jamais un `userId`,
  `sessionId`, email ou adresse.
- Selon l'opération source future, cet UUID peut rester raccordable à une
  entité métier pendant les 90 jours du raw ; il doit donc être traité comme
  une donnée pseudonyme potentielle jusqu'à sa purge.
- `source_id` disparaît des agrégats et du read model après la purge des
  événements raw (90 jours).
- Aucune qualification juridique d'anonymat ou de conformité n'est affirmée.
- Les agrégats quotidiens ne contiennent que des compteurs sans identifiant
  source, soumis à validation privacy : ils ne contiennent que des compteurs
  par jour et par environnement.
- La rétention est bornée : 90 jours pour le raw, 24 mois pour les agrégats.
  La primitive de purge `purgeExpiredProductAnalytics` (G7H-A) traite les deux
  familles. **Amendement Chantier 18-A** : la purge est désormais exécutée par
  un cron Vercel quotidien (`apps/web/vercel.json`, `17 3 * * *`) exposant
  `GET /api/cron/process-product-analytics`, qui agrège puis purge via
  `apps/web/src/lib/product-analytics-maintenance.ts`. La maintenance exclut
  `PRODUCTION` au niveau du type (`Exclude<AnalyticsEnvironment, 'PRODUCTION'>`)
  et de la valeur. La phrase d'origine (« aucun worker/cron n'est encore
  branché ») est donc caduque ; l'activation de la collecte PRODUCTION reste
  néanmoins verrouillée.
- L'activation production reste soumise à validation privacy et juridique
  séparée (question ouverte G7B-R3).

### 2.7 Modèle de compaction

La purge des événements raw est bornée par `rawLimit` (batch). Sans
compaction, des purges successives recomputent les compteurs uniquement
depuis les événements raw encore présents, ce qui perd les événements
déjà supprimés : avec 5 événements et `rawLimit=3`, la première passe
donne `total=5` puis supprime 3, la seconde recompte `total=2` (seulement
2 raw restants) et écrase l'agrégat — le résultat final est 2 au lieu de 5.

Le modèle de compaction résout ce problème en distinguant deux familles de
compteurs dans `product_analytics_daily` :

- **Compteurs totaux** (`searches`, `searches_with_results`,
  `booking_attempts`, `bookings_confirmed`) : ce sont les compteurs publics,
  exposés dans le read model (summary). Ils représentent le total historique.
- **Compteurs compactés** (`compacted_searches`,
  `compacted_searches_with_results`, `compacted_booking_attempts`,
  `compacted_bookings_confirmed`) : compteurs internes qui accumulent les
  contributions des événements raw supprimés par la purge. Ils ne sont jamais
  exposés dans le read model.

L'invariant fondamental est : `total = compacted + raw_still_present`.

- L'**agrégation** (`aggregateProductAnalyticsDays`) lit les compteurs
  compactés existants, compte les événements raw encore présents, calcule
  `total = compacted + raw`, et UPSERT les compteurs totaux sans modifier les
  compteurs compactés.
- La **purge** (`purgeExpiredProductAnalytics`) lit les compteurs compactés
  existants, compte tous les raw encore présents (avant suppression), compte
  les candidats verrouillés par type, calcule `new_compacted = old_compacted +
  candidats` et `total = old_compacted + all_raw`, UPSERT les deux, puis
  supprime uniquement les candidats.

Un **advisory lock** PostgreSQL (`pg_advisory_xact_lock`) par `(day,
environment)` est partagé entre l'agrégation et la purge pour sérialiser
les opérations concurrentes sur le même jour+environnement. Les locks sont
acquis dans un ordre déterministe (tri par day, environment) pour éviter
les deadlocks.

Les compteurs compactés ne sont pas exposés dans le read model : la fonction
`getProductAnalyticsSummary` ne retourne que les compteurs totaux.

Aucune collecte active dans les parcours applicatifs à ce stade. Production
désactivée jusqu'à validation privacy/juridique.

### 2.8 G7H-B — Cablage des trois evenements analytics (amendement)

G7H-B cable trois evenements analytics dans les parcours applicatifs reels,
en reutilisant le ledger PostgreSQL de G7H-A. Aucune nouvelle table, aucune
migration, aucun provider externe n'est introduit.

#### Definition exacte de BOOKING_ATTEMPTED

La mesure `BOOKING_ATTEMPTED` compte chaque requete :

- qui a passe la validation applicative ;
- qui a obtenu une reservation de cle d'idempotence (`reserveKey`) ;
- meme si le pricing, l'allocation ou la disponibilite echouent ensuite.

Un conflit de cle d'idempotence avec un payload different (`CONFLICT`) ne
compte **pas** : c'est une reutilisation de cle invalide, pas une tentative
legitime.

L'evenement est emis **apres** `reserveKey` et **avant** la transaction
metier. Pour les chemins `ACQUIRED`, `PENDING` et `REPLAY`, le meme
evenement stable est tente : le ledger deduplique les replays et la
concurrence via la contrainte unique `(event_type, environment, source_id)`.

- `sourceId = reservation.record.id` (UUID de l'enregistrement
  d'idempotence).
- `occurredAt = reservation.record.createdAt`.
- **Jamais** `input.idempotencyKey` comme `sourceId` : ce n'est pas garanti
  d'etre un UUID.

La meme regle s'applique aux chemins LEGACY et FLEXIBLE via une fonction
helper partagee (`emitBookingAttempted`).

#### sourceId stable par evenement

Chaque evenement a un `sourceId` technique stable qui assure la
deduplication :

| Evenement | sourceId | occurredAt |
| --- | --- | --- |
| `BOOKING_ATTEMPTED` | `reservation.record.id` (UUID idempotence) | `reservation.record.createdAt` |
| `BOOKING_CONFIRMED` | `bookingId` (UUID du booking) | `confirmedAt` retourne par PostgreSQL |
| `PUBLIC_SEARCH_PERFORMED` | `crypto.randomUUID()` (capture une fois) | `new Date()` (capture une fois) |

#### Chaque recherche serveur reussie compte separement

Chaque execution serveur reussie de la recherche publique constitue une
recherche distincte. `sourceId` et `occurredAt` sont captures une fois par
execution apres le succes de la recherche et avant l'ecriture analytics. Un
reel repeat de la meme recherche par un utilisateur doit compter a nouveau.
Aucun hashage des parametres, aucun identifiant de session, IP, user-agent
ou header de requete n'est collecte.

#### Strategie de savepoint pour BOOKING_CONFIRMED

L'evenement `BOOKING_CONFIRMED` est emis dans la transaction de confirmation
**apres** la creation du booking et l'insertion outbox
`BOOKING_CONFIRMED.v1`, **avant** le retour. L'ecriture analytics est isolee
par une nested transaction (savepoint) via `tx.transaction()` :

- Si l'INSERT analytics echoue, le savepoint est annule (ROLLBACK TO
  SAVEPOINT) mais la transaction externe reste utilisable.
- La confirmation metier (booking, outbox, conversions) n'est **jamais**
  rollbackee par une erreur analytics.
- `confirmedAt` est retourne par PostgreSQL via la clause `.returning()` de
  l'INSERT du booking, pas par `new Date()`.

Le comportement est identique pour la confirmation webhook et la
reconciliation car elles partagent `applyBookingConfirmation`.

#### Configuration DEVELOPMENT / TEST

La collecte est controlee par la variable d'environnement explicite
`PRODUCT_ANALYTICS_ENVIRONMENT` :

- `DEVELOPMENT` : collecte autorisee.
- `TEST` : collecte autorisee.
- `PRODUCTION` : **toujours DISABLED** dans G7H-B.
- Valeur absente : `DISABLED`.
- Valeur invalide : `DISABLED` avec diagnostic normalise.

Aucun mapping automatique depuis `NODE_ENV`. Aucun mapping global depuis
`STRIPE_ENVIRONMENT`. Aucun flag `PRODUCT_ANALYTICS_PRODUCTION_ENABLED`. La
resolution est pure et injectable dans les tests
(`resolveAnalyticsEnvironment`).

#### Production impossible a activer dans G7H-B

Aucun flag, aucune configuration, aucune valeur ne peut activer la collecte
`PRODUCTION` dans G7H-B. Le resolveur retourne systematiquement `DISABLED`
pour `PRODUCTION`. Cette restriction est codee en dur dans
`resolveAnalyticsEnvironment` et ne peut etre contournee par une variable
d'environnement ou un flag.

#### Isolation d'erreur (best-effort)

Un primitive Core `safeRecordAnalyticsEvent` / `safeRecordAnalyticsEventInTransaction`
retourne une union fermee :

- `RECORDED` : l'insert a reussi.
- `DUPLICATE` : un evenement identique existait deja.
- `DISABLED` : l'environnement est `DISABLED`, aucun appel DB.
- `FAILED` : une erreur a ete catchee et loggee, mais jamais relancee.

Un simple try/catch autour d'un INSERT qui echoue dans une transaction
PostgreSQL est **interdit** : la transaction resterait aborted. Le savepoint
garantit que la transaction externe reste utilisable.

Les logs sont structures et bornes : `eventType` et un code d'erreur
normalise uniquement. **Jamais** `sourceId`, parametres de recherche,
identifiants metier, message PostgreSQL ou donnees personnelles.

#### Aucune affirmation de conformite juridique

Aucune qualification juridique d'anonymat, de conformite au RGPD ou a toute
autre regulation n'est affirmee par G7H-B. Le `source_id` reste une donnee
pseudonyme potentielle jusqu'a sa purge (90 jours). L'activation production
reste soumise a validation privacy et juridique separee (G7B-R3).

## 3. Conséquences

- Migration `0035_g7h_analytics_foundations.sql` introduit les deux tables, l'enum
  `analytics_event_type`, l'enum `analytics_environment` et le trigger
  de rétention.
- Le module `packages/core/src/product-analytics/` expose les fonctions
  `recordProductAnalyticsEvent`, `aggregateProductAnalyticsDays`,
  `purgeExpiredProductAnalytics` et `getProductAnalyticsSummary`.
- G7H-B ajoute `resolveAnalyticsEnvironment`, `safeRecordAnalyticsEvent` et
  `safeRecordAnalyticsEventInTransaction` au meme module.
- L'activation production (envoi d'événements `PRODUCTION`) reste bloquée jusqu'à
  résolution de la question ouverte G7B-R3.
- Aucun provider externe, aucun SDK client, aucun cookie analytics n'est
  introduit par cette décision.
- G7H-B cable trois evenements dans les parcours applicatifs (recherche
  publique, creation de brouillon, confirmation de reservation) avec
  isolation d'erreur best-effort et savepoint pour la confirmation.
