# Réservations et disponibilité

## Principe

PostgreSQL est l'autorité finale. Une lecture peut être mise en cache, mais seule une transaction PostgreSQL décide qu'un exemplaire est libre et crée son blocage.

## Produit et exemplaire

```text
Produit : Paddle Aqua Marina 10'4
Exemplaires : PAD-001, PAD-002, PAD-003
```

Le produit est commercial. L'exemplaire est l'objet physique réellement réservé, entretenu et rendu.

## Périodes

Chaque location garde deux intervalles :

```text
customer_start_at / customer_end_at  : période vendue au client
blocked_start_at / blocked_end_at    : période réellement indisponible
```

La période bloquée inclut la préparation, le contrôle, le nettoyage et une éventuelle marge opérationnelle.

## Blocages d'inventaire

Une table conceptuelle unique représente les périodes indisponibles :

```text
InventoryBlock
- inventory_item_id
- type: HOLD | BOOKING | MAINTENANCE | MANUAL_BLOCK
- blocked_period
- status: ACTIVE | PAYMENT_PROCESSING | CONVERTED | RELEASED | EXPIRED
- expires_at (uniquement pour HOLD)
- source_id
```

Une contrainte d'exclusion PostgreSQL interdit le chevauchement de deux blocs actifs incompatibles pour un même `inventory_item_id`. La maintenance est donc protégée par la même règle que les réservations.

Un bloc soft-deleted (`deleted_at` non null) ne bloque plus : il est exclu de la contrainte d'exclusion et de la recherche de disponibilité. Le soft-delete sert à corriger une erreur de saisie sans perdre l'historique, tout en libérant immédiatement l'exemplaire.

## Flux de réservation

1. Le client demande une disponibilité.
2. Uttily attribue immédiatement les exemplaires dans une transaction.
3. Uttily crée un `HOLD` actif, expirant en général après dix minutes.
4. Uttily crée ou réutilise le paiement avec une clé d'idempotence.
5. Le webhook de paiement est la source de vérité.
6. En transaction, un paiement réussi convertit le hold en réservation confirmée.
7. Un événement est écrit dans l'outbox : confirmation, contrat et notification sont traités par le worker.

Un worker expire les holds abandonnés. Il ne libère pas un hold dont le paiement est encore en traitement sans vérifier l'état réel du paiement.

## États d'une réservation

```text
DRAFT
→ HELD
→ PAYMENT_PENDING
→ CONFIRMED
→ READY_FOR_PICKUP
→ ACTIVE
→ RETURNED
→ CLOSED

HELD / PAYMENT_PENDING → EXPIRED | CANCELLED
CONFIRMED → CANCELLED | REFUNDED
```

Les transitions sont validées par le domaine, jamais seulement par l'interface.

## Limites du MVP

- Un panier correspond à une organisation et un établissement de retrait.
- Les exemplaires sont attribués dès le hold.
- Les moyens de paiement différés sont reportés.
- Une caution est une stratégie distincte du paiement de location.

## Tarification flexible et recherche temporelle (ADR-018)

> ADR-018 (2026-08-07, Accepted). G7P-A Round 2 (schéma) implémenté (migration 0032).
> G7P-B1 (moteur de calcul read-only) implémenté. G7P-B2-A (snapshot, contraintes,
> triggers) implémenté. G7P-B2-B (intégration dans `createBookingDraftWithHold`)
> Round 2 terminé et validé. G7P-B2-C (migration des flux existants) implanté. Voir
> `docs/decisions/ADR-018-flexible-rental-duration-pricing-and-modification.md`.

Le modèle daily-only actuel (`daily_price_amount_minor`, `billableUnit = 'DAY'`,
calcul exclusif par jours civils) sera remplacé par un modèle de plans
tarifaires par variante supportant les types `HOURLY`, `FIXED_DURATION` et
`DAILY`. La recherche supportera deux intentions temporelles : `TIME_RANGE`
(date et heure locales de début et de fin) pour les locations horaires ou
forfaitaires, et `DAY_RANGE` (date de début, date de fin exclusive) pour les
locations multi-jours.

Le hold PostgreSQL reste l'autorité finale pour l'allocation transactionnelle.
Les buffers de préparation et nettoyage continuent de s'appliquer. Les
snapshots financiers sont étendus pour inclure le plan retenu, le type de plan,
la durée facturée, le palier de réduction appliqué, le pourcentage, le montant
avant/après réduction et la règle d'arrondi versionnée. Le snapshot reste
immuable après confirmation.

Le moteur tarifaire est déterministe, auditable, reproductible, testé, calculé
côté serveur et figé dans le snapshot. La sélection tarifaire charge les plans
actifs et compatibles, écarte les plans qui ne couvrent pas la durée demandée,
calcule le prix total de chaque plan éligible, sélectionne le total le moins
cher et applique des tie-breakers déterministes en cas d'égalité exacte
(forfait exact, plus petite durée incluse couvrant la demande, moins de temps
inutilisé, identifiant/version stable). Elle présente un seul plan retenu
avec le détail du total. Le champ `priority` est limité à un tie-break non
financier après égalité de montant et ne peut jamais forcer le choix d'un plan
plus cher.

**G7P-B1 (implémenté)** : Le moteur de calcul pur (`computeQuote`) est séparé
du chargement DB (`loadPricingContext`). Le use case `quoteFlexiblePricing(db,
input)` orchestre les deux. Le moteur est read-only (aucun effet de bord) et
produit un devis déterministe avec `algorithmVersion: 'flexible-pricing-v1'` et
`roundingRuleVersion: 'half-up-v1'`. Il n'est pas encore intégré au flux de
réservation (création de brouillon, hold, paiement) — c'est l'objet de G7P-B2.

L'implémentation daily-only actuelle reste en place tant que G7P-B2 n'est pas
livré. Le flux de réservation existant décrit ci-dessus n'est pas modifié.

**G7P-B2-A Round 3 (implémenté)** : Les fondations du schéma de snapshot de prix
flexible sont en place (migration 0033). Les tables `booking_drafts`,
`booking_draft_lines`, `bookings` et `booking_lines` sont étendues avec des
colonnes de snapshot flexible (`pricing_snapshot_version`,
`pricing_algorithm_version`, `pricing_rounding_rule_version`,
`pricing_intent_type`, `pricing_intent_snapshot`, `pricing_resolved_locale`
sur les drafts et bookings ; `pricing_plan_id`, `pricing_plan_version`,
`pricing_plan_type`, `pricing_public_label`, durées facturées, fenêtre
sélectionnée, paliers de remise et montants avant/après remise sur les lignes).
`booking_lines` dispose en plus de `source_draft_line_id`, une FK DEFERRABLE
avec un index unique vers `booking_draft_lines(id)`. Cette colonne est la
**seule source de vérité** pour la copie `booking_draft_lines` → `booking_lines` :
le trigger `enforce_booking_line_pricing_coherence` ne consulte plus le
catalogue mutable (`pricing_plans`, `pricing_plan_translations`, `locations`).
Un plan `RETIRED`, un plan local activé postérieurement ou une traduction modifiée
n'ont donc aucun effet sur la confirmation. Le root `bookings` est contraint à
être une copie exacte de `booking_drafts` (mêmes dates client, buffers, montants,
métadonnées pricing, etc.) par `validate_flexible_booking_aggregates`.
Les vérifications d'agrégats et de copie sont des CONSTRAINT TRIGGER DEFERRABLE
INITIALLY DEFERRED, déclenchés sur `INSERT` ou `UPDATE OF status`, ce qui permet
d'insérer parent et lignes dans n'importe quel ordre avant le `COMMIT`.
Des contraintes CHECK garantissent la cohérence financière (montants >= 0 et <=
`Number.MAX_SAFE_INTEGER`, cohérence avant/après remise, union discriminée
HOURLY/FIXED_DURATION/DAILY). Des triggers PostgreSQL assurent l'immutabilité
du snapshot financier après création (seuls `status`, `expires_at` et
`updated_at` sont modifiables sur les drafts ; les lignes et les bookings sont
insert-only) et la cohérence multi-tenant (plan et draft de même organisation
et même devise). Les snapshots legacy (`legacy-daily-v1`) restent lisibles et
ne sont pas convertis. Cette fondation n'est pas encore intégrée au flux de
réservation — c'est l'objet de G7P-B2-B.

**G7P-B2-B (Round 2 terminé et validé)** : Le moteur flexible est intégré au flux de réservation
via `createBookingDraftWithHold`. Deux modes de tarification coexistent :

- **LEGACY** (`LegacyCreateBookingDraftInput`) : chemin existant, crée des
  brouillons `legacy-daily-v1`. Comportement inchangé.
- **FLEXIBLE** (`FlexibleCreateBookingDraftInput`) : crée des brouillons
  `flexible-pricing-v1` avec `intentType` `TIME_RANGE` ou `DAY_RANGE`.

Le dispatch sur `pricingMode` est fermé : `'FLEXIBLE'` → chemin flexible,
`'LEGACY'` ou `undefined` → chemin legacy, toute autre valeur → erreur
`VALIDATION` avant toute mutation DB.

Pour `DAY_RANGE`, les bornes sont calculées sur le premier et le dernier jour
(`DayRangeDayBoundary`) : la fenêtre commerciale du premier jour définit
l'heure de début locale, celle du dernier jour définit l'heure de fin locale.
Les horaires d'ouverture sont vérifiés uniquement sur le premier et le dernier
jour ; les jours intermédiaires peuvent être fermés. La sélection de fenêtre
(`findDayRangeWindow`) choisit la fenêtre de plus grande durée, avec tie-break
déterministe sur l'heure de début la plus tôt.

Le chemin flexible utilise une transition **DRAFT → HELD** : le draft est
inséré en statut `DRAFT` (permettant l'insertion des lignes), puis les lignes
sont insérées, puis le draft passe en `HELD` (UPDATE de `status` uniquement),
et enfin les blocs d'inventaire et allocations sont créés. Cette séquence
respecte les triggers d'immutabilité qui n'autorisent l'INSERT de lignes que
lorsque le parent est `DRAFT`.

Avant la transition vers `HELD`, la commande `SET CONSTRAINTS` cible
spécifiquement les contraintes `"booking_draft_lines_pricing_plan_id_fk"`,
`"after_validate_flexible_draft_aggregates_line"` et
`"after_validate_flexible_draft_aggregates_draft"` en mode `IMMEDIATE`,
exécutée à l'intérieur du savepoint pour forcer l'évaluation des triggers
d'agrégats différés (`DEFERRABLE INITIALLY DEFERRED`). Toute incohérence
d'agrégats est ainsi détectée avant l'allocation d'inventaire, sans attendre
le `COMMIT`. Après le savepoint, le mode `DEFERRED` est restauré.

La conversion des heures locales en UTC utilise
`localDateTimeToUtc(local, timeZone)` avec gestion DST fail-closed : les heures
inexistantes (spring-forward) et ambiguës (fall-back) sont rejetées
(`LocalToUtcError` → code `VALIDATION`). Le support des fuseaux globaux (IANA)
est robuste et sans dépendance à la locale système.

Le `resolvedLocale` retourné par le moteur (`quoteResult.resolvedLocale`) est
persisté dans `pricing_resolved_locale` et inclus dans le responseBody, au
lieu de `input.locale`. L'empreinte idempotente canonicalise la locale via
`Intl.getCanonicalLocales()` (BCP 47).

Le `billableUnitCount` provient directement du moteur
(`quoteLine.billableUnitCount`), non reconstruit par ratio. Le
`billableUnitCount` au niveau du draft est la somme des
`billableUnitCount * quantity` de chaque ligne.

Le `pricing_selected_window` stocke le `PricingWindowSnapshot` du moteur
(union discriminée `TIME_RANGE_WINDOW | DAY_RANGE_BOUNDARIES`). Le trigger
`enforce_draft_line_pricing_coherence` valide la structure du snapshot.

Les erreurs d'infrastructure (`PRICING_CONTEXT_UNAVAILABLE`) ne sont pas
persistées comme des erreurs métier : l'erreur brute est relancée (conforme à
ADR-009), aucun `FAILED` n'est enregistré, et le message PostgreSQL original
n'est jamais exposé.

L'implémentation daily-only existante reste en place. Le flux de réservation
legacy décrit ci-dessus n'est pas modifié.

**G7P-B2-C (implanté)** : La migration des flux existants (confirmation, paiement,
documents) est terminée. Le flux de confirmation (`applyBookingConfirmation`)
copie désormais tous les champs flexibles de snapshot de `booking_drafts` →
`bookings` et `booking_draft_lines` → `booking_lines`. `source_draft_line_id`
est le lien explicite entre `booking_line` et `draft_line` : non-null pour les
lignes flexibles, null pour les lignes legacy. `initiatePayment` valide
`pricingSnapshotVersion` en mode fail-closed (seules `legacy-daily-v1` et
`flexible-pricing-v1` sont acceptées). Le flux legacy est préservé (aucune
conversion rétroactive). Les triggers de la migration 0033 imposent la copie
exacte pour les réservations flexibles (root et lignes). Le document data loader
(`load-document-render-data.ts`) sélectionne les champs flexibles pour les
réservations flexibles uniquement.

### Flux de confirmation pour les réservations flexibles

Le brouillon est la **seule source de vérité** lors de la confirmation. Aucun
re-lecture de `pricing_plans`, aucun recalcul et aucune reconversion UTC ne sont
effectués : le snapshot figé dans le brouillon est copié tel quel vers la
réservation.

- Le trigger `validate_flexible_booking_aggregates` valide que le root `bookings`
  est une copie exacte de `booking_drafts` (mêmes dates client, buffers, montants,
  métadonnées pricing, etc. — tous les champs comparés avec `IS DISTINCT FROM`).
- Le trigger `enforce_booking_line_pricing_coherence` valide que chaque
  `booking_line` correspond à sa `booking_draft_line` source, référencée par
  `source_draft_line_id`. Le trigger ne consulte pas le catalogue mutable
  (`pricing_plans`, `pricing_plan_translations`, `locations`) : un plan
  `RETIRED`, un plan local activé postérieurement ou une traduction modifiée
  n'ont aucun effet sur la confirmation.
