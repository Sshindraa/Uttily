# ADR-017 — Recherche publique : destination pilote, disponibilité et mesure produit

- **Statut** : Accepted — réserves non bloquantes listées
- **Date** : 2026-08-06
- **Phase** : 11 / Lot 7 — G7B : gel documentaire complet ; G7C : implémentation provisoire dans le worktree (migration 0031 non commitée, à réviser en G7C-R3) ; G7C-R3 : migration 0031 alignée (pays, destinations i18n, traductions, locations renforcées)
- **Décideurs** : Porteur produit Uttily, engineering, juridique / privacy
- **Relie à** : ADR-004, ADR-009, ADR-014, ADR-018 ; `docs/implementation/g7a-public-search-audit-and-delivery-plan.md` ; `docs/product/lot7-arbitrage.md`

> **Note de révision (2026-08-07)** : Plusieurs décisions de cet ADR ont été
> remplacées par l'arbitrage produit du 2026-08-07 et par ADR-018. Les sections
> modifiées indiquent explicitement « Remplacé par arbitrage produit du
> 2026-08-07 et ADR-018 ». Les sections non modifiées (§E éligibilité, §I
> dashboard, §J analytics, §4 contrat public mis à jour, §5 réserves
> complétées, §6, §7) restent valables. Voir `docs/product/lot7-arbitrage.md`
> pour les décisions produit approuvées et ADR-018 pour la conception de la
> tarification flexible et de la recherche temporelle.

> **Note de révision (2026-08-27)** : ADR-027 remplace la recommandation
> Geoapify par une architecture de résolution local-first, Lyon comme première
> ville produit et un benchmark local PostgreSQL/Photon/IGN avant le choix du
> fournisseur final.

## 1. Contexte et portée du gel G7B

Le Lot 7 rend l'offre exploitable côté client : recherche par destination,
période, catégorie et rayon, fiche produit publique, vue loueur du jour et quatre
mesures minimales (`docs/implementation/backlog.md:118-127`). La recherche est une
lecture informative : PostgreSQL, les blocs et
`createBookingDraftWithHold` demeurent l'autorité de l'allocation transactionnelle
(`docs/architecture/booking-and-availability.md:3-5`).

À la date de l'audit, aucune recherche ni fiche publique n'est implémentée. Les
read models catalogue et opérations existants sont internes et tenant-scopés,
notamment `getProductDetails(db, organizationId, productId)`
(`packages/core/src/catalog/read-models.ts:120-218`) et
`listOperationalBookings(db, organizationId, options)`
(`packages/core/src/fulfillment/read-models.ts:45-202`) : ils ne seront jamais
recyclés comme API publique.

G7B est un gel documentaire du contrat MVP. Il n'a créé aucun SQL, migration,
route, écran, provider analytics ni stockage d'images. G7C est le prochain groupe
et n'a pas démarré. L'acceptation des choix produit et techniques ci-dessous ne
constitue pas une validation juridique ou privacy.

## 2. État vérifié et invariants existants

`locations.geo_point` est nullable, de type `geometry(Point,4326)`, avec index
GiST (`packages/database/drizzle/0005_create_locations.sql:6-38`). Le type Drizzle
`geometryPoint` le reflète et `time_zone` IANA est obligatoire
(`packages/database/src/schema.ts:34-52,142-172`). Il n'existe ni table de
destinations, ni géocodeur, ni requête `ST_DWithin` dans le dépôt. Une location
sans coordonnées ne peut donc pas figurer dans une recherche au rayon.

Sur une `geometry` SRID 4326, `ST_DWithin` sans cast compare des degrés et ne doit
jamais représenter un rayon en mètres. La future requête compare
`geo_point::geography` à un point SRID 4326 lui aussi casté en `geography`. L'index
GiST `geometry` existant ne garantit pas l'accélération de ce cast : tout nouvel
index exige `EXPLAIN (ANALYZE, BUFFERS)` sur données représentatives.

`findAvailableItems` écarte les blocs non supprimés `ACTIVE` et
`PAYMENT_PROCESSING` par `NOT EXISTS`
(`packages/core/src/availability/availability.ts:19-76`). La contrainte d'exclusion
GiST `no_overlapping_blocks` est l'autorité de concurrence
(`packages/database/drizzle/0017_create_inventory_blocks.sql:84-95`) ; une lecture
publique peut devenir obsolète avant le clic et n'alloue rien.

## 3. Décisions acceptées par G7B

### A. Destination

> Remplacé par arbitrage produit du 2026-08-07 et ADR-018.

- Le premier pays activé est la France. L'architecture doit permettre une
  activation progressive : autres pays européens puis reste du monde. Aucun
  pays n'est codé en dur dans le Core. L'activation d'un pays est explicite et
  fail-closed.
- La recherche doit accepter à terme une ville, région, adresse ou point
  d'intérêt. Le Core ne dépend directement d'aucun fournisseur de géocodage.
  Une interface future du type `GeocodingProvider` est conçue.
- Geoapify est le candidat recommandé pour le dev et le premier MVP (couverture
  internationale, coût initial faible, offre gratuite annoncée). Le fournisseur
  définitif reste soumis à tests de qualité en France, conditions de
  stockage/réutilisation et validation contractuelle/privacy. Mapbox doit
  rester remplaçable sans réécriture du Core. Aucun fournisseur n'est configuré
  dans ce cycle. L'instance publique Nominatim n'est pas utilisée comme backend
  de production.
- Le contrat futur d'une destination est : `publicId` stable, slug public,
  libellé, centre géographique, viewport/bounding box, état actif, ordre
  d'affichage optionnel. Une destination inactive est invalide pour une
  nouvelle recherche publique.
- La ville commerciale et les partenaires restent configurables et ne bloquent
  pas G7C. Recontextualisation : France première activation, architecture
  mondiale, activation pays explicite fail-closed.

### B. Langue

> Remplacé par arbitrage produit du 2026-08-07.

FR et EN dès le lancement. L'i18n est préparée proprement. Le contenu rédigé
par les loueurs n'est pas automatiquement traduit. Le traitement du contenu
loueur manquant dans une langue reste à préciser (traduction fournie par le
loueur, fallback vers la langue source, ou traduction assistée future).
Aucune traduction automatique opaque dans ce cycle.

### C. Recherche géographique intelligente, tri et pagination

> Remplacé par arbitrage produit du 2026-08-07.

Le simple rayon utilisateur fixe (`radiusMeters`) est remplacé par une
stratégie adaptative :

- la destination résolue fournit un centre et idéalement une bounding
  box/viewport ;
- Uttily recherche d'abord dans la zone correspondant à la destination ;
- si les résultats exacts sont insuffisants, la zone peut être élargie
  progressivement ;
- les résultats élargis ne sont jamais mélangés silencieusement aux résultats
  exacts ; ils apparaissent dans une section explicite ;
- la carte est déplaçable et zoomable ; un mouvement de carte peut relancer la
  recherche dans le viewport ;
- l'utilisateur n'a pas besoin de comprendre un rayon technique ;
- les seuils internes exacts restent configurables et seront calibrés avec des
  données réelles ;
- aucune personnalisation opaque ou profilage publicitaire au MVP.

Ordre accepté des résultats alternatifs :

1. offres répondant exactement à la zone et à la période ;
2. mêmes dates/heures, mais un peu plus éloignées ;
3. dates ou heures proches dans la même zone.

Les alternatives doivent toujours être identifiées comme telles.

Le seul tri initial reste `DISTANCE_ASC`. La pagination est exclusivement
keyset, avec l'ordre et le tuple exacts
`(rawDistanceMeters, publicProductId, publicLocationId)`. La distance brute
n'est pas arrondie ; seul l'affichage peut arrondir `distanceMeters`.
`pageSize` vaut 24 par défaut et accepte uniquement 1 à 48. Le curseur est
opaque, versionné et validé strictement ; un curseur invalide produit une
erreur typée, sans retour silencieux à la première page. Il n'y a pas
d'`OFFSET` pour le chemin public nominal.

### D. Dates, disponibilité et autorité du hold

> Remplacé par arbitrage produit du 2026-08-07 et ADR-018.

La recherche ne peut plus accepter uniquement des dates civiles. Deux
intentions sont conçues :

- `TIME_RANGE` : date et heure locales de début ; date et heure locales de fin ;
  pour les locations horaires ou forfaitaires.
- `DAY_RANGE` : date de début ; date de fin exclusive ; pour les locations sur
  plusieurs jours.

Pour chaque établissement : interpréter les entrées dans son fuseau IANA
(`locations.time_zone`) ; gérer les transitions DST ; appliquer horaires
d'ouverture ; appliquer buffers ; vérifier les blocs incompatibles ; conserver
le hold comme autorité finale. Le DTO exact reste à concevoir dans ADR-018,
sans code.

La comparaison porte sur la période étendue (avec buffers) et les blocs
chevauchants. Le checkout soumet des `customerStartAt` et `customerEndAt`
exacts. Toute modification de date ou d'heure impose une revérification serveur
exacte et un nouveau hold atomique. Des faux négatifs conservateurs sont admis ;
la recherche ne promet jamais une disponibilité plus large. La recherche reste
informative et PostgreSQL/le hold restent l'autorité.

### E. Catégories, inventaire et filtres d'éligibilité

`categoryId` est optionnel. Une catégorie sélectionnée couvre elle-même et ses
descendants actifs ; une catégorie inconnue ou inactive est une erreur typée. Les
conditions éligibles sont exclusivement `NEW`, `GOOD` et `FAIR` ; `POOR` et
`BROKEN` sont exclus. Sont aussi requis : inventaire `ACTIVE`, produit `PUBLISHED`,
variante active non supprimée à prix EUR strictement positif, organisation et
location actives, non supprimées et publiables, `pickupEnabled=true` et
`geoPoint` non nul.

Tout exemplaire est exclu lorsqu'un bloc non supprimé `ACTIVE` ou
`PAYMENT_PROCESSING` chevauche la période étendue. Le schéma actuel ne fournit pas
encore d'IDs publics explicites, de modèle destination, de `publicDisplayName`
d'organisation, ni de drapeau distinct actif/public pour la location. Ce sont des
travaux G7C, pas des faits existants.

### F. Résultat public, prix affiché et non-divulgation

> Remplacé par arbitrage produit du 2026-08-07 et ADR-018.

Un résultat expose une disponibilité booléenne seulement, jamais un compte
exact. Dans les résultats correspondant à une demande précise : afficher le
prix total calculé pour la durée demandée ; afficher le plan retenu ; exemple
« 4 h — forfait demi-journée — 45 EUR » ; ne pas afficher seulement un vague
« à partir de » lorsqu'une durée a été fournie. Avant choix d'une durée, un
prix indicatif peut être affiché, mais doit être clairement qualifié. Les
routes n'exposent que les IDs publics ou slugs requis par le contrat public et
reposent sur des read models publics dédiés.

Sont exclus exactement : identifiants primaires internes, SKU, numéros de série,
emails, données client, données Stripe ou paiement, notes internes, snapshots
financiers et informations opérationnelles privées. Les UUID et les read models
internes ne sont pas des identifiants publics.

### G. Identité publique et adresse

> Remplacé par arbitrage produit du 2026-08-07.

G7C introduira des `publicId` stables pour destinations, produits et locations.
Seuls IDs publics et slugs figureront dans les routes. Une organisation devra avoir
un champ `publicDisplayName` avant qu'une offre soit publique ; `legalName` n'est
jamais un fallback automatique. Pour un établissement publiquement listé
(`is_publicly_listed = true`), l'adresse exacte est affichée avant réservation.
Une location privée ou non publique ne doit jamais apparaître dans la recherche.
Aucun SKU, numéro de série, note interne, email ou donnée opérationnelle privée
n'est exposé. Les projections de lecture publiques sont dédiées.

### H. Fiche produit et photos

> Remplacé par arbitrage produit du 2026-08-07.

Au moins trois photos sont obligatoires avant la publication publique d'un
produit. L'absence de trois photos empêche l'apparition publique du produit.
Les consignes dépendent à terme de la catégorie du matériel. Exemples : planche
de surf (dessus, dessous, rails) ; vélo (vue complète, transmission,
freins/pneus) ; caméra (face avant, connectique, accessoires). Le tutoriel
guidé et l'UX de prise de photos sont reportés à un groupe UI ultérieur. G7C ne
crée pas de table photo. Les documents transactionnels restent strictement
privés et les images publiques relèvent d'une frontière distincte. Le
fournisseur/domaine CDN, les limites finales et la politique d'upload restent
différés.

### I. Signal dashboard minimal

G7G fournit un signal scoped organisation lorsque l'inventaire est
`ACTIVE` et `BROKEN`, ou lorsqu'un bloc `MAINTENANCE` est actif maintenant ou
commence dans les 24 prochaines heures. Il ne crée ni `MaintenanceRecord`, ni
changement automatique, ni workflow de dommages ouverts.

### J. Mesure produit minimale

> Précisé par arbitrage produit du 2026-08-07 : analytics first-party,
> privacy-gated.

Les statistiques sont internes first-party : recherches, résultats trouvés,
tentatives, réservations confirmées. Aucune IP, email, GPS brut ou
fingerprint. Aucune publicité comportementale. La production est désactivée
tant que privacy/rétention/consentement ne sont pas validés.

Les trois seuls événements sont `PUBLIC_SEARCH_PERFORMED`, `BOOKING_ATTEMPTED` et
`BOOKING_CONFIRMED`. Une recherche réussie génère au maximum une écriture
analytics. La télémétrie de recherche est append-only, bornée, non critique, sans
outbox obligatoire ni garantie exactly-once ; elle est dédupliquée au mieux par
`searchId`, fail-open et observable. Les deux événements de réservation sont écrits
transactionnellement et idempotemment avec leur mutation.

Les quatre formules sont exactement :

1. recherches = `count(PUBLIC_SEARCH_PERFORMED)` ;
2. résultats disponibles = `count(PUBLIC_SEARCH_PERFORMED where hasResults=true)` ;
3. tentatives de réservation = `count(BOOKING_ATTEMPTED)` ;
4. réservations confirmées = `count(BOOKING_CONFIRMED)`.

Le contenu de l'événement `PUBLIC_SEARCH_PERFORMED` est adapté au nouveau
contrat : `searchId`, `searchIntentType` (`TIME_RANGE` ou `DAY_RANGE`),
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
ledger analytics Uttily. En développement, aucun
provider payant n'est utilisé ; analytics désactivées ou synthétiques sont admises.
Aucune collecte de production ne commence avant validation privacy/juridique.

## 4. Contrat public accepté, non implémenté

> Mis à jour par arbitrage produit du 2026-08-07 et ADR-018.

| Entrée | Contrat accepté |
| --- | --- |
| destination | résolue via géocodeur provider-neutral futur (interface `GeocodingProvider`), centre + viewport/zone adaptative ; Geoapify candidat recommandé |
| dates | `TIME_RANGE` (date/heure locales début et fin) ou `DAY_RANGE` (date début, date fin exclusive) ; voir ADR-018 §8 |
| catégorie | `categoryId` optionnel ; elle-même et descendants actifs ; inconnue/inactive = erreur typée |
| zone | recherche adaptative par viewport/zone (remplace `radiusMeters`) ; élargissement progressif si résultats insuffisants ; alternatives dans une section explicite |
| prix | prix total calculé pour la durée demandée + plan retenu affiché (remplace `from` journalier) ; voir ADR-018 §7 et §14 |
| tri | `DISTANCE_ASC` uniquement |
| pagination | keyset seulement ; `pageSize` défaut 24, 1 à 48 ; curseur opaque, versionné, strict |

Toute entrée invalide produit une erreur typée sans fallback. Une recherche valide
sans résultat retourne `items: []` et `nextCursor: null`. La stratégie SQL future
est une requête en ensemble/CTE, sans N+1, utilisant le filtre geography, les
buffers, les filtres d'éligibilité et le tuple keyset accepté. Tout index éventuel
reste conditionné à `EXPLAIN (ANALYZE, BUFFERS)`.

## 5. Réserves différées et frontières d'activation

> Complété par arbitrage produit du 2026-08-07.

| Réserve différée | Blocage exact | Ne bloque pas |
| --- | --- | --- |
| Ville commerciale (premier lancement public configuré en France) | premier lancement public configuré et son contenu | G7C–G7G |
| Publication juridique des termes | publication des termes et activation production de G7F | socle G7C–G7E |
| Consentement, rétention et agrégation analytics | activation production de G7H uniquement | G7C–G7G |
| Fournisseur et domaine CDN | livraison réelle d'images publiques dans G7F | G7C |
| Limites finales d'image et politique d'upload | upload/livraison réelle d'images dans G7F | G7C |
| Workflow complet de maintenance | workflow de maintenance ultérieur uniquement | signal minimal G7G et G7C–G7F |
| Fournisseur de géocodage final et droits de stockage/cache | géocodage réel en production G7D/G7E | G7C |
| Conditions de stockage/cache des résultats de géocodage | géocodage réel en production G7D/G7E | G7C |
| Traduction du contenu libre des loueurs (FR+EN) | affichage multilingue complet G7E/G7F | G7C–G7D |

Aucune de ces réserves ne bloque G7C. Elles n'emportent aucune validation juridique
ou privacy ; les validations nécessaires restent à obtenir aux frontières indiquées.

> **Note G7C-R3 (2026-08-07)** : G7C-R3 : terminé le 2026-08-07 (upgrade/
> rollback tests, defaults pays, trigger traductions, statut). La migration 0031
> a été alignée en place (table `countries`, destinations i18n avec `country_code`
> / `place_type` / `bbox_*`, table `destination_translations`, triggers
> `check_destination_activation` et `protect_destination_required_translations`,
> renforcement de `locations_public_listing_requirements`). Tests complets
> (`schema-lot7.test.ts`, 67 tests). Pas de migration 0032. Le prochain groupe
> est G7P-A (fondations des plans tarifaires). G7D dépend de G7C-R3 et G7P-B.

## 6. Critères de review G7I

La validation transversale devra couvrir : metres `geography` et SRID ; dates
locales/DST par location ; buffers adjacents, fin exclusive à minuit et buffers
franchissant une date ; deux fuseaux ; catégories et filtres ; keyset sur distance
brute non arrondie ; absence de N+1 ; autorité concurrente du hold ; non-divulgation
publique ; accessibilité ; et plans SQL représentatifs pour chaque index envisagé.

## 7. Références factuelles

- Critères Lot 7 : `docs/implementation/backlog.md:118-127`.
- Géographie : `packages/database/drizzle/0005_create_locations.sql:6-38` ;
  `packages/database/src/schema.ts:34-52,142-172`.
- Disponibilité et autorité de blocage :
  `packages/core/src/availability/availability.ts:19-76` ;
  `packages/database/drizzle/0017_create_inventory_blocks.sql:84-127`.
- Hold/allocation : `packages/core/src/booking-drafts/create-booking-draft.ts:34-47`.
- Catalogue/identifiants : `packages/database/src/schema.ts:384-492` ;
  `packages/database/drizzle/0011_create_products.sql:25-43`.
- Read models internes : `packages/core/src/catalog/read-models.ts:45-217` ;
  `packages/core/src/fulfillment/read-models.ts:25-202`.
- Métriques worker : `apps/worker/src/metrics.ts:1-99`.
