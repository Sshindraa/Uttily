# ADR-018 — Tarification flexible par duree, recherche temporelle et modifications de reservation

- **Statut** : Accepted — G7P-A Round 2 (schema) implante, G7P-B1 (moteur de calcul read-only) implante, G7P-B2-A Round 4 (snapshot, contraintes, tests, corrections fail-closed) implante, G7P-B2-B (integration dans createBookingDraftWithHold) Round 2 termine et valide, G7P-B2-C (migration des flux existants) implante
  (sujets juridiques et de paiement explicitement reserves)
- **Date** : 2026-08-07
- **Phase** : 11 / Lot 7 — G7B-R3 : arbitrage produit et conception ; G7P-A Round 2 : schema implante (migration 0032, tables pricing_plans/pricing_plan_windows/multi_day_discount_tiers/pricing_plan_translations, enum pricing_lifecycle_state, locations.operating_currency, backfill DAILY avec traductions FR+EN)
- **Decideurs** : Porteur produit Uttily, engineering
- **Relie a** : ADR-009, ADR-017 ; `docs/product/lot7-arbitrage.md`

## 1. Contexte et contradiction avec le modele journalier actuel

ADR-009 (2026-07-28, Accepte Lot 4 technique) etablit un modele de tarification
exclusivement journalier :

- `daily_price_amount_minor` sur `product_variants` (ADR-009:169), prix par jour
  civil, nullable = variante non reservable (ADR-009:179).
- Post-MVP : « tarifs saisonniers, paliers (demi-journee, semaine), tarification
  horaire via table de tarifs dediee » (ADR-009:187).
- Jours civils : facturation par date civile locale, intervalle semi-ouvert,
  minimum 1 jour (ADR-009:53, 262).
- `unit_price_amount_minor` snapshot fige (ADR-009:189).
- EUR uniquement (ADR-009:102, 160).
- Hold 10 min, marges 30 min (ADR-009:57, 717).
- Snapshot de prix et de politique d'annulation figes (ADR-009:236-250).
- Idempotence par cle + empreinte (ADR-009:71), table `idempotency_records`
  (ADR-009:713).

Le code actuel reflete ce modele daily-only :

- `packages/database/src/schema.ts:485` : `daily_price_amount_minor`
  uniquement.
- `packages/core/src/pricing/calculate-price.ts:51,107` : `billableUnit`
  hardcode `'DAY'`.
- `packages/core/src/pricing/types.ts:49` : `billableUnit` type litteral
  `'DAY'` uniquement.
- `packages/core/src/pricing/civil-days.ts:83-126` : jours civils uniquement,
  pas de `TIME_RANGE`/`DAY_RANGE`.

Ce modele ne couvre plus les besoins produit approuves le 2026-08-07 :
tarification horaire, forfaits a duree fixe (demi-journee, 2 h, 6 h), paliers
multi-jours, recherche temporelle avec heures precises, et modifications de
reservation. ADR-018 conçoit le modele de remplacement sans implementer
aucun code ni SQL.

## 2. Objectifs et hors perimetre

### Objectifs

- Concevoir un modele de plans tarifaires par variante supportant les types
  `HOURLY`, `FIXED_DURATION` et `DAILY`.
- Concevoir la recherche temporelle avec `TIME_RANGE` et `DAY_RANGE`.
- Concevoir les paliers de reduction multi-jours.
- Concevoir un moteur de selection deterministe.
- Concevoir les snapshots financiers etendus.
- Concevoir les regles de retrait tardif, restitution fixe, annulations
  horaires et modifications de reservation.
- Documenter la strategie de migration/backfill.

### Hors perimetre

- Implementation de code TypeScript, SQL, schema, migrations ou tests.
- Paiements cross-currency, taux de change, arrondis cross-devise et payouts.
- Traduction automatique du contenu loueur.
- Profilage publicitaire ou personnalisation opaque.
- Configuration d'un fournisseur de geocodage.
- Creation de tables photos.

## 3. Options de modelisation comparees

### Option (a) : colonnes tarifaires additionnelles sur product_variants

Ajouter des colonnes `hourly_price_amount_minor`, `fixed_duration_price_minor`,
`fixed_duration_minutes`, etc. directement sur `product_variants`.

Avantages :

- Simplicite de lecture : une seule table.
- Pas de jointure supplementaire.

Inconvenients :

- Schema rigide : chaque nouveau type de forfait exige une nouvelle colonne.
- Contraintes CHECK complexes et difficiles a garantir sur une seule ligne.
- Pas de versionning naturel des plans.
- Melange entre donnees produit (variante) et donnees tarifaires (plans).
- Plusieurs forfaits `FIXED_DURATION` par variante impossibles sans table
  dediee.

### Option (b) : table dediee `pricing_plans` par variante

Une table `pricing_plans` ou chaque ligne represente un plan tarifaire pour une
variante donnee, avec un type enum (`HOURLY`, `FIXED_DURATION`, `DAILY`), des
parametres de duree, un prix, une devise, une priorite et un etat actif.

Avantages :

- Auditabilite : chaque plan est une ligne identifiee, versionnee.
- Contraintes CHECK garantissables par ligne et par groupe.
- Plusieurs forfaits `FIXED_DURATION` par variante natifs.
- Separation propre entre produit et tarification.
- Snapshots financiers references par `pricing_plan_id`.
- Extensibilite : nouveaux types de plans sans modifier le schema produit.

Inconvenients :

- Jointure supplementaire lors du calcul.
- Complexite accrue des contraintes de coherence inter-lignes.

### Option (c) : JSONB tarifaire sur variante

Stocker un objet JSONB contenant tous les plans tarifaires sur
`product_variants`.

Avantages :

- Flexibilite maximale du schema.

Inconvenients :

- Aucune contrainte CHECK garantissable sur le contenu JSONB sans triggers
  complexes.
- Auditabilite reduite : pas de lignes individuelles.
- Risque de schemas incoherents.
- Indexation et requetes plus complexes.
- Contradiction avec le principe de determinisme et d'auditabilite financiere.

### Recommandation

Option (b) : table dediee `pricing_plans`. Justification : auditabilite
financiere, contraintes CHECK garantissables, separation des snapshots, et
extensibilite. Les inconvenients (jointure, contraintes inter-lignes) sont
absorbes par le moteur tarifaire et des triggers PostgreSQL.

## 4. Modele recommande des plans tarifaires

Structure conceptuelle (pas de SQL) :

```text
pricing_plans
- pricing_plan_id UUID PK
- variant_id UUID NOT NULL FK -> product_variants
- plan_type enum NOT NULL          -- HOURLY | FIXED_DURATION | DAILY
- currency text NOT NULL           -- ISO 4217, 'EUR' au lancement
- price_amount_minor bigint NOT NULL
- min_duration_minutes integer     -- duree minimale couverte (HOURLY uniquement)
- max_duration_minutes integer     -- duree maximale couverte (HOURLY uniquement)
- billing_increment_minutes integer -- incrément de facturation (HOURLY uniquement)
- included_duration_minutes integer -- duree incluse exacte (FIXED_DURATION uniquement)
- public_label text                -- label public affiche (ex. "Demi-journee", "2 h")
- priority integer NOT NULL        -- tie-break non financier apres egalite de montant
- active boolean NOT NULL DEFAULT true
- version integer NOT NULL         -- version du plan
- created_at timestamptz NOT NULL DEFAULT now()
- updated_at timestamptz NOT NULL DEFAULT now()
```

Contraintes conceptuelles (union discriminée stricte par `plan_type`) :

- `price_amount_minor > 0`.
- `currency = 'EUR'` au lancement (contrainte applicative, architecture
  multi-devises).
- `plan_type = 'HOURLY'` :
  - `price_amount_minor` = prix par incrément ;
  - `billing_increment_minutes > 0` ;
  - `min_duration_minutes > 0` ;
  - `max_duration_minutes >= min_duration_minutes` ;
  - `included_duration_minutes = null` ;
  - aucune plage commerciale fixe obligatoire.
- `plan_type = 'FIXED_DURATION'` :
  - `included_duration_minutes > 0` ;
  - `price_amount_minor` = prix total du forfait ;
  - `billing_increment_minutes = null` ;
  - `min_duration_minutes = null` ;
  - `max_duration_minutes = null`.
- `plan_type = 'DAILY'` :
  - `price_amount_minor` = prix par jour civil ;
  - `min_duration_minutes = null` ;
  - `max_duration_minutes = null` ;
  - `billing_increment_minutes = null` ;
  - `included_duration_minutes = null` ;
  - les réductions multi-jours se rattachent au plan `DAILY` concerné, pas
    directement à la variante.
- `active = true` requis pour au moins un plan par variante reservable.
- Une variante sans plan actif n'est pas reservable.

## 5. Coherence et non-chevauchement des tarifs

### Contraintes produit

Pour une meme variante/devise/contexte :

- le montant total ne doit pas decroitre lorsque la duree couverte augmente ;
- un forfait plus long ne doit pas couter moins cher au total qu'un forfait
  plus court comparable ;
- les plans actifs ne doivent pas creer d'ambiguite financiere ;
- les chevauchements et regles de selection doivent etre deterministes.

### Garanties en PostgreSQL

Verifiable en base (CHECK constraints et triggers) :

- `price_amount_minor > 0` par ligne.
- Unicité différenciée par type de plan, par variante, devise et
  version/contexte tarifaire actif :
  - au plus un plan `HOURLY` actif par variante et devise pour une même
    version/contexte tarifaire ;
  - au plus un plan `DAILY` actif par variante et devise pour une même
    version/contexte ;
  - plusieurs plans `FIXED_DURATION` actifs autorisés (2 h, 4 h, 6 h, 8 h,
    etc.) ;
  - unicité d'un forfait `FIXED_DURATION` actif sur
    `(variantId, currency, includedDurationMinutes, contexte/version active)` ;
  - deux forfaits actifs de même durée pour la même variante/devise/contexte
    sont interdits ;
  - une nouvelle version tarifaire remplace explicitement l'ancienne, sans
    modifier les snapshots historiques.
- Clé métier (exclut la version) : (variant, scope default/local, currency,
  plan_type, included_duration pour FIXED_DURATION). La version est un numéro
  de révision de cette clé, pas une nouvelle offre indépendante.
- Cycle de vie fermé DRAFT → ACTIVE → RETIRED. Au plus une version ACTIVE
  par clé métier. Plusieurs versions historiques autorisées. Immuabilité des
  champs financiers et fonctionnels après activation. Un changement crée une
  nouvelle version DRAFT, puis l'activation de la nouvelle version et le
  retrait de l'ancienne peuvent être réalisés atomiquement.
- Un override local remplace le défaut correspondant indépendamment du numéro
  de version (un plan local v2 remplace un plan default v1 portant la même
  clé fonctionnelle).
- Cohérence des bornes : `min_duration_minutes <= max_duration_minutes` pour
  `HOURLY` uniquement (`FIXED_DURATION` et `DAILY` n'utilisent pas ces
  champs).

Verifiable par trigger sur mutation transactionnelle :

- Non-decroissance du montant total : un trigger peut verifier, lors de
  l'insertion ou modification d'un plan, que le montant total d'un forfait plus
  long n'est pas inferieur a celui d'un forfait plus court comparable pour la
  meme variante/devise. Cette verification est complexe et peut necessiter une
  validation au niveau applicatif si les regles de comparaison sont trop
  riches.

### Verifiable dans le moteur tarifaire

- Selection deterministe d'un seul plan pour une duree donnee, par montant le
  moins cher avec tie-breakers deterministes.
- Rejet en cas d'ambiguite non resoluble par les tie-breakers.
- Calcul du montant total et verification de non-decroissance a l'execution.

### Recommandation

Les contraintes structurelles (positivite, unicite differenciee par type, bornes
`HOURLY` uniquement) sont garanties en base par CHECK. La non-decroissance du
montant total est verifiee par trigger sur mutation pour les cas simples (meme
type, comparaison directe) et par le moteur tarifaire pour les cas croises
(comparaison `HOURLY` vs `FIXED_DURATION` vs `DAILY`). Aucun SQL n'est redige
dans ce cycle.

## 6. Paliers multi-jours

Structure conceptuelle (pas de SQL) :

```text
multi_day_discount_tiers
- tier_id UUID PK
- pricing_plan_id UUID NOT NULL FK -> pricing_plans (plan DAILY concerné)
- threshold_days integer NOT NULL   -- seuil en nombre de jours
- discount_percent integer NOT NULL -- pourcentage de reduction (>0 et <100)
- active boolean NOT NULL DEFAULT true
- created_at timestamptz NOT NULL DEFAULT now()
- updated_at timestamptz NOT NULL DEFAULT now()
```

Contraintes conceptuelles :

- `threshold_days > 0`.
- `discount_percent > 0 AND discount_percent < 100` (réduction strictement
  supérieure à 0 et strictement inférieure à 100 ; le montant final reste
  strictement positif).
- Seuils strictement croissants par plan `DAILY` (pas deux paliers avec le
  meme `threshold_days`).
- Un seul palier actif par seuil et par plan `DAILY`/version concerné.
- Pas de cumul : seul le meilleur palier applicable est utilise.
- Le total après réduction ne doit pas être décroissant lorsque la durée
  augmente.
- Le resultat est arrondi selon une regle deterministe en unites mineures.
- La FK conceptuelle pointe vers le plan `DAILY`/version concerné, pas vers
  la variante.

### Regle d'arrondi recommandee

Arrondi au plus proche en unites mineures, half-up (arrondi commercial
standard) : si le reste de la division est superieur ou egal a la moitie du
diviseur, arrondir vers le haut ; sinon vers le bas. Cette regle est
documentee, versionnee et figee dans le snapshot de reservation. Il s'agit
d'une recommandation technique clairement identifiee, pas d'une exigence
juridique. Elle n'est pas implémentee dans ce cycle.

## 7. Moteur de selection deterministe

### Algorithme conceptuel

```text
entree : duree_demandee_minutes, variante, devise, periode
sortie : plan_retenu, montant_total_minor

1. Charger uniquement les plans actifs et compatibles avec la variante,
   la devise, la location et la periode.
2. Ecarter les plans qui ne couvrent pas la duree demandee :
   - HOURLY : min_duration_minutes <= duree_demandee <= max_duration_minutes
   - FIXED_DURATION : included_duration_minutes >= duree_demandee
     (le forfait couvre au moins la duree demandee)
   - DAILY : toujours applicable pour les durees multi-jours
3. Calculer le prix total de chaque plan eligible avec la meme precision.
4. Selectionner le total le moins cher.
5. En cas d'egalite exacte, appliquer les tie-breakers deterministes :
   a. forfait correspondant exactement a la duree demandee ;
   b. plus petite duree incluse couvrant la demande ;
   c. plan necessitant le moins de temps inutilise ;
   d. identifiant/version stable comme dernier tie-break technique.
6. Retourner un seul plan avec le detail du calcul.
7. Si aucun plan ne couvre la duree, retourner une erreur typée.
```

Le champ `priority` est limite a un tie-break non financier : il ne peut
jamais forcer le choix d'un plan plus cher. Il intervient uniquement apres
egalite exacte de montant, en complement des tie-breakers ci-dessus.

### Exemples

- Demande de 2 h (120 min) : si un forfait `FIXED_DURATION` de 120 min existe
  et est moins cher ou egal au calcul horaire, il est selectionne. Sinon, le
  plan `HOURLY` est utilise (s'il est eligible, c'est-a-dire dans sa limite
  `maxDurationMinutes`).
- Demande de 4 h (240 min) : si un forfait `FIXED_DURATION` de 240 min
  (demi-journee) existe, il doit normalement etre retenu. La mutation de
  configuration doit prevenir une grille ou le forfait 4 h serait moins
  interessant que le calcul horaire.
- Demande de 5 h (300 min) : le forfait 4 h (240 min) ne couvre pas la demande
  (240 < 300) et est inéligible. Un forfait 6 h (360 min) peut etre utilise
  s'il existe et constitue la meilleure formule eligible. Sinon, le forfait
  journee 8 h est utilise. Sinon, une erreur typée est retournee (aucun plan
  couvrant). Le plan `HOURLY` n'est pas retombe si sa limite
  `maxDurationMinutes` est depassee.

Le plan `HOURLY` possede une duree maximale configuree et validee
(`maxDurationMinutes`). Au-dela de cette limite, il n'est plus eligible et
les forfaits fixes couvrants prennent le relais. Pour le lancement, la
configuration de reference fait cesser l'horaire avant la demi-journee de 4 h.
Si une flexibilite differente est envisagee plus tard, elle necessitera une
decision produit explicite.

Uttily ne doit pas utiliser une IA ou un modele probabiliste pour determiner un
montant financier. Le moteur est deterministe, auditable, reproductible, teste,
calcule cote serveur et fige dans le snapshot.

## 8. Dates/heures, fuseaux, DST et horaires d'ouverture

### TIME_RANGE vs DAY_RANGE

- `TIME_RANGE` : date et heure locales de debut ; date et heure locales de fin.
  Pour les locations horaires ou forfaitaires. Les entrees `startAt` et `endAt`
  sont des chaînes ISO 8601 **sans offset** (ex : `"2026-08-08T22:08:00"`),
  representant l'heure locale dans le fuseau IANA du lieu de location. La
  conversion en UTC est effectuee par le systeme via `localDateTimeStringToUtc`
  avec le fuseau du lieu. Le `pricing_intent_snapshot` stocke les chaînes
  locales telles quelles (pas la conversion UTC) ; les colonnes
  `customer_start_at` / `customer_end_at` stockent la conversion UTC.
- `DAY_RANGE` : date de debut ; date de fin exclusive. Pour les locations sur
  plusieurs jours.

### Interpretation par fuseau IANA

Pour chaque etablissement, les entrees sont interpretees dans son fuseau IANA
(`locations.time_zone`, schema.ts:189, not null). Les transitions DST sont
gerees : un intervalle chevauchant une transition d'heure d'ete/hiver est
calcule correctement en temps absolu.

### Horaires d'ouverture

Les horaires d'ouverture existants (`location_opening_hours`,
schema.ts:218-235) sont appliques. Une location horaire ou forfaitaire doit
tomber dans les heures d'ouverture de l'etablissement. Une location
multi-jours verifie que le retrait et la restitution tombent dans les horaires
d'ouverture des jours concernes.

### Buffers

Les buffers de preparation et nettoyage (`prep_buffer_minutes`,
`cleanup_buffer_minutes`) sont conserves. La periode bloquee etend la periode
client comme dans ADR-009.

## 9. Interaction avec disponibilite, buffers et holds

- Le hold PostgreSQL reste l'autorite finale pour l'allocation transactionnelle
  (ADR-009:57, 717).
- Les buffers etendent la `blocked_period` comme dans ADR-009.
- La recherche est informative : elle ne promet jamais une disponibilite plus
  large.
- Des faux negatifs conservateurs sont admis.
- Les resultats alternatifs ne constituent jamais une promesse de reservation.
- La recherche peut devenir obsolete avant le clic ; seul le hold decide.

## 10. Snapshots financiers et idempotence

### Snapshot fige

Le snapshot financier de la reservation est etendu pour inclure :

- `pricing_plan_id` : identifiant du plan retenu.
- `plan_type` : type du plan (`HOURLY`, `FIXED_DURATION`, `DAILY`).
- `plan_version` : version du plan retenu.
- `selection_algorithm_version` : version de l'algorithme de selection.
- `unit_price_amount_minor` : prix unitaire du plan.
- `quantity` : quantite d'exemplaires.
- `requested_period` : periode demandee par le client.
- `requested_duration_minutes` : duree demandee.
- `billed_duration_minutes` : duree facturee (pour `HOURLY` et
  `FIXED_DURATION`).
- `covered_duration_minutes` : duree couverte/facturee par le forfait.
- `billed_days` : nombre de jours factures (pour `DAILY`).
- `commercial_window` : fenetre commerciale retenue (heure locale de debut,
  heure locale de fin, jours de semaine concernes).
- `discount_tier_threshold_days` : palier applique (si reduction multi-jours).
- `discount_percent` : pourcentage de reduction applique.
- `amount_before_discount_minor` : montant avant reduction.
- `amount_after_discount_minor` : montant apres reduction.
- `currency` : devise reellement utilisee.
- `rounding_rule_version` : version de la regle d'arrondi appliquee.

### Versionnement tarifaire

Strategie de versionnement :

- une configuration tarifaire utilisee par une reservation ne doit pas etre
  reecrite en place ;
- un changement de prix, duree, devise ou regle cree une nouvelle version ;
- l'ancienne version devient inactive pour les nouvelles reservations ;
- les snapshots existants restent inchanges ;
- les plans references ne sont pas supprimes physiquement ;
- activation/desactivation et remplacement doivent etre transactionnels ;
- le moteur travaille sur une version active coherente.

### Immutabilite

Le snapshot est immuable apres confirmation (ADR-009:236-250 conserve et
etendu). Aucun changement silencieux du snapshot financier n'est autorise.

### Idempotence

L'idempotence par cle + empreinte (ADR-009:71) est conservee. L'empreinte
inclut le plan retenu et les parametres de duree.

## 11. Retrait tardif et restitution fixe

### Locations horaires et forfaits courts

- Heure de retrait prevue et heure de restitution prevue.
- Tolerance de retard au retrait : 30 minutes par defaut.
- Le retard ne decale jamais automatiquement l'heure de restitution.
- Une prolongation necessite une nouvelle verification de disponibilite.

### Demi-journee

- Duree tarifaire incluse : `included_duration_minutes` (reference : 4 heures
  = 240 min).
- Plage commerciale applicable (commercial window) : heure locale de debut,
  heure locale de fin, jours de semaine concernes.
- Retrait possible pendant cette plage.
- Heure de fin inchangee.

### Journee

- Duree tarifaire incluse : `included_duration_minutes` (reference : 8 heures
  = 480 min).
- Plage commerciale fixe definie par le loueur (reference : 8 heures, ex.
  9 h-17 h), avec heure locale de debut, heure locale de fin, jours de
  semaine concernes, fuseau IANA de la location.
- Compatible avec `location_opening_hours`.
- Retrait possible a n'importe quel moment pendant cette plage.
- Si le client retire a 13 h, il ne dispose plus que de 4 h.
- Le tarif n'est pas recalcule.
- La restitution reste a 17 h.
- Aucun report automatique.
- Une journee achetee pour 9 h-17 h et retiree a 13 h reste payable
  integralement et finit a 17 h.

### Fenetres tarifaires (pricing plan windows)

Lorsque plusieurs plages commerciales sont possibles pour un meme plan (ex.
demi-journee matin 9 h-13 h, demi-journee apres-midi 13 h-17 h, journee
9 h-17 h), une table ou fonction de fenetres tarifaires rattachee au plan et
a la location est recommandee. Deux approches sont comparees :

- Champs horaires directement sur le plan (`start_time`/`end_time`/`weekdays`)
  : simple pour une seule plage par plan, mais rigide si plusieurs plages
  coexistent.
- Table separee de fenetres d'application du plan (`pricing_plan_windows`)
  : permet plusieurs plages par plan, rattachees a la location et a son fuseau
  IANA.

Recommandation : table separee `pricing_plan_windows` rattachee au plan et a
la location si plusieurs plages sont possibles. Aucun SQL n'est redige dans
ce cycle.

### Plusieurs jours

- Retrait pendant les horaires prevus du premier jour.
- Restitution avant l'heure prevue du dernier jour.
- Toute prolongation exige une nouvelle disponibilite et une mutation
  atomique.

## 12. Annulations horaires

- Courte fenetre d'annulation gratuite de 30 minutes apres confirmation.
- Uniquement si le debut de la location est encore a au moins 2 heures.
- Aucune promesse juridique implicite.
- Validation juridique toujours requise avant production.
- Les politiques Flexible, Moderee, Ferme (ADR-009) sont conservees. Le loueur
  choisit une politique pour son organisation au MVP.

## 13. Modifications de reservation

- Autorisees si le nouvel horaire est disponible.
- Nouvelle verification serveur.
- Remplacement atomique des blocs/allocations concernes.
- Idempotence obligatoire.
- Aucun etat partiel.
- Aucun changement silencieux du snapshot financier.
- Si le prix change, le traitement paiement/remboursement exige une conception
  separee avant implementation. Ces modifications de reservation avec
  variation financiere sont separees dans un groupe futur dedie (G7M ou
  G7P-C), car elles dependent d'une conception paiement/remboursement encore
  ouverte.
- Les modifications de reservation ne sont pas implementees dans ce cycle.

## 14. Strategie de migration/backfill a concevoir

### Remplacement de daily_price_amount_minor

La colonne `daily_price_amount_minor` sur `product_variants` (schema.ts:485)
sera remplacee par les plans tarifaires. La strategie conceptuelle :

1. Creer les tables `pricing_plans`, `multi_day_discount_tiers` et
   `pricing_plan_windows`.
2. Backfill des variantes existantes : pour chaque variante ayant un
   `daily_price_amount_minor` non null, creer un plan `DAILY` par defaut avec
   le meme prix et la meme devise.
3. Conserver le snapshot des reservations existantes : les snapshots figes
   (ADR-009:236-250) ne sont pas modifies. Ils continuent de reference
   `unit_price_amount_minor` et `billable_unit = 'DAY'`.
4. Deprecier `daily_price_amount_minor` apres backfill et verification.

Aucun SQL n'est redige dans ce cycle.

### Correction de la migration 0031 en place vs 0032 additive

À la date de rédaction, la migration 0031
(`packages/database/drizzle/0031_lot7_public_search_foundations.sql`) n'était
pas encore commitée, partagée ou déployée.

Recommandation historique : corriger la migration 0031 en place plutôt que
créer une migration additive 0032. Cette recommandation a été appliquée dans
G7C-R3 ; la migration est désormais suivie, alignée et validée. La correction
de 0031 ne constitue donc plus une décision ou une action restante.

Les corrections necessaires pour 0031 incluent : viewport/bbox, countryCode,
type de lieu, et un modele de traductions des destinations par locale (pas de
colonnes rigides `label_fr`/`label_en`).

### Recommandation : modele international des destinations

Ne pas recommander des colonnes rigides `label_fr` et `label_en`. Recommandation :

- destination interne stable ;
- `countryCode` ISO 3166-1 alpha-2 ;
- `placeType` ferme ;
- centre geographique ;
- viewport/bounding box ;
- etat actif ;
- activation pays fail-closed ;
- table de traductions par locale, par exemple `destination_translations` ;
- unicite `(destinationId, locale)` ;
- FR et EN requis pour les destinations activees au lancement ;
- ajout futur d'une langue sans migration de colonnes ;
- aucune reponse brute fournisseur stockee tant que les droits ne sont pas
  confirmes.

G7C-R3 deciderra le SQL exact.

## 15. Tests futurs

### Tests unitaires du moteur

- Determinisme : meme entree produit toujours le meme plan et le meme montant.
- Exemples 2 h / 4 h / 5 h de la decision produit.
- Selection par montant le moins cher, avec tie-breakers deterministes.
- Coherence non-decroissance : le montant total ne decroit pas avec la duree.
- Limite du tarif horaire : ineligibilite du plan `HOURLY` au-dela de
  `maxDurationMinutes`.
- Paliers multi-jours : seuils strictement croissants, meilleur palier
  applicable, pas de cumul, reduction strictement superieure a 0 et
  strictement inferieure a 100.
- Rejet en cas d'ambiguite non resoluble.
- Arrondi half-up en unites mineures (recommandation technique).

### Tests d'integration PostgreSQL

- Contraintes CHECK : positivite, unicite differenciee par type de plan, bornes
  `HOURLY` uniquement.
- Union discriminée stricte : champs null/non-null selon `plan_type`.
- Concurrence : deux mutations simultanees sur les plans d'une meme variante.
- Snapshots : immutabilite apres confirmation.
- Triggers de coherence : non-decroissance sur mutation.

### Tests DST

- Deux fuseaux IANA differents.
- Transition heure d'ete vers heure d'hiver.
- Transition heure d'hiver vers heure d'ete.
- Intervalle chevauchant une transition.

## 16. Risques et questions encore ouvertes

Les questions suivantes restent ouvertes et sont referencees dans
`docs/implementation/open-questions.md` :

- Traduction du contenu libre des loueurs (FR+EN) — bloque G7E/G7F affichage
  multilingue.
- Fournisseur de geocodage final et droits de stockage/cache — bloque G7D/G7E
  geocodage reel.
- Parametres internes de l'elargissement geographique (seuils viewport,
  calibration) — bloque G7D calibration.
- Regles juridiques exactes des annulations horaires (30 min) — bloque
  activation production G7P-B/G7D.
- Modification d'une reservation entraînant un changement de prix — bloque
  G7M/G7P-C modifications financieres (conception paiement/remboursement
  requise au prealable).
- Futures devises et conversion — bloque activation pays hors EUR.
- Fiscalite par pays — bloque activation pays hors France.
- Limites et traitement technique des images — bloque G7F-A/G7F-B.
- Regles detaillees des forfaits traversant minuit si non resolues — bloque
  G7P-A.

## 17. Parties d'ADR-009 remplacees ou conservees

| Partie d'ADR-009 | Statut |
| --- | --- |
| daily-only (modele exclusivement journalier) | REMPLACE par plans tarifaires HOURLY/FIXED_DURATION/DAILY |
| Calcul exclusif par jours civils | ETENDU par TIME_RANGE/DAY_RANGE |
| `dailyPriceAmountMinor` unique | REMPLACE par `pricing_plans` |
| Montants en unites mineures | CONSERVE |
| EUR uniquement au lancement | CONSERVE |
| Snapshot de prix fige | CONSERVE et ETENDU (plan retenu, palier, arrondi) |
| Hold PostgreSQL autorite finale | CONSERVE |
| Idempotence par cle + empreinte | CONSERVEE |
| Marges 30 min (prep + cleanup) | CONSERVEES |
| `billableUnit = 'DAY'` hardcode | REMPLACE par `plan_type` enum |
| `currency = 'EUR'` CHECK | CONSERVE au lancement, architecture multi-devises |

L'implementation actuelle reste en place tant que la migration tarifaire future
n'est pas livree. ADR-009 n'est pas reecrit ; son historique est preserve. Une
section « Relation avec ADR-018 » est ajoutee a la fin d'ADR-009. La migration
tarifaire est planifiee dans les groupes G7P-A, G7P-B (moteur de calcul et
selection deterministe sans modifications financieres) et G7M/G7P-C
(modifications de reservation avec variation financiere, conception
paiement/remboursement requise au prealable) du decoupage revise du Lot 7.

> **Note G7P-A Round 2 (2026-08-07)** : G7P-A Round 2 (schema uniquement) est termine. La
> migration 0032 (corrigée en place) cree les tables `pricing_plans`,
> `pricing_plan_windows`, `multi_day_discount_tiers`, `pricing_plan_translations`,
> l'enum `pricing_lifecycle_state` (DRAFT/ACTIVE/RETIRED), ajoute
> `locations.operating_currency` (NOT NULL, backfill depuis
> `organizations.default_currency`), et backfill un plan DAILY ACTIVE v1
> par defaut pour chaque variante ayant un `daily_price_amount_minor` positif,
> avec les traductions FR (`Tarif journalier`) et EN (`Daily rate`).
>
> Clé métier (exclut la version) : (variant, scope default/local, currency,
> plan_type, included_duration pour FIXED_DURATION). Version = révision de
> la clé. Cycle de vie fermé DRAFT → ACTIVE → RETIRED. Immuabilité après
> activation (champs financiers et fonctionnels). Résolution default/local
> indépendante du numéro de version (un plan local v2 remplace un plan
> default v1). Fenêtres et paliers gelés dans la version. weekday_mask 1–127
> (bit 0 = lundi). Paliers threshold >= 2 avec monotonie des réductions.
> Montants <= 9007199254740991 (Number.MAX_SAFE_INTEGER). Traductions FR+EN
> requises pour l'activation, gelées après activation.
>
> Les forfaits traversant minuit ne sont PAS autorises (`end_time > start_time`
> dans `pricing_plan_windows`, decision conservatrice). G7P-B (moteur de
> calcul) n'est pas demarre. `daily_price_amount_minor` est conserve pour
> compatibilite Core existant (double lecture transitional).

> **Note G7P-A Round 3 (2026-08-07)** : Corrections de sécurité et de concurrence
> appliquées en place sur la migration 0032 :
>
> - **Résolution multi-tenant fail-closed** : la fonction
>   `resolve_effective_pricing_plans` prend désormais un seul paramètre
>   `p_location_id` (plus de paramètre currency). L'`organization_id` et la
>   `currency` sont dérivés de la location côté base (fail-closed : location
>   inexistante ou supprimée → zéro ligne). Aucun paramètre tenant ou devise
>   fourni par l'appelant — la location est l'autorité pour la devise. Les
>   plans par défaut sont filtrés par `organization_id` de la location, pas
>   seulement par currency.
> - **Revalidation complète à l'activation** : le trigger
>   `revalidate_pricing_plan_on_activation` (DRAFT → ACTIVE) revalide la
>   cohérence organisation variante, la cohérence location (org + currency +
>   non supprimée), les traductions FR+EN, toutes les fenêtres (tenant,
>   location, currency, mask/hours valides) et tous les paliers (DAILY
>   uniquement, threshold >= 2, discount 1-99, pas de doublons, monotonie).
>   L'ancien trigger `require_pricing_plan_translations_on_activation` est
>   fusionné dans cette fonction (DROP de l'ancien trigger/function).
> - **Verrou parent commun (FOR UPDATE)** : les triggers enfants
>   (`enforce_window_draft_only_mutations`, `enforce_tier_draft_only_mutations`,
>   `freeze_pricing_plan_translations`, `check_multi_day_tier_plan_type`,
>   `enforce_tier_monotonic_discount`) verrouillent le plan parent avec
>   `SELECT ... FOR UPDATE` avant de vérifier le `lifecycle_state`. Cela
>   sérialise les mutations enfants avec l'activation concurrente : si
>   l'activation détient le verrou, la mutation enfant attend ; si la mutation
>   enfant détient le verrou, l'activation attend puis revalide et voit la
>   nouvelle donnée.
> - **Monotonie des paliers sous concurrence** : `enforce_tier_monotonic_discount`
>   verrouille le plan parent (`SELECT 1 FROM pricing_plans ... FOR UPDATE`)
>   au début de la fonction, sérialisant les insertions concurrentes de paliers
>   sur le même plan.
> - **Plans DRAFT bloquent le changement de devise** :
>   `protect_location_operating_currency` vérifie désormais les plans DRAFT et
>   ACTIVE (pas seulement ACTIVE). Un plan DRAFT dans l'ancienne devise
>   empêche le changement de `operating_currency`, car il pourrait être activé
>   ensuite avec la mauvaise devise. Les plans RETIRED (historiques, immuables,
>   plus effectifs) ne bloquent PAS le changement de devise.

---

## G7P-B1 — Moteur de calcul (read-only quote)

- **Statut** : Implémenté (read-only quote, non intégré au flux de réservation)
- **Date** : 2026-08-07
- **G7P-B2** : Implémenté (G7P-B2-B Round 2 terminé et validé, G7P-B2-C implanté)

### Architecture

Le moteur de calcul est séparé en deux couches :

1. **Moteur pur** (`computeQuote` dans `packages/core/src/pricing-plans/quote-engine.ts`) :
   aucune dépendance base de données, aucune écriture, aucun `Date.now()`, aucun
   random, aucun float pour les montants. Same input + same plans = byte-for-byte
   equivalent result.

2. **Chargeur DB** (`loadPricingContext` dans
   `packages/core/src/pricing-plans/load-pricing-context.ts`) : charge tout le
   contexte depuis PostgreSQL en requêtes batchées (au maximum 7, pas de N+1).
   Appelle la fonction SQL `resolve_effective_pricing_plans(locationId)` pour
   résoudre les plans effectifs (locaux + défauts non remplacés).

3. **Use case** (`quoteFlexiblePricing` dans
   `packages/core/src/pricing-plans/quote-flexible-pricing.ts`) : orchestre le
   chargement puis le calcul, convertit les erreurs PostgreSQL brutes en
   `FlexiblePricingError`.

### Versions d'algorithme

- `algorithmVersion` : `'flexible-pricing-v1'`
- `roundingRuleVersion` : `'half-up-v1'`

### Règles TIME_RANGE / DAY_RANGE

- **TIME_RANGE** : `startAt` et `endAt` sont des chaînes de date+heure locale
  ISO 8601 sans offset (ex : `"2026-08-08T22:08:00"`). Elles représentent
  l'heure locale dans le fuseau IANA du lieu de location. Le système convertit
  ces chaînes en UTC via `localDateTimeStringToUtc` avec le fuseau du lieu, et
  la durée demandée est `minutesBetween(startAtUtc, endAtUtc)`. Les plans
  éligibles sont HOURLY, FIXED_DURATION et DAILY (DAILY nécessite une fenêtre
  commerciale couvrant la plage, même jour civil uniquement). Le
  `pricing_intent_snapshot` stocke les chaînes locales (pas la conversion UTC) ;
  les colonnes `customer_start_at` / `customer_end_at` stockent la conversion
  UTC.
- **DAY_RANGE** : `startDate` et `endDateExclusive` sont des dates civiles
  (YYYY-MM-DD). L'intervalle est semi-ouvert `[startDate, endDateExclusive[`.
  Le nombre de jours civils est `countCivilDays(startDate, endDateExclusive)`.
  Seuls les plans DAILY sont éligibles.

### Règles de fenêtres et horaires d'ouverture

- **Fenêtres commerciales** (`pricing_plan_windows`) : un plan DAILY en
  TIME_RANGE n'est éligible que si une fenêtre couvre entièrement la plage
  demandée (même weekday, startTime >= window.startTime, endTime <=
  window.endTime). Pas de fallback 24h.
- **Horaires d'ouverture** (`location_opening_hours`) : si des horaires sont
  configurés, la période demandée doit tomber dans les horaires d'ouverture.
  Si aucun horaire n'est configuré, le moteur ne bloque pas (fail-open).
  Violation → `OUTSIDE_OPENING_HOURS`.

### Gestion DST

- Utilisation de `Intl.DateTimeFormat` avec `timeZone` IANA pour décomposer
  les instants UTC en date civile locale. Aucune bibliothèque externe.
- Les jours civils sont comparés via Julian Day Number (pas de division par
  24h qui serait incorrecte lors des passages DST).

### Sélection du palier de remise

- Un seul palier de remise est appliqué (pas de cumul) : le palier avec le
  plus grand `thresholdDays` qui est `<= dayCount`.
- Seuls les paliers du même plan sont considérés (pas de fusion avec les
  paliers du plan par défaut).
- Arrondi commercial half-up via `halfUpRound` en arithmétique entière pure :
  `discount = floor((amount * percent * 2 + 100) / 200)`, `result = amount - discount`.

### Règles de validation de grille

- Un plan FIXED_DURATION plus long ne doit pas coûter moins cher qu'un plus
  court (même variante, même devise). Violation → `PRICING_CONFIGURATION_INVALID`.
- Pour les plans DAILY, le total après remise ne doit pas décroître quand on
  ajoute un jour. Violation → `PRICING_CONFIGURATION_INVALID`.

### Ordre de tie-break (sélection déterministe)

1. Montant le plus bas (`lineTotalAmountMinor`)
2. Correspondance exacte de durée (`exactDurationMatch` — true d'abord)
3. Plus petite durée suffisante (`sufficientDuration` croissant)
4. Moins de temps inutilisé (`unusedTime` croissant)
5. Priorité ascendante (`priority` croissant)
6. Version ascendante (`version` croissant)
7. UUID lexical ascendant (`pricingPlanId`)

### Résolution de locale

- Match exact (case-insensitive) → retourne la locale exacte.
- Sinon, extraction de la langue de base (ex: `fr-FR` → `fr`).
- Les langues de base supportées sont `fr` et `en`.
- **Jamais** utiliser `fr` comme fallback pour `en` ou vice versa.
- Si la langue de base est supportée mais non disponible → `UNSUPPORTED_LOCALE`.
- Si la langue de base n'est pas supportée → `UNSUPPORTED_LOCALE`.

### Codes d'erreur

`VALIDATION`, `LOCATION_NOT_FOUND`, `VARIANT_NOT_FOUND`, `PRODUCT_NOT_ELIGIBLE`,
`NO_ELIGIBLE_PLAN`, `OUTSIDE_OPENING_HOURS`, `PRICING_CONFIGURATION_INVALID`,
`UNSUPPORTED_LOCALE`, `CURRENCY_MISMATCH`, `AMOUNT_OVERFLOW`.

### Statut G7P-B1 / G7P-B2

- **G7P-B1** : Implémenté. Le moteur de calcul read-only est opérationnel et
  testé (tests unitaires purs + tests d'intégration PostgreSQL). Le devis
  n'est pas encore intégré au flux de réservation (création de brouillon,
  hold, paiement).
- **G7P-B2** : Implémenté (G7P-B2-B Round 2 terminé et validé, G7P-B2-C implanté).
  Intégration du moteur au flux de réservation via `createBookingDraftWithHold`
  (chemin flexible), snapshot de prix figé avec `algorithmVersion` et
  `roundingRuleVersion`. G7P-B2-C (migration des flux existants) est implanté :
  `applyBookingConfirmation` copie tous les champs flexibles, `initiatePayment`
  valide `pricingSnapshotVersion` fail-closed, le document data loader sélectionne
  les champs flexibles, 22 tests d'intégration couvrent tous les scénarios
  obligatoires.

---

## G7P-B2-A — Fondations des snapshots de prix flexibles (schéma)

- **Statut** : Implémenté — Round 3 (schéma + contraintes + triggers + tests)
- **Date** : 2026-08-07
- **G7P-B2-B** : Implémenté (intégration dans `createBookingDraftWithHold`) — Round 2 terminé et validé
- **G7P-B2-C** : Implanté (migration des flux existants) — voir section dédiée ci-dessous

### Source explicite et règle de non-re-validation

La confirmation d'un devis flexible (`booking_drafts` → `bookings`/`booking_lines`) est une copie pure du snapshot établi lors du devis. La table `booking_lines` dispose de `source_draft_line_id`, une FK DEFERRABLE INITIALLY DEFERRED vers `booking_draft_lines(id)` avec un index unique garantissant qu'une seule ligne de réservation découle d'une ligne de devis. Le trigger `enforce_booking_line_pricing_coherence` charge la source explicite en `FOR SHARE` et compare les colonnes financières/pricing (y compris `variant_snapshot`) avec `IS DISTINCT FROM`. Il ne consulte plus `pricing_plans`, `pricing_plan_translations`, `locations`, ni l'état actif du catalogue : un plan `RETIRED`, un plan local activé postérieurement ou une traduction modifiée n'ont aucun effet sur la confirmation.

La table `bookings` est une copie de son `booking_drafts` source pour les champs de pricing de location, de période, de fuseau et de snapshot de pricing (mêmes `customer_start_at`, `subtotal_amount_minor`, `mandatory_fees_amount_minor`, `total_amount_minor`, `timezone`, `billable_unit`, `billable_unit_count`, `cancellation_policy_snapshot`, `pricing_*`, etc.). En revanche, les champs financiers (`tax_status`, `tax_amount_minor`, `tax_rate_bps`, `tax_rule_snapshot`, `commission_amount_minor`, `commission_rule_snapshot`, `terms_acceptance_snapshot`) ne sont PAS copiés depuis le brouillon : ils proviennent de `payments` (autorité ADR-010 §6), résolus à l'initiation du paiement par `resolveFinancialTerms`. Au stade du brouillon, `tax_status = 'UNDETERMINED'` et `commission_amount_minor = NULL` ; ces valeurs ne sont pas valides sur `bookings` (contrainte CHECK `tax_status <> 'UNDETERMINED'`). Le trigger `validate_flexible_booking_aggregates` compare uniquement les champs de pricing de location et lève une seule exception descriptive en cas de divergence. La vérification des agrégats est déclenchée sur `AFTER INSERT OR UPDATE OF status` des deux tables, DEFERRABLE INITIALLY DEFERRED, ce qui permet d'insérer parent et lignes dans n'importe quel ordre avant le `COMMIT`.

### Modèle de snapshot

Deux versions de snapshot coexistent :

- `legacy-daily-v1` : snapshots existants (brouillons et réservations créés avec
  le modèle journalier ADR-009). La colonne `pricing_snapshot_version` sur
  `booking_drafts` et `bookings` identifie le format.
- `flexible-pricing-v1` : nouveaux snapshots flexibles créés par le moteur
  G7P-B1 (`computeQuote`).

Les snapshots legacy restent lisibles ; aucune conversion n'est tentée. Les
nouvelles colonnes sont nullable pour les lignes legacy, requises (via CHECK
conditionnel) pour les lignes flexibles.

### Nouvelles colonnes sur booking_drafts et bookings

- `pricing_snapshot_version` text NOT NULL DEFAULT `'legacy-daily-v1'`
- `pricing_algorithm_version` text (NULL pour legacy, `'flexible-pricing-v1'`
  pour flexible)
- `pricing_rounding_rule_version` text (NULL pour legacy, `'half-up-v1'` pour
  flexible)
- `pricing_intent_type` text (NULL pour legacy, `'TIME_RANGE'` ou `'DAY_RANGE'`
  pour flexible)
- `pricing_intent_snapshot` jsonb (NULL pour legacy, copie d'audit de l'intent)
- `pricing_resolved_locale` text (NULL pour legacy, locale résolue pour
  flexible)

### Nouvelles colonnes sur booking_draft_lines et booking_lines

- `pricing_plan_id` uuid (NULL pour legacy, FK vers `pricing_plans` pour
  flexible)
- `pricing_plan_version` integer (NULL pour legacy)
- `pricing_plan_type` text (NULL pour legacy, `'HOURLY'`|`'FIXED_DURATION'`|
  `'DAILY'` pour flexible)
- `pricing_public_label` text (NULL pour legacy, libellé commercial snapshoté)
- `pricing_requested_duration_minutes` integer (NULL pour legacy)
- `pricing_billed_duration_minutes` integer (NULL pour legacy, HOURLY)
- `pricing_covered_duration_minutes` integer (NULL pour legacy,
  FIXED_DURATION)
- `pricing_billed_days` integer (NULL pour legacy, DAILY)
- `pricing_selected_window` jsonb (NULL pour legacy, copie d'audit de la
  fenêtre sélectionnée)
- `pricing_discount_threshold_days` integer (NULL pour legacy, DAILY
  uniquement)
- `pricing_discount_percent` integer (NULL pour legacy, DAILY uniquement)
- `pricing_amount_before_discount_minor` bigint (NULL pour legacy, DAILY
  uniquement)
- `pricing_amount_after_discount_minor` bigint (NULL pour legacy, DAILY
  uniquement)

### Contraintes financières (CHECK)

- Tous les montants >= 0 et <= `9007199254740991` (`Number.MAX_SAFE_INTEGER`)
- `pricing_amount_before_discount_minor >= pricing_amount_after_discount_minor`
  (quand les deux sont présents)
- `pricing_discount_percent >= 0 AND <= 100` (quand présent)
- Si `pricing_discount_threshold_days IS NOT NULL` THEN
  `pricing_plan_type = 'DAILY'`
- Si `pricing_plan_type = 'HOURLY'` THEN `pricing_billed_duration_minutes IS
  NOT NULL`
- Si `pricing_plan_type = 'FIXED_DURATION'` THEN
  `pricing_covered_duration_minutes IS NOT NULL`
- Si `pricing_plan_type = 'DAILY'` THEN `pricing_billed_days IS NOT NULL AND
  pricing_amount_before_discount_minor IS NOT NULL AND
  pricing_amount_after_discount_minor IS NOT NULL`
- Si `pricing_snapshot_version = 'flexible-pricing-v1'` THEN
  `pricing_algorithm_version IS NOT NULL AND
  pricing_rounding_rule_version IS NOT NULL AND pricing_intent_type IS NOT
  NULL`
- Si `pricing_snapshot_version = 'legacy-daily-v1'` THEN `billableUnit =
  'DAY'` (sur `booking_drafts`)
- `pricing_intent_type` IN (`'TIME_RANGE'`, `'DAY_RANGE'`) ou NULL
- `pricing_plan_type` IN (`'HOURLY'`, `'FIXED_DURATION'`, `'DAILY'`) ou NULL
- `pricing_snapshot_version` IN (`'legacy-daily-v1'`,
  `'flexible-pricing-v1'`)
- `pricing_billed_days > 0`, `pricing_billed_duration_minutes > 0`,
  `pricing_covered_duration_minutes > 0`,
  `pricing_requested_duration_minutes > 0` (quand présents)
- Si `pricing_intent_type = 'DAY_RANGE'` THEN `pricing_plan_type = 'DAILY'`
  (sur `booking_draft_lines` et `booking_lines`)

### Trigger multi-tenant

- `before_check_draft_pricing_plan_org_consistency` : si
  `pricing_plan_id IS NOT NULL`, vérifie que le `organization_id` du plan
  correspond au `organization_id` du brouillon. Vérifie également que la devise
  du plan correspond à la devise du brouillon. Fail-closed.
- Idem pour `booking_lines` → `bookings` → `pricing_plans`.

### Triggers d'immutabilité

- `before_check_draft_financial_immutability` : sur UPDATE de
  `booking_drafts`, rejette les modifications de toutes les colonnes SAUF
  `status`, `expires_at`, `updated_at`. Le snapshot financier est figé à la
  création.
- `before_check_draft_line_immutability` : immutabilité **conditionnelle** sur
  `booking_draft_lines`. Allow UPDATE/DELETE only when parent draft status =
  `'DRAFT'`. When parent is HELD/PAYMENT_PROCESSING/EXPIRED/CONVERTED, reject
  ALL changes (any column). This freezes the snapshot once the draft is HELD,
  while allowing existing flows that manipulate DRAFT-status draft lines to
  continue working.
- `before_check_booking_financial_immutability` : sur UPDATE de `bookings`,
  rejette les modifications de toutes les colonnes SAUF `status` et
  `updated_at`. Le snapshot financier est figé à la confirmation. Les
  transitions de statut (CONFIRMED → READY_FOR_PICKUP → ACTIVE → etc.) restent
  autorisées. DELETE est toujours rejeté. Les colonnes JSONB protégées incluent
  `cancellation_policy_snapshot`, `terms_acceptance_snapshot`,
  `tax_rule_snapshot`, `commission_rule_snapshot`.
- `before_check_booking_line_immutability` : immutabilité **complète** sur
  `booking_lines`. Reject ALL UPDATE and DELETE. Les bookings sont immuables
  après confirmation — aucune colonne d'une ligne de réservation ne peut être
  modifiée.
- Note : le DELETE de `booking_drafts` est autorisé (pour le nettoyage des
  brouillons expirés).

### Triggers de cohérence intent/plan

- `before_check_draft_line_intent_plan_coherence` : sur INSERT ou UPDATE de
  `booking_draft_lines`, vérifie que si le parent draft a
  `pricing_intent_type = 'DAY_RANGE'`, alors la ligne doit avoir
  `pricing_plan_type = 'DAILY'` (ou NULL). Un plan HOURLY ou FIXED_DURATION
  avec un draft DAY_RANGE est rejeté.
- `before_check_booking_line_intent_plan_coherence` : idem pour
  `booking_lines` → `bookings`.

### Stratégie de compatibilité

- Les lignes existantes reçoivent `pricing_snapshot_version =
  'legacy-daily-v1'` (DEFAULT)
- Toutes les nouvelles colonnes sont nullable, donc les lignes existantes ont
  NULL pour tous les champs flexibles
- La contrainte `billable_unit = 'DAY'` est remplacée par une contrainte
  conditionnelle
- Aucun backfill ou conversion des snapshots existants
- `daily_price_amount_minor` et `calculatePrice` restent inchangés
- `createBookingDraftWithHold` supporte désormais deux chemins : legacy
  (`legacy-daily-v1`, inchangé) et flexible (`flexible-pricing-v1`, G7P-B2-B)

### Round 2 — Renforcement fail-closed (G7P-B2-A)

Les invariants suivants ont été ajoutés dans la migration 0033 :

- Métadonnées parent exactes : `flexible-pricing-v1` impose
  `pricing_algorithm_version = 'flexible-pricing-v1'`,
  `pricing_rounding_rule_version = 'half-up-v1'`,
  `pricing_intent_type IN ('TIME_RANGE','DAY_RANGE')`,
  `pricing_intent_snapshot` JSON objet non vide, et
  `pricing_resolved_locale` non vide. `legacy-daily-v1` impose que toutes ces
  colonnes soient `NULL` et `billable_unit = 'DAY'`.
- Cohérence location/timezone/devise par trigger sur `booking_drafts` : la
  `location_id` et le `timezone` du parent doivent correspondre à `locations`,
  l'établissement appartenir à la bonne organisation, `deleted_at IS NULL`, et
  la devise du brouillon égale à `operating_currency`. Politique timezone
  fail-closed : le `time_zone` de la location et le `timezone` du brouillon
  doivent chacun être un fuseau IANA valide (vérifié via `pg_timezone_names`),
  et être strictement identiques ; un fuseau invalide est rejeté d'emblée.
- Règle parent/line fail-closed : `legacy-daily-v1` impose toutes les colonnes
  `pricing_*` à `NULL` ; `flexible-pricing-v1` impose un snapshot complet.
- Triggers `enforce_draft_line_pricing_coherence` et
  `enforce_booking_line_pricing_coherence` vérifient : existence, org, variante,
  devise, version, type, état `ACTIVE` (uniquement en brouillon), applicabilité
  local/default, libellé traduit, et arithmétique canonique par type.
- Verrouillage `FOR SHARE` sur `booking_drafts` puis `pricing_plans` ; ordre de
  verrouillage : ligne -> parent -> plan.
- Remise canonique : pas de remise (`threshold` et `percent` NULL, `percent = 0`,
  `amount_before = amount_after`) ; ou remise avec `threshold >= 2`,
  `percent` entre 1 et 99, palier actif le plus élevé applicable, et
  `amount_after` égal à l'arrondi half-up de `amount_before`.
- Triggers DEFERRABLE INITIALLY DEFERRED `after_validate_flexible_*_aggregates`
  vérifient, uniquement pour `flexible-pricing-v1`, que `subtotal` égale la
  somme des `line_total`, qu'au moins une ligne existe, que toutes les lignes
  partagent la devise du parent, et que `total = subtotal + mandatory_fees`.
- Copie exacte `booking_lines` depuis `booking_draft_lines` (même snapshot
  partagé).
- Immutabilité renforcée : `created_at` ajouté aux colonnes immuables, DELETE
  interdit pour `booking_drafts` si `status IN ('HELD','PAYMENT_PROCESSING')`,
  INSERT de ligne autorisé uniquement si le brouillon est `DRAFT`, et
  `draft_id`/`variant_id` immuables.

### Statut

- **G7P-B2-A** : Implémenté (schéma + contraintes + triggers + tests
  uniquement) — Round 4 fail-closed intégré (timezone IANA fail-closed,
  copie racine étendue aux champs financiers tax_status/tax_amount_minor/
  tax_rate_bps/commission_amount_minor, tests L6/L7 reposent uniquement
  sur les verrous des triggers)
- **G7P-B2-B** : Round 2 terminé et validé (intégration dans `createBookingDraftWithHold`) —
  contrat d'entrée union discriminée, transition DRAFT → HELD, SET CONSTRAINTS
  ciblé, conversion local-to-UTC fail-closed, resolvedLocale du moteur,
  PricingWindowSnapshot persisté, billableUnitCount du moteur, dispatch fermé,
  isolation erreurs DB (PRICING_CONTEXT_UNAVAILABLE), 72 tests d'intégration
- **G7P-B2-C** : Implanté (migration des flux existants) — voir section dédiée

---

## G7P-B2-B — Intégration dans createBookingDraftWithHold

- **Statut** : Round 2 terminé et validé
- **Date** : 2026-08-07 (Round 1), 2026-08-08 (Round 2)
- **G7P-B2-C** : Implanté (migration des flux existants) — voir section dédiée ci-dessous

### Round 2 — Corrections

Les corrections suivantes ont été apportées au Round 2 :

1. **resolvedLocale du moteur** (Defect 1) : `pricing_resolved_locale` et le
   responseBody utilisent `quoteResult.resolvedLocale` (canonicalisé par le
   moteur via `resolveLocale`) au lieu de `input.locale`. L'empreinte
   idempotente utilise `Intl.getCanonicalLocales(input.locale)` pour
   canonicaliser la locale BCP 47 de manière déterministe. Deux locales
   équivalentes (ex: `fr-FR` et `FR-fr`) produisent la même empreinte.

2. **PricingWindowSnapshot persisté** (Defect 2) : `pricing_selected_window`
   stocke le `windowSnapshot` du moteur (union discriminée
   `TIME_RANGE_WINDOW | DAY_RANGE_BOUNDARIES`) au lieu de `selectedWindow`.
   Le trigger `enforce_draft_line_pricing_coherence` valide la structure du
   snapshot : `kind` requis, champs obligatoires par type, cohérence avec
   `pricing_intent_type` du parent, et correspondance des dates avec
   `pricing_intent_snapshot`.

3. **billableUnitCount du moteur** (Defect 4) : `billableUnitCount` provient
   directement du moteur (`quoteLine.billableUnitCount`) au lieu d'être
   reconstruit par ratio (`lineTotal / (unitPrice * quantity)`). Le
   `billableUnitCount` au niveau du draft est la somme des
   `billableUnitCount * quantity` de chaque ligne. Cela garantit la
   cohérence même avec des remises (ex: 5 jours à 5000 avec 10% de remise →
   billableUnitCount = 5, pas 4.5).

4. **Dispatch fermé** (Defect 6) : Le dispatch sur `pricingMode` est fermé :
   `'FLEXIBLE'` → chemin flexible, `'LEGACY'` ou `undefined` → chemin legacy,
   toute autre valeur → `BookingDraftError('VALIDATION')`. Aucun fallback
   silencieux. La validation a lieu avant `reserveKey` : aucune mutation DB,
   aucun enregistrement d'idempotence pour un mode invalide.

5. **Isolation erreurs DB** (Defect 7) : `PRICING_CONTEXT_UNAVAILABLE` est
   traité comme une erreur d'infrastructure. `normalizeBusinessError` retourne
   `null` → l'erreur brute est relancée (conforme à ADR-009). Aucune réponse
   métier n'est persistée. Le message PostgreSQL original n'est jamais exposé
   dans le responseBody (message générique uniquement).

6. **SET CONSTRAINTS ciblé** (Defect 8) : `SET CONSTRAINTS` cible
   spécifiquement `"booking_draft_lines_pricing_plan_id_fk"`,
   `"after_validate_flexible_draft_aggregates_line"` et
   `"after_validate_flexible_draft_aggregates_draft"` au lieu de `ALL`.
   Le mode `DEFERRED` est restauré après le savepoint.

### Contrat d'entrée : union discriminée

L'input de `createBookingDraftWithHold` est désormais une union discriminée :

- `LegacyCreateBookingDraftInput` : chemin existant (modèle journalier
  ADR-009). Crée des drafts `legacy-daily-v1`. Comportement inchangé.
- `FlexibleCreateBookingDraftInput` : chemin flexible. Crée des drafts
  `flexible-pricing-v1`. Discriminant : `pricingMode: 'FLEXIBLE'` avec
  `intentType: 'TIME_RANGE' | 'DAY_RANGE'`, `locale`, et les champs
  temporels correspondants.

### Chemin flexible : transition DRAFT → HELD

Le chemin flexible ne peut pas insérer un draft directement en `HELD` car les
triggers d'immutabilité interdisent l'INSERT de lignes de brouillon lorsque le
parent n'est pas `DRAFT`. La séquence est :

1. INSERT du draft en statut `DRAFT` avec les colonnes `pricing_*` flexibles.
2. INSERT des `booking_draft_lines` (autorisé car parent est `DRAFT`).
3. Transition du draft `DRAFT → HELD` (UPDATE de `status` uniquement).
4. INSERT des `inventory_blocks` et allocations (hold).

Cette séquence respecte les triggers `before_check_draft_line_immutability`
(INSERT de ligne autorisé uniquement si parent est `DRAFT`) et
`before_check_draft_financial_immutability` (seuls `status`, `expires_at`,
`updated_at` sont modifiables).

### SET CONSTRAINTS ciblé (Round 2 — Defect 8)

Les triggers d'agrégats (`after_validate_flexible_*_aggregates`) sont
`DEFERRABLE INITIALLY DEFERRED` : ils ne se déclenchent qu'au `COMMIT`. Dans le
chemin flexible, après l'insertion du parent et des lignes (étapes 1-2), la
commande `SET CONSTRAINTS` cible spécifiquement les contraintes
`"booking_draft_lines_pricing_plan_id_fk"`,
`"after_validate_flexible_draft_aggregates_line"` et
`"after_validate_flexible_draft_aggregates_draft"` en mode `IMMEDIATE`,
exécutée à l'intérieur du savepoint pour forcer l'évaluation des triggers
différés avant la transition vers `HELD`. Cela garantit que toute incohérence
d'agrégats est détectée et remonte en erreur avant l'allocation d'inventaire,
sans attendre le `COMMIT`. Après le savepoint, le mode `DEFERRED` est restauré
pour les mêmes contraintes, afin de ne pas affecter d'autres contraintes
différées potentielles dans la transaction externe.

### Conversion local-to-UTC (fail-closed)

Le utilitaire `localDateTimeToUtc(local, timeZone)` dans
`packages/core/src/pricing-plans/local-to-utc.ts` convertit une date/heure
locale et un fuseau IANA en instant UTC. La gestion DST est fail-closed :

- **NON_EXISTENT_LOCAL_TIME** (spring-forward) : l'heure locale n'existe pas
  dans le fuseau → erreur typée `LocalToUtcError`, rejet.
- **AMBIGUOUS_LOCAL_TIME** (fall-back) : l'heure locale existe deux fois
  (heure d'été → heure d'hiver) → erreur typée `LocalToUtcError`, rejet
  (fail-closed : aucun choix implicite entre les deux interprétations).

L'erreur `LocalToUtcError` est mappée vers `BookingDraftError` avec code
`VALIDATION`.

### DAY_RANGE : bornes et horaires d'ouverture

Pour une intention `DAY_RANGE`, le moteur calcule les bornes du premier et du
dernier jour :

- **Premier jour** (`DayRangeDayBoundary`) : date civile locale de début,
  fenêtre commerciale de la première journée (heure de début locale).
- **Dernier jour** : date civile locale de fin (exclusive), fenêtre
  commerciale de la dernière journée (heure de fin locale).

Les horaires d'ouverture (`location_opening_hours`) sont vérifiés
**uniquement sur le premier et le dernier jour** pour `DAY_RANGE`. Les jours
intermédiaires peuvent être fermés (la location multi-jours est valide même si
l'établissement est fermé un jour civil intermédiaire). Pour `TIME_RANGE`, la
vérification des horaires d'ouverture porte sur la plage complète.

La sélection de la fenêtre (`findDayRangeWindow` dans `windows.ts`) choisit la
fenêtre de plus grande durée couvrant la plage demandée ; en cas d'égalité, la
fenêtre avec l'heure de début la plus tôt est retenue (tie-break déterministe).

### Réponse flexible

La réponse du chemin flexible (`FlexibleBookingDraftResponseBody`) inclut les
champs de snapshot de prix : `pricingSnapshotVersion`,
`pricingAlgorithmVersion`, `pricingRoundingRuleVersion`, `pricingIntentType`,
et le détail par ligne (plan retenu, type, durée facturée, fenêtre, palier,
montants avant/après remise).

### Mapping d'erreurs

- `FlexiblePricingError` → `BookingDraftError` (code correspondant au code
  flexible : `NO_ELIGIBLE_PLAN`, `OUTSIDE_OPENING_HOURS`, etc.)
- `LocalToUtcError` → `BookingDraftError` avec code `VALIDATION`
- Les erreurs PostgreSQL (triggers, contraintes) sont mappées par nom de
  contrainte ou message comme dans le chemin legacy.

### Corrections de modèle (migration 0033)

Les corrections suivantes ont été appliquées dans la migration 0033 et
`schema.ts` pour supporter l'intégration :

- `billable_unit_valid` : ajout de `'MINUTE'` à la contrainte CHECK (requis
  pour les plans HOURLY facturés par incrément).
- `flexible_billable_unit_by_intent` : nouvelle contrainte CHECK sur
  `booking_drafts` et `bookings` : `TIME_RANGE → billable_unit IN
  ('MINUTE','DAY')`, `DAY_RANGE → billable_unit = 'DAY'`.
- `enforce_draft_line_pricing_coherence` : `DAY_RANGE →
  pricing_requested_duration_minutes IS NULL`, `TIME_RANGE →
  pricing_requested_duration_minutes > 0`.
- `deriveLineBillableUnitCount` : correction pour HOURLY (compte en
  incréments, pas en minutes).

### Tests

52 tests d'intégration PostgreSQL dans
`create-booking-draft-flexible.test.ts` couvrent : création flexible TIME_RANGE
et DAY_RANGE, transition DRAFT → HELD, allocation d'inventaire, immutabilité
après HELD, erreurs de validation (grille tarifaire, horaires, DST), mapping
d'erreurs, et cohérence multi-tenant.

---

## G7P-B2-C — Migration des flux existants (confirmation, paiement, documents)

- **Statut** : Implanté
- **Date** : 2026-08-08
- **G7P-B2-B** : Round 2 terminé et validé

### Description

G7P-B2-C étend la confirmation, le paiement et la génération de documents pour
supporter les snapshots flexibles. Le flux legacy est préservé sans conversion
rétroactive.

**`applyBookingConfirmation`** copie les champs du brouillon vers la
réservation confirmée. Le brouillon est l'autorité pour le pricing de location,
la période, le fuseau et le snapshot de pricing. Les champs financiers
(tax/commission/terms) proviennent toujours de `payments` (autorité ADR-010 §6) :

- **Champs racine depuis `booking_drafts`** : `timezone`,
  `billable_unit`, `billable_unit_count`, `pricing_snapshot_version`,
  `pricing_algorithm_version`, `pricing_rounding_rule_version`,
  `pricing_intent_type`, `pricing_intent_snapshot`, `pricing_resolved_locale`,
  `customer_start_at`, `customer_end_at`, `blocked_start_at`, `blocked_end_at`,
  `prep_buffer_minutes`, `cleanup_buffer_minutes`, `currency`,
  `subtotal_amount_minor`, `mandatory_fees_amount_minor`, `total_amount_minor`,
  `cancellation_policy_snapshot`.
- **Champs financiers depuis `payments`** : `tax_status`, `tax_amount_minor`,
  `tax_rate_bps`, `tax_rule_snapshot`, `commission_amount_minor`,
  `commission_rule_snapshot`, `terms_acceptance_snapshot`. Ces champs sont
  résolus à l'initiation du paiement par `resolveFinancialTerms` et copiés sans
  recalcul, pour les brouillons legacy ET flexibles.
- **Champs ligne** (`booking_draft_lines` → `booking_lines`) :
  `source_draft_line_id` (conditionnel), `pricing_plan_id`,
  `pricing_plan_version`, `pricing_plan_type`, `pricing_public_label`,
  `pricing_requested_duration_minutes`, `pricing_billed_duration_minutes`,
  `pricing_covered_duration_minutes`, `pricing_billed_days`,
  `pricing_selected_window`, `pricing_discount_threshold_days`,
  `pricing_discount_percent`, `pricing_amount_before_discount_minor`,
  `pricing_amount_after_discount_minor`.
- **`source_draft_line_id`** est positionné à `line.id` pour les lignes
  flexibles et à `null` pour les lignes legacy. Cette règle est imposée par le
  trigger `enforce_booking_line_pricing_coherence`.

**`initiatePayment`** valide `pricingSnapshotVersion` en mode fail-closed :
seules les valeurs `legacy-daily-v1` et `flexible-pricing-v1` sont acceptées.
Toute autre valeur provoque une erreur `VALIDATION` avant toute mutation DB.

**Document data loader** (`load-document-render-data.ts`) sélectionne les champs
flexibles et les inclut dans le snapshot de rendu pour les réservations
flexibles uniquement. Pour les réservations legacy, la forme du snapshot est
préservée (aucune donnée flexible artificielle n'est injectée).

**Parser de snapshot** (`parse-snapshot.ts`) accepte les nouvelles clés
optionnelles flexibles. Les types de snapshot sont mis à jour avec des champs
flexibles optionnels.

**Triggers de la migration 0033** imposent la copie exacte pour les champs de
pricing de location uniquement :

- `validate_flexible_booking_aggregates` (root) : valide que `bookings` est une
  copie exacte de `booking_drafts` pour les champs de pricing de location,
  période, fuseau et snapshot de pricing (comparés avec `IS DISTINCT FROM`).
  Les champs financiers (`tax_status`, `tax_amount_minor`, `tax_rate_bps`,
  `commission_amount_minor`) ne sont PAS comparés car ils proviennent de
  `payments` (autorité ADR-010 §6), pas du brouillon.
- `enforce_booking_line_pricing_coherence` (lines) : valide que chaque
  `booking_line` correspond à sa `booking_draft_line` source (référencée par
  `source_draft_line_id`).

**Flux legacy préservé** : aucune conversion rétroactive n'est tentée. Les
snapshots `legacy-daily-v1` restent lisibles et ne sont pas transformés. Aucune
donnée flexible artificielle n'est injectée dans les réservations legacy.

**Aucune migration 0034 nécessaire** : la migration 0033 contient déjà toutes
les colonnes et triggers requis.

### Tests

22 tests d'intégration couvrent tous les scénarios obligatoires : confirmation
flexible (copie root + lines), confirmation legacy (sans champs flexibles),
validation `pricingSnapshotVersion` fail-closed dans `initiatePayment`,
génération de documents pour réservations flexibles et legacy, et préservation
du flux legacy sans conversion rétroactive.

### Deblocage de G7D

G7D (recherche) est maintenant débloqué : G7P-B2-C étant terminé, la dépendance
G7P-B2 est satisfaite.
