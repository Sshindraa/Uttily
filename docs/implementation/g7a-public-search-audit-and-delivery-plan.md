# G7A — Audit permanent et plan de livraison : recherche publique et tableau de bord

- **Date** : 2026-08-06 (révisé 2026-08-07)
- **Phase / lot** : 11 / Lot 7 — G7B-R3 : arbitrage produit et ADR-018 ; G7C-R3 suivant (non démarré)
- **Nature** : audit vérifié et plan d'architecture/livraison accepté ; G7C-R3 : migration 0031 untracked/non commitée, sera révisée
- **ADR associé** : [ADR-017](../decisions/ADR-017-public-search-destination-and-product-measurement.md) — `Accepted — réserves non bloquantes listées` (révisé 2026-08-07) ; [ADR-018](../decisions/ADR-018-flexible-rental-duration-pricing-and-modification.md) — `Accepted — conception approuvée, implémentation non démarrée`

## 1. Objet et statut

Ce rapport conserve l'état vérifié au départ du Lot 7 et porte le plan de livraison
accepté. Les décisions MVP de destination, langue, recherche, identité publique,
photos, dashboard et analytics sont verrouillées dans ADR-017 (révisé 2026-08-07) et
ADR-018. Les réserves explicitement différées ne bloquent pas G7C-R3. Aucune
validation juridique ou privacy n'est affirmée.

Le but du Lot 7 est de rendre l'offre utilisable par clients et loueurs : recherche
destination/période/catégorie/rayon, fiche publique, vue loueur du jour et quatre
mesures (`docs/implementation/backlog.md:118-127`). Aucun code, SQL final,
migration, écran, intégration, bucket ou configuration n'est inclus dans G7A/G7B.

## 2. Matrice d'audit

| Domaine / critère Lot 7 | État | Constat vérifié et référence | Livraison |
| --- | --- | --- | --- |
| Fermeture technique Lot 6 | **CONFIRMED** | préparation `CONFIRMED → READY_FOR_PICKUP`, remise `READY_FOR_PICKUP → ACTIVE`, retour `ACTIVE → RETURNED` : `packages/core/src/fulfillment/prepare-booking.ts:9-29`, `pickup-booking.ts:9-30`, `return-booking.ts:9-30` ; tests `fulfillment-transitions.integration.test.ts:1-63` | ne pas rouvrir Lot 6 |
| Rapports Lot 6 | **CONFIRMED** | rapport d'état autorisé/idempotent/audité et outbox : `create-condition-report.ts:35-53` ; dommage `ACTIVE|RETURNED`, même atomicité : `create-damage-report.ts:28-46` | aucun dommage ne crée automatiquement une maintenance |
| Documents / audit Lot 6 | **CONFIRMED** | modèle document migration 0028, pipeline testé et audit append-only migration 0030 | ne pas rouvrir Lot 6 |
| Invariants concurrence | **CONFIRMED** | exclusion GiST `no_overlapping_blocks` (`0017_create_inventory_blocks.sql:84-95`) ; hold/allocation atomiques dans `createBookingDraftWithHold` | recherche informative ; hold final seul fait foi |
| Recherche publique | **ABSENT** | aucun use case, route ou page publique ; `findAvailableItems` est interne et retourne SKU/IDs | G7C–G7E |
| Fiche produit publique | **ABSENT** | pas de route/page publique ; `getProductDetails` est tenant-scopé | G7F |
| Vue dashboard demandée | **PARTIEL** | liste opérations tenant-scopée existante et page opérations | signal minimal G7G |
| Mesures produit | **ABSENT** | `InMemoryMetricsCollector` ne mesure que cycles, documents et emails, pour tests | G7H |

Les opérations sont complètes pour le Lot 6. La limite connue est assumée : un
dommage ne modifie pas automatiquement l'exemplaire et ne crée pas de maintenance
(`operations/[bookingId]/page.tsx:171-190`).

## 3. Architecture MVP acceptée

### 3.1 Destination, langue et identité publique

> Mis à jour par arbitrage produit du 2026-08-07 et ADR-018.

Le premier pays activé est la France. L'architecture doit permettre une
activation progressive : autres pays européens puis reste du monde. Aucun pays
n'est codé en dur dans le Core. L'activation d'un pays est explicite et
fail-closed.

La recherche doit accepter à terme une ville, région, adresse ou point
d'intérêt. Le Core ne dépend directement d'aucun fournisseur de géocodage. Une
interface future du type `GeocodingProvider` est conçue. Geoapify est le
candidat recommandé pour le dev et le premier MVP (couverture internationale,
coût initial faible, offre gratuite annoncée). Le fournisseur définitif reste
soumis à tests de qualité en France, conditions de stockage/réutilisation et
validation contractuelle/privacy. Mapbox doit rester remplaçable sans
réécriture du Core. Aucun fournisseur n'est configuré dans ce cycle. L'instance
publique Nominatim n'est pas utilisée comme backend de production.

Le contrat futur d'une destination est : `publicId` stable, slug public,
libellé, centre géographique, viewport/bounding box, état actif et ordre
d'affichage optionnel. Une destination inactive est invalide pour toute
nouvelle recherche publique.

FR et EN dès le lancement. L'i18n est préparée proprement. Le contenu rédigé
par les loueurs n'est pas automatiquement traduit. Le traitement du contenu
loueur manquant dans une langue reste à préciser.

G7C-R3 introduira les `publicId` stables de destination, produit et location,
ainsi que `publicDisplayName` avant publication d'une offre. Les routes ne
portent que IDs publics ou slugs ; `legalName` ne peut jamais servir de
fallback automatique ; les projections publiques sont dédiées. Pour un
établissement publiquement listé, l'adresse exacte est affichée avant
réservation. Une location privée ou non publique ne doit jamais apparaître.

### 3.2 Recherche et disponibilité

> Mis à jour par arbitrage produit du 2026-08-07 et ADR-018.

`locations.geo_point` est nullable, de type `geometry(Point,4326)`, avec index GiST
(`packages/database/drizzle/0005_create_locations.sql:6-38`) ; `time_zone` IANA est
obligatoire (`packages/database/src/schema.ts:34-52,142-172`). Une location sans
coordonnées est exclue. Les filtres géographiques utilisent
`geo_point::geography` et un point SRID 4326 casté `geography`, donc des mètres.
Un index éventuel exige `EXPLAIN (ANALYZE, BUFFERS)` sur données représentatives.

Le contrat Core accepté est :

| Entrée | Règle acceptée |
| --- | --- |
| destination | résolue via géocodeur provider-neutral futur (interface `GeocodingProvider`), centre + viewport/zone adaptative |
| dates | `TIME_RANGE` (date/heure locales début et fin) ou `DAY_RANGE` (date début, date fin exclusive) ; voir ADR-018 §8 |
| catégorie | `categoryId` optionnel ; elle-même et descendants actifs ; inconnue/inactive = erreur typée |
| zone | recherche adaptative par viewport/zone (remplace `radiusMeters`) ; élargissement progressif si résultats insuffisants ; alternatives dans une section explicite |
| tri | `DISTANCE_ASC` uniquement |
| pagination | keyset seulement, tuple `(rawDistanceMeters, publicProductId, publicLocationId)` ; `pageSize` défaut 24, 1 à 48 ; curseur opaque, versionné, strict |

Toute entrée ou tout curseur invalide retourne une erreur typée, sans fallback, y
compris sans retour à la première page. La recherche publique nominale n'utilise pas
d'`OFFSET`. La distance brute ne s'arrondit pas ; seul `distanceMeters` est arrondi
pour l'affichage. Une recherche valide sans résultat retourne `items: []` et
`nextCursor: null`.

La recherche géographique intelligente remplace le simple rayon fixe : la
destination résolue fournit un centre et idéalement une bounding box/viewport ;
Uttily recherche d'abord dans la zone correspondant à la destination ; si les
résultats exacts sont insuffisants, la zone peut être élargie progressivement ; les
résultats élargis ne sont jamais mélangés silencieusement aux résultats exacts ; ils
apparaissent dans une section explicite. La carte est déplaçable et zoomable ; un
mouvement de carte peut relancer la recherche dans le viewport. Les seuils internes
restent configurables et seront calibrés avec des données réelles.

Ordre accepté des résultats alternatifs : (1) offres répondant exactement à la zone
et à la période ; (2) mêmes dates/heures, mais un peu plus éloignées ; (3) dates ou
heures proches dans la même zone. Les alternatives doivent toujours être
identifiées comme telles.

Pour chaque location, les entrées temporelles sont interprétées dans son fuseau
IANA, DST incluse. La requête étend ensuite exactement la période avec
`prep_buffer_minutes` et `cleanup_buffer_minutes`. Elle exclut tout bloc non
supprimé `ACTIVE` ou `PAYMENT_PROCESSING` chevauchant cette fenêtre étendue. Le
checkout fournit des `customerStartAt`/`customerEndAt` exacts ; tout changement de
date ou heure impose revérification serveur et nouveau hold atomique. La recherche
peut avoir des faux négatifs conservateurs mais ne promet jamais plus large ;
PostgreSQL et le hold restent l'autorité.

L'éligibilité exige une organisation et une location actives, non supprimées et
publiables, `pickupEnabled=true`, `geoPoint` non nul, produit `PUBLISHED`, variante
active non supprimée à prix EUR strictement positif, inventaire `ACTIVE` non
supprimé et condition `NEW|GOOD|FAIR`. `POOR` et `BROKEN` sont exclus. La requête
est en ensemble/CTE, sans N+1, et applique les catégories actives et descendants
avant de grouper produit/location.

### 3.3 Résultat public, fiche et photos

> Mis à jour par arbitrage produit du 2026-08-07 et ADR-018.

Le résultat expose une disponibilité booléenne seulement, jamais un compte
exact. Dans les résultats correspondant à une demande précise : afficher le
prix total calculé pour la durée demandée ; afficher le plan retenu ; exemple
« 4 h — forfait demi-journée — 45 EUR » ; ne pas afficher seulement un vague
« à partir de » lorsqu'une durée a été fournie. Avant choix d'une durée, un
prix indicatif peut être affiché, mais doit être clairement qualifié. Les
exclusions exactes sont : identifiants primaires internes, SKU, numéros de
série, emails, données client, données Stripe ou paiement, notes internes,
snapshots financiers et informations opérationnelles privées. Les read models
dashboard/interne ne sont jamais une source publique.

Au moins trois photos sont obligatoires avant la publication publique d'un
produit. L'absence de trois photos empêche l'apparition publique du produit.
Les consignes dépendent à terme de la catégorie du matériel. Exemples :
planche de surf (dessus, dessous, rails) ; vélo (vue complète, transmission,
freins/pneus) ; caméra (face avant, connectique, accessoires). Le tutoriel
guidé et l'UX de prise de photos sont reportés à un groupe UI ultérieur.
Documents transactionnels privés et images publiques appartiennent à des
frontières strictement distinctes. Les métadonnées photo sont ultérieures ;
le fournisseur/domaine CDN, limites finales et politique d'upload restent
différés. G7C ne crée pas de table photo.

### 3.4 Dashboard G7G

Le signal minimal est scoped organisation : inventaire `ACTIVE` avec condition
`BROKEN`, ou bloc `MAINTENANCE` actif maintenant ou commençant dans les 24 heures.
Il n'ajoute ni `MaintenanceRecord`, ni changement automatique, ni workflow de
dommages ouverts. Chaque ligne conserve le fuseau de sa location.

### 3.5 Analytics G7H

Les seuls événements sont `PUBLIC_SEARCH_PERFORMED`, `BOOKING_ATTEMPTED` et
`BOOKING_CONFIRMED`. Une recherche réussie entraîne au plus une écriture analytics.
La recherche est append-only, bornée, non critique, sans outbox obligatoire ni
exactly-once, dédupliquée au mieux par `searchId`, fail-open et observable. Les deux
événements booking sont transactionnels et idempotents avec leur mutation.

Les quatre formules sont : recherches = `count(PUBLIC_SEARCH_PERFORMED)` ; résultats
disponibles = `count(PUBLIC_SEARCH_PERFORMED where hasResults=true)` ; tentatives =
`count(BOOKING_ATTEMPTED)` ; réservations confirmées =
`count(BOOKING_CONFIRMED)`. Le payload de l'événement `PUBLIC_SEARCH_PERFORMED`
est `searchId`, `searchIntentType` (`TIME_RANGE` ou `DAY_RANGE`),
`requestedDurationBucket`, `resolvedPlaceType`, destination publique/canonique
si elle existe, stratégie de zone ou étape d'élargissement, `hasResults`,
`resultCountBucket`, `alternativesShown` (sans détail individuel), `categoryId`
ou catégorie publique autorisée, `sort`, `locale`, `environment` et
`occurredAt`.

Sont interdits : aucun texte libre brut de recherche ; aucune adresse client ;
aucune IP dans le ledger Uttily ; aucun GPS brut ; aucun fingerprint ; aucun
email ; IP, email, GPS brut, secret cookie, fingerprint, payment/Stripe,
SKU/serial interne, notes et descriptions. Le fournisseur de géocodage peut
traiter des données techniques selon sa propre politique, indépendamment du
ledger analytics Uttily. En développement, pas de provider payant
et analytics désactivées ou synthétiques admises. La collecte production ne peut pas
commencer avant validation privacy/juridique ; le consentement, la rétention et
l'agrégation bloquent cette seule activation G7H, pas G7C–G7G.

## 4. Découpage de livraison révisé (après arbitrage produit 2026-08-07)

> Remplace le découpage antérieur. La migration 0031 est untracked/non
> commitée et sera révisée en G7C-R3, pas en G7B-R3.

| Groupe | Scope | Dépendances | Hors périmètre |
| --- | --- | --- | --- |
| G7B-R3 Round 2 — Correction ciblée des incohérences documentaires | ce cycle : correctif documentaire uniquement (13 corrections sur 11 fichiers) | G7B-R3 | aucun code/SQL |
| G7C-R3 — Alignement du schéma public géographique | corriger 0031 en place (viewport/bbox, countryCode, type de lieu, modèle de traductions par locale), stratégie activation pays fail-closed, tests complets upgrade/rollback | G7B-R3 | recherche Core, géocodeur, photos, plans tarifaires |
| G7P-A — Fondations des plans tarifaires | schéma des plans, fenêtres tarifaires, versions et paliers ; tables pricing_plans + multi_day_discount_tiers + pricing_plan_windows, contraintes CHECK cohérence, migration, backfill variantes existantes vers DAILY | G7B-R3 | moteur, UI |
| G7P-B — Moteur de pricing flexible | sélection déterministe, TIME_RANGE/DAY_RANGE, DST, horaires, réductions, snapshots étendus, retrait tardif, annulations horaires | G7P-A, G7C-R3 | UI, paiement cross-currency, modifications de réservation avec variation financière |
| G7M (ou G7P-C) — Modifications de réservation financières | modifications de réservation avec variation financière (conception paiement/remboursement requise au préalable) | G7P-B, conception paiement/remboursement | UI, paiement cross-currency |
| G7D — Core/read models de recherche uniquement | use case, read models, géographie viewport adaptative, alternatives explicites, disponibilité booléenne, buffers, CTE/keyset | G7C-R3, G7P-B | web, géocodeur configuré, routes, pages, carte |
| G7E — Routes/pages/carte/i18n | page/route, UX/a11y, carte déplaçable/zoomable, relance viewport, FR+EN, alternatives séparées | G7D | dashboard, géocodeur configuré |
| G7F-A — Métadonnées photo et gating trois photos | table/colonnes photos, contrainte 3 photos obligatoires, gating publication et requête publique | G7C-R3 | UI guidée, upload réel, CDN |
| G7F-B — UI guidée photos | tutoriel par catégorie, upload, fallback | G7F-A, politique image | CDN imposé |
| G7G — Dashboard | signal minimal maintenance/BROKEN, fuseaux | G7B-R3 | workflow complet |
| G7H — Analytics | ledger first-party, 4 mesures, privacy-gated | G7B-R3, validation privacy | provider externe, collecte avant validation |
| G7I — Validation transversale | e2e, a11y, performance, concurrence, DST, snapshots | G7C-R3–G7H | réouverture Lot 6 |

Dépendances explicites : G7C-R3 dépend de G7B-R3 ; G7P-A dépend de G7B-R3 ;
G7P-B dépend de G7P-A et G7C-R3 ; G7M/G7P-C dépend de G7P-B et d'une conception
paiement/remboursement ; G7D dépend de G7C-R3 et G7P-B ; G7E dépend de
G7D ; G7F-A dépend de G7C-R3 ; G7F-B dépend de G7F-A ; G7G/G7H dépendent de
G7B-R3 ; G7I dépend de tous.

G7C-R3 est le prochain groupe. La migration 0031 n'a jamais été commitée,
partagée ou déployée ; elle est untracked dans le worktree. Elle sera corrigée
en place en G7C-R3 (viewport/bbox, countryCode, type de lieu, modèle de
traductions des destinations par locale) plutôt que par une migration
additive 0032, car aucune dette schématique n'a encore été introduite.

## 5. Axes de validation G7I

La validation devra couvrir geography/SRID, coordonnées nulles, rayon en mètres,
dates locales/DST par location, buffers adjacents, fin exclusive à minuit, buffer
franchissant une date, deux fuseaux candidats, filtres catégories/conditions/blocs,
keyset à distance brute, absence de N+1, autorité concurrente du hold,
non-divulgation, accessibilité et `EXPLAIN (ANALYZE, BUFFERS)` pour tout index.

## 6. Références principales

- Lot 7 : `docs/implementation/backlog.md:118-127`.
- Architecture disponibilité : `docs/architecture/booking-and-availability.md:3-55`.
- Transitions / rapports : `packages/core/src/fulfillment/prepare-booking.ts:9-29`,
  `pickup-booking.ts:9-30`, `return-booking.ts:9-30`,
  `create-condition-report.ts:35-53`, `create-damage-report.ts:28-46`.
- Géographie/disponibilité : `packages/database/drizzle/0005_create_locations.sql:6-38`,
  `packages/database/src/schema.ts:34-52,142-172`,
  `packages/core/src/availability/availability.ts:19-76`,
  `packages/database/drizzle/0017_create_inventory_blocks.sql:84-127`.
- Catalogue/publication : `packages/database/src/schema.ts:91-115,384-492` ;
  `packages/database/drizzle/0011_create_products.sql:25-43`.
- Métriques worker : `apps/worker/src/metrics.ts:1-99`.
