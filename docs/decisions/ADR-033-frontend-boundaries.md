# ADR-033 — Frontend par routes, features et primitives UI

**Statut :** Accepted — migration progressive, sans réécriture fonctionnelle.

**Date :** 2026-08-31

## Contexte

L'application Web possède déjà les bons niveaux techniques : les routes Next.js
dans `apps/web`, les règles métier dans `packages/core`, les contrats partagés
et les primitives visuelles dans `@uttily/ui`. Leur organisation rend toutefois
les frontières difficiles à lire : certaines pages mélangent orchestration
serveur, transformation de données et plusieurs centaines de lignes de JSX ; le
package UI concentre encore toutes ses primitives dans un seul fichier.

Une réécriture du frontend ferait courir un risque inutile sur les parcours de
réservation et d'exploitation déjà validés. La migration doit donc améliorer la
structure sans modifier les contrats runtime, les règles métier ou le schéma.

## Décision

Le frontend suit trois niveaux, dans cet ordre de dépendance :

```text
app (routage et orchestration)
  ↓
features (expérience par domaine produit)
  ↓
packages/ui (primitives visuelles génériques)
```

- `app/**/page.tsx` lit les paramètres, autorise et charge les données côté
  serveur, puis compose une feature. Une page peut conserver une composition
  simple ; les écrans volumineux sont extraits progressivement.
- `apps/web/src/features/<domain>` contient les composants et présentations
  propres à un domaine (`bookings`, `equipment`, `fleet`, `locations`,
  `finances`, `search`, `checkout`, `onboarding`). Une feature ne contient pas
  de règle de disponibilité, de transition, de paiement ou d'autorisation : ces
  règles restent dans `packages/core`.
- `apps/web/src/components/shells` contient les deux shells officiels,
  `ClientShell` et `ProShell`. Ils portent la navigation et le cadre commun,
  pas les use-cases métier.
- `packages/ui` ne dépend ni de Next.js ni des use-cases Uttily. Il expose des
  primitives (`Button`, `Card`, `Badge`, `Dialog`, etc.) et les tokens visuels.
  Un composant métier comme `BookingStatusBadge` reste dans sa feature.

La migration commence par le découpage de `packages/ui/src/primitives.tsx` en
modules composant-owned, en conservant les exports publics existants. Les deux
premières livraisons extraient les actions, l'icône, les contrôles de formulaire,
les conteneurs, les états et les headers en modules composant-owned. Les routes
et shells sont déplacés ensuite par tranches fonctionnelles, avec leurs tests.

## Règles de contribution

1. Les couleurs d'interface viennent des tokens `--ut-*` ; aucune nouvelle
   couleur HEX ne doit être introduite dans `apps/web`.
2. Les actions utilisent `Button`, `LinkButton` ou `IconButton` ; les cartes
   génériques utilisent `Card`.
3. Les pages restent une couche d'orchestration ; la grosse UI va dans la
   feature du domaine concerné.
4. Une primitive ne connaît aucun concept métier, aucune organisation et aucun
   fournisseur de paiement.
5. Les styles inline restent réservés aux valeurs réellement dynamiques.

## Conséquences

- les changements de tokens ou de primitives se propagent sans dupliquer la
  présentation dans chaque route ;
- les règles métier restent protégées par les frontières serveur existantes ;
- les imports historiques de `@uttily/ui` restent valides pendant la migration ;
- chaque extraction ajoute ou conserve un test ciblé avant de passer à la
  surface suivante.

## Hors périmètre

Cette décision ne crée pas de nouvelle logique métier, d'API, de package ou de
microservice. Elle ne change pas l'arborescence des URLs et ne demande aucune
migration de base de données.
