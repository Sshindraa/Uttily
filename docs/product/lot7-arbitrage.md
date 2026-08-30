# Lot 7 — Arbitrage produit : révision produit et architecture après arbitrage

- **Statut** : Décisions produit approuvées
- **Date** : 2026-08-07
- **Autorité** : Porteur produit Uttily
- **Relie à** : ADR-009, ADR-017, ADR-018 ; `docs/implementation/g7a-public-search-audit-and-delivery-plan.md`

## Objet

Ce document consigne les décisions produit définitivement approuvées par le
porteur produit le 2026-08-07, dans le cadre de la révision du Lot 7 après
arbitrage. Il remplace ou étend les décisions antérieures d'ADR-017 et
d'ADR-009 lorsque celles-ci sont explicitement marquées comme obsolètes. Les
décisions ci-dessous distinguent les choix produit approuvés des réserves
juridiques et fournisseurs qui restent ouvertes.

Aucun code, SQL, schéma TypeScript, migration, test, UI ou configuration de
fournisseur n'est modifié dans ce cycle. Ce document est purement
documentaire.

## Décisions approuvées

### 1. Déploiement géographique

- Premier pays activé : France.
- L'architecture doit permettre une activation progressive : autres pays
  européens puis reste du monde.
- Aucun pays n'est codé en dur dans le Core.
- L'activation d'un pays est explicite et fail-closed.
- EUR uniquement au lancement. L'architecture monétaire est compatible avec
  plusieurs devises. Aucune conversion de devise n'est implémentée dans le
  premier MVP. Les taux de change, les arrondis, les paiements cross-currency
  et les payouts sont traités par une décision ultérieure.
- Une réservation conserve toujours les montants et la devise réellement
  utilisés.

### 2. Langues

- FR et EN dès le lancement. L'i18n est préparée proprement.
- Le contenu rédigé par les loueurs n'est pas automatiquement traduit.
- Le traitement du contenu loueur manquant dans une langue reste à préciser
  (traduction fournie par le loueur, fallback vers la langue source, ou
  traduction assistée future). Aucune traduction automatique opaque dans ce
  cycle.

### 3. Géocodage

- La recherche doit accepter à terme une ville, région, adresse ou point
  d'intérêt.
- Le Core ne dépend directement d'aucun fournisseur. Une interface future du
  type `GeocodingProvider` est conçue.
- Geoapify est le candidat recommandé pour le dev et le premier MVP :
  couverture internationale, coût initial faible et offre gratuite annoncée.
- Le fournisseur définitif reste soumis à : tests de qualité en France ;
  conditions de stockage/réutilisation ; validation contractuelle et privacy.
- Mapbox doit rester remplaçable sans réécriture du Core.
- Aucun fournisseur n'est configuré dans ce cycle. L'instance publique
  Nominatim n'est pas utilisée comme backend de production.

Faits fournisseurs vérifiés le 2026-08-07 sur documentations officielles :

- Geoapify : <https://www.geoapify.com/pricing/> — offre gratuite avec limites
  (3 000 crédits/jour selon la page pricing au 2026-08-07) ; usage commercial
  gratuit seulement avec certaines limitations et demande de contacter
  Geoapify pour les détails ; attribution OpenStreetMap obligatoire ;
  attribution Geoapify obligatoire sur le plan Free ; société établie à
  Chypre ; services annoncés comme hébergés dans des centres de données de
  l'UE (selon communication fournisseur, à vérifier) ; collecte technique des
  requêtes API, notamment headers, IP et timestamp ; conservation généralement
  inférieure ou égale à 24 h pour les requêtes réussies selon leur politique
  (<https://www.geoapify.com/privacy-policy/>). Sources officielles :
  <https://www.geoapify.com/terms-and-conditions/>,
  <https://www.geoapify.com/privacy-policy/>,
  <https://www.geoapify.com/pricing/>,
  <https://www.geoapify.com/pricing-details/>. Réserves : les droits de
  stockage/cache/réutilisation des résultats restent à confirmer
  contractuellement ; Geoapify reste un candidat, pas un fournisseur
  définitivement approuvé ; l'offre gratuite de production comporte des
  limitations non détaillées ; privilégier une intégration serveur/proxy pour
  protéger la clé et limiter l'exposition directe du visiteur ; aucune
  conclusion juridique « GDPR compliant » ne doit être affirmée uniquement sur
  la base de la communication du fournisseur ; les conditions doivent être
  revérifiées avant production.
- Mapbox : <https://www.mapbox.com/pricing/> — 100 000 requêtes gratuites/mois
  pour le géocodage TEMPORAIRE (résultats non stockables/cacheables) ;
  géocodage PERMANENT (stockage/cache autorisé) sans niveau gratuit,
  5 USD/1 000 (1-500k). <https://docs.mapbox.com/api/search/geocoding/>.
  Données hébergées US (EU-U.S. Data Privacy Framework). Réserves : modèle
  temporary/permanent ; DPA GDPR ; vendor lock-in.
- Nominatim public (OSM) :
  <https://operations.osm.org/policies/nominatim/> — service « principalement
  pour la barre de recherche OSM », capacité très limitée, max 1 RPS / 4 RPM
  pour scripts, bulk geocoding « non encouragé », risque de blocage,
  obligation de pouvoir changer de service à la demande d'OSMF, licence ODbL.
  La politique OSMF recommande elle-même des alternatives pour usages
  réguliers ou volumineux.

Les quotas ci-dessus reflètent les documentations officielles consultées le
2026-08-07 et ne sont pas présentés comme permanents.

### 4. Recherche géographique intelligente

Le simple rayon utilisateur fixe est remplacé par une stratégie adaptative :

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

### 5. Identité publique et adresse

- Afficher le nom commercial du loueur. `publicDisplayName` est la source
  publique. Aucun fallback automatique vers `legalName`.
- Pour un établissement publiquement listé, afficher l'adresse exacte avant
  réservation.
- Une location privée ou non publique ne doit jamais apparaître.
- Aucun SKU, numéro de série, note interne, email ou donnée opérationnelle
  privée n'est exposé.

### 6. Disponibilité et stock

- Afficher uniquement un état de disponibilité. Ne pas exposer le nombre exact
  d'exemplaires.
- Le hold PostgreSQL reste l'autorité finale.
- Les résultats alternatifs ne constituent jamais une promesse de réservation.
- Les buffers de préparation et nettoyage continuent de s'appliquer.

### 7. Photos

- Au moins trois photos obligatoires avant la publication publique d'un
  produit.
- L'absence de trois photos empêche l'apparition publique du produit.
- Les consignes dépendent à terme de la catégorie du matériel.
  Exemples : planche de surf (dessus, dessous, rails) ; vélo (vue complète,
  transmission, freins/pneus) ; caméra (face avant, connectique, accessoires).
- Le tutoriel guidé et l'UX de prise de photos sont reportés à un groupe UI
  ultérieur.
- Aucune table photo n'est créée dans ce cycle.
- Les documentations antérieures indiquant que les photos sont facultatives
  (ADR-017 §H et g7a §3.3) sont obsolètes et corrigées.

### 8. Modèle tarifaire accepté

Le modèle actuel limité à `dailyPriceAmountMinor` ne couvre plus le besoin. Un
modèle futur par variante reposant sur des plans tarifaires est conçu dans
ADR-018.

Types minimums acceptés :

- `HOURLY` : prix par heure ; durée minimale ; durée maximale ; incrément de
  facturation explicite.
- `FIXED_DURATION` : durée exacte incluse en minutes ; prix total fixe ; label
  public (ex. 2 heures, demi-journée, 6 heures, journée).
- `DAILY` : prix par jour civil ; plusieurs jours ; paliers de réduction.

Forfaits de référence : demi-journée = 4 heures ; journée = plage commerciale
de référence de 8 heures ; forfaits personnalisés possibles (2 h, 6 h, etc.).
Le loueur choisit les offres disponibles pour sa variante.

Uttily ne doit pas utiliser une IA ou un modèle probabiliste pour déterminer un
montant financier. Le moteur tarifaire est : déterministe, auditable,
reproductible, testé, calculé côté serveur, figé dans le snapshot de
réservation.

Sélection tarifaire :

- le client saisit son besoin de durée ;
- le moteur charge uniquement les plans actifs et compatibles avec la variante,
  la devise, la location et la période ;
- il écarte les plans qui ne couvrent pas la durée ;
- il calcule le prix total de chaque plan éligible avec la même précision ;
- il sélectionne le total le moins cher ;
- en cas d'égalité exacte, il applique des tie-breakers déterministes (forfait
  exact, plus petite durée incluse couvrant la demande, moins de temps
  inutilisé, identifiant/version stable) ;
- il ne présente pas plusieurs calculs contradictoires ;
- il affiche le plan retenu et le détail du total.

Exemples :

- demande de 2 h : forfait 2 h utilisé s'il existe et est applicable, sinon
  tarif horaire ;
- demande de 4 h : forfait demi-journée proposé directement s'il existe ;
- demande de 5 h : le forfait 4 h ne couvre pas la demande ; un forfait 6 h
  peut être utilisé s'il existe et constitue la meilleure formule éligible ;
  sinon le forfait journée 8 h est utilisé ; sinon une erreur typée est
  retournée (aucun plan couvrant) ; le plan horaire n'est pas retombé si sa
  limite `maxDurationMinutes` est dépassée ;
- un client payant la journée mais retirant le matériel tardivement ne
  bénéficie d'aucun report automatique de la restitution.

### 9. Cohérence tarifaire

Refuser une grille où un forfait plus long coûte moins cher au total qu'un
forfait plus court comparable. Le prix effectif par heure ou par jour peut
diminuer avec la durée. Mais, pour une même variante/devise/contexte :

- le montant total ne doit pas décroître lorsque la durée couverte augmente ;
- les plans actifs ne doivent pas créer d'ambiguïté financière ;
- les chevauchements et règles de sélection doivent être déterministes.

Les contraintes garantissables en PostgreSQL, dans une mutation
transactionnelle et dans le moteur tarifaire sont comparées et recommandées
dans ADR-018. Aucun SQL n'est rédigé dans ce cycle.

### 10. Réductions multi-jours

Le loueur peut définir des paliers en pourcentage. Exemples : à partir de 3
jours −10 % ; à partir de 7 jours −20 % ; à partir de 14 jours −25 %.

Règles : paliers strictement croissants en nombre de jours ; pourcentages
strictement supérieurs à 0 et strictement inférieurs à 100 ; montant final
strictement positif ; un seul palier actif par seuil et par plan `DAILY` ;
pas de cumul ; seul le meilleur palier applicable est utilisé ; total après
réduction non décroissant lorsque la durée augmente ; résultat arrondi selon
une règle déterministe en unités mineures ; détail visible dans le calcul du
prix ; snapshot figé à la réservation. La règle d'arrondi recommandée (half-up)
est une recommandation technique étudiée et documentée dans ADR-018 sans être
implémentée.

### 11. Recherche temporelle

La recherche ne peut plus accepter uniquement des dates civiles. Deux
intentions sont conçues :

- `TIME_RANGE` : date et heure locales de début ; date et heure locales de fin ;
  pour locations horaires ou forfaitaires.
- `DAY_RANGE` : date de début ; date de fin exclusive ; pour locations sur
  plusieurs jours.

Pour chaque établissement : interpréter les entrées dans son fuseau IANA ;
gérer les transitions DST ; appliquer horaires d'ouverture ; appliquer buffers ;
vérifier les blocs incompatibles ; conserver le hold comme autorité finale. Le
DTO exact reste à concevoir dans ADR-018, sans code.

### 12. Retrait et restitution

Locations horaires et forfaits courts : heure de retrait prévue ; heure de
restitution prévue ; tolérance de retard au retrait 30 minutes par défaut ; le
retard ne décale jamais automatiquement l'heure de restitution ; une
prolongation nécessite une nouvelle vérification de disponibilité.

Demi-journée : durée tarifaire incluse (`included_duration_minutes`,
référence 4 heures) ; plage commerciale applicable (commercial window) avec
heure locale de début, heure locale de fin et jours de semaine concernés ;
retrait possible pendant cette plage ; heure de fin inchangée.

Journée : durée tarifaire incluse (`included_duration_minutes`, référence
8 heures) ; plage commerciale fixe définie par le loueur (référence 8 heures,
ex. 9 h–17 h) avec heure locale de début, heure locale de fin, jours de
semaine concernés et fuseau IANA de la location ; compatible avec
`location_opening_hours` ; retrait possible à n'importe quel moment pendant
cette plage ; si le client retire à 13 h, il ne dispose plus que de 4 h ; le
tarif n'est pas recalculé ; la restitution reste à 17 h ; aucun report
automatique. Une journée achetée pour 9 h–17 h et retirée à 13 h reste
payable intégralement et finit à 17 h.

Lorsque plusieurs plages commerciales sont possibles pour un même plan (ex.
demi-journée matin 9 h–13 h, demi-journée après-midi 13 h–17 h, journée
9 h–17 h), une table ou fonction de fenêtres tarifaires rattachée au plan et
à la location est recommandée. Aucun SQL n'est rédigé dans ce cycle.

Plusieurs jours : retrait pendant les horaires prévus du premier jour ;
restitution avant l'heure prévue du dernier jour ; toute prolongation exige une
nouvelle disponibilité et une mutation atomique.

### 13. Annulation et modification

Les politiques standardisées sont conservées : Flexible, Modérée, Ferme. Le
loueur choisit une politique pour son organisation au MVP.

Ajout pour les réservations horaires faites tardivement : courte fenêtre
d'annulation gratuite de 30 minutes après confirmation ; uniquement si le début
de la location est encore à au moins 2 heures ; aucune promesse juridique
implicite ; validation juridique toujours requise avant production.

Modification d'horaire : autorisée si le nouvel horaire est disponible ;
nouvelle vérification serveur ; remplacement atomique des blocs/allocations
concernés ; idempotence obligatoire ; aucun état partiel ; aucun changement
silencieux du snapshot financier ; si le prix change, le traitement
paiement/remboursement exige une conception séparée avant implémentation. Les
modifications de réservation avec variation financière sont séparées dans un
groupe futur dédié (G7M ou G7P-C), car elles dépendent d'une conception
paiement/remboursement encore ouverte. Les modifications de réservation ne sont
pas implémentées dans ce cycle.

### 14. Prix affiché

Dans les résultats correspondant à une demande précise : afficher le prix total
calculé pour la durée demandée ; afficher le plan retenu ; exemple « 4 h —
forfait demi-journée — 45 EUR » ; ne pas afficher seulement un vague « à partir
de » lorsqu'une durée a été fournie ; avant choix d'une durée, un prix
indicatif peut être affiché, mais doit être clairement qualifié.

### 15. Analytics

Statistiques internes first-party : recherches, résultats trouvés, tentatives,
réservations confirmées. Aucune IP, email, GPS brut ou fingerprint. Aucune
publicité comportementale. La production est désactivée tant que
privacy/rétention/consentement ne sont pas validés.

## Réserves juridiques et fournisseurs

Les décisions produit ci-dessus sont approuvées, mais les sujets suivants
restent ouverts et doivent être résolus avant les activations correspondantes :

- Validation juridique des annulations horaires (fenêtre gratuite de 30 min) —
  bloque l'activation production.
- Validation contractuelle et privacy du fournisseur Geoapify — bloque le
  géocodage réel en production.
- Conditions de stockage/cache des résultats de géocodage — bloque le
  géocodage réel.
- Fournisseur de géocodage définitif — bloque le géocodage réel après tests de
  qualité en France.
- Traduction du contenu libre des loueurs (FR+EN) — bloque l'affichage
  multilingue complet.
- Futures devises et conversion — bloque l'activation de pays hors EUR.
- Fiscalité par pays — bloque l'activation de pays hors France.
- Limites et traitement technique des images — bloque la livraison réelle des
  photos.

## Exemples concrets

### Surf — planche de surf

- Photos obligatoires : dessus, dessous, rails (trois photos minimum avant
  publication publique).
- Tarification : forfait demi-journée 4 h à 25 EUR par exemple. Le client
  demande 4 h, le forfait demi-journée est proposé directement.
- Retrait : plage fixe configurée pour la demi-journée ; retrait possible
  pendant cette plage ; heure de fin inchangée. Si le client retire tard, le
  retard ne décale pas l'heure de restitution.

### Velo — velos en location

- Photos obligatoires : vue complète, transmission, freins/pneus (trois photos
  minimum avant publication publique).
- Tarification : forfait journée 8 h, plage commerciale 9 h–17 h. Le client
  paie la journée. S'il retire à 13 h, il ne dispose plus que de 4 h ; le tarif
  n'est pas recalculé ; la restitution reste à 17 h ; aucun report
  automatique.
- Réductions multi-jours possibles : à partir de 3 jours −10 % ; à partir de 7
  jours −20 %.

### Camera — materiel photo/video

- Photos obligatoires : face avant, connectique, accessoires (trois photos
  minimum avant publication publique).
- Tarification : forfait 2 h ou tarif horaire. Le client demande 2 h : le
  forfait 2 h est utilisé s'il existe et est applicable, sinon le tarif horaire
  s'applique.
- Retrait : tolérance de retard au retrait de 30 minutes par défaut ; le retard
  ne décale jamais automatiquement l'heure de restitution.

## Contradictions identifiees

### Avec ADR-009

ADR-009 (2026-07-28) établit un modèle daily-only : `daily_price_amount_minor`
sur `product_variants` (ADR-009:169), prix par jour civil, nullable = variante
non réservable (ADR-009:179). Le post-MVP prévoyait « tarifs saisonniers,
paliers (demi-journée, semaine), tarification horaire via table de tarifs
dédiée » (ADR-009:187). Le calcul exclusif par jours civils (ADR-009:53, 262)
et l'unique `dailyPriceAmountMinor` sont remplacés par les plans tarifaires
d'ADR-018. Les montants en unités mineures, EUR initial, le snapshot, le hold,
la concurrence et l'idempotence sont conservés.

### Avec ADR-017

ADR-017 (2026-08-06) contient plusieurs décisions obsolètes :

- §A destination : « pas de géocodeur externe ni GPS client au MVP initial »
  (ADR-017:59-60) — remplacé par géocodage provider-neutral + Geoapify
  candidat.
- §A : « centre géographique » seul (ADR-017:62) — étendu vers centre +
  viewport/bounding box.
- §B langue : « français langue initiale du MVP... sans implémentation FR+EN
  dans le Lot 7 » (ADR-017:67-70) — remplacé par FR+EN dès le lancement.
- §C rayon : `radiusMeters` 1 à 50 000 m, défaut 10 000 m (ADR-017:74-76) —
  remplacé par recherche adaptative par viewport/zone.
- §D dates : `startDate`/`endDate` `YYYY-MM-DD` uniquement, 1 à 31 jours
  (ADR-017:88) — remplacé par `TIME_RANGE` + `DAY_RANGE`.
- §F : `from` = prix journalier minimal (ADR-017:123) — remplacé par prix
  total calculé pour la durée demandée + plan retenu.
- §H photos : « photos facultatives... absence de photo ne bloque pas la
  publication » (ADR-017:141) — remplacé par trois photos obligatoires avant
  publication publique.

### Avec le code actuel

Les contradictions suivantes sont documentées dans ADR-018 et ne sont pas
modifiées dans ce cycle :

- `packages/database/src/schema.ts:485` : `daily_price_amount_minor` uniquement
  (daily-only).
- `schema.ts:486,500` : CHECK `currency = 'EUR'` (bloque multi-devises futur,
  mais EUR only reste valide au lancement).
- `packages/core/src/pricing/calculate-price.ts:51,107` : `billableUnit`
  hardcodé `'DAY'`.
- `calculate-price.ts:78-82,109` : validation stricte `currency !== 'EUR'`
  produisant une erreur.
- `packages/core/src/pricing/types.ts:49` : `billableUnit` type littéral `'DAY'`
  uniquement.
- `packages/core/src/pricing/civil-days.ts:83-126` : jours civils uniquement,
  pas de `TIME_RANGE`/`DAY_RANGE`.
- `packages/core/src/availability/availability.ts:19-76` : `tstzrange` sur
  `startAt`/`endAt`, pas de `TIME_RANGE`/`DAY_RANGE`.
- `packages/core/src/booking-drafts/create-booking-draft.ts:643,722` :
  `billableUnit` hardcodé `'DAY'`.
- Aucune table photos, aucune colonne photo.
- Aucune colonne viewport/bbox sur destinations.
- Aucune colonne countryCode sur destinations (existe sur
  `locations.country_code` schema.ts:194, nullable).
- `locations.time_zone` IANA existe (schema.ts:189, not null) — valide.
- `locations.is_publicly_listed` existe (fail-closed défaut false) — valide.
- `organizations.public_display_name` existe (nullable, CHECK non vide) —
  valide.
- `destinations` table créée par 0031 (public_id, slug, label, center,
  is_active, sort_order, deleted_at) — valide mais incomplète (pas de
  viewport/bbox, pas de countryCode, pas de type de lieu, pas de modèle de
  traductions des destinations par locale).
- Disponibilité booléenne déjà en place (pas de stock exact exposé) — valide.

## Impact sur la migration 0031

À la date de rédaction de cet arbitrage, la migration 0031
(`packages/database/drizzle/0031_lot7_public_search_foundations.sql`) n'était
pas encore commitée. La recommandation de la corriger en place plutôt que de
créer une migration additive 0032 a été appliquée dans G7C-R3.

La migration 0031 est désormais suivie, alignée et validée. Ce passage est
conservé comme justification historique ; il ne décrit pas un travail restant.
