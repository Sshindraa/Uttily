# ADR-047 — Filtres publics des sous-types de vélo

**Statut :** Accepted

**Date :** 2026-09-11

## Contexte

La famille commerciale `bike` couvre plusieurs usages compréhensibles par les
locataires : VTT, vélo de ville, vélo de route et vélo cargo. Créer une
catégorie de base par usage ferait diverger la taxonomie fermée et les règles
de publication déjà attachées à `bike`.

## Décision

Uttily expose quatre filtres précis sous la famille `bike` :

| Slug | Libellé français | Libellé anglais |
| --- | --- | --- |
| `mtb` | VTT | Mountain bike |
| `city` | Vélo de ville | City bike |
| `road` | Vélo de route | Road bike |
| `cargo` | Vélo cargo | Cargo bike |

Le produit conserve la catégorie commerciale `bike`. Le sous-type est porté
par l'attribut de variante JSONB `attributes.subtype`, avec une valeur issue du
registre fermé de `@uttily/contracts`. Aucun slug de catégorie enfant, aucune
migration de catégorie et aucune nouvelle famille commerciale ne sont ajoutés.

La recherche publique accepte `bikeSubtype`, l'inclut dans l'empreinte du
curseur et applique le filtre côté PostgreSQL sur la variante et son stock
actif. Les vélos existants qui ne portent pas encore cet attribut restent
visibles dans la recherche générale `bike`, mais ne sont pas présentés comme
correspondant à un sous-type précis.

L'interface loueur permet d'annoter la première variante lors de la création
ou de la configuration d'un équipement. L'assistance électrique reste une
caractéristique indépendante ; elle ne crée pas un cinquième filtre dans ce
lot.

## Conséquences

- La distinction est cohérente entre le panneau de recherche, l'URL et le
  moteur de résultats.
- Les règles existantes de publication, disponibilité, réservation et
  paiement restent celles de `bike`.
- Ajouter d'autres sous-types publics ou transformer ces valeurs en familles
  commerciales nécessitera une décision dédiée.
