# ADR-044 — Activation des familles raquettes et luge

- **Statut** : Acceptée pour l’implémentation
- **Date** : 2026-09-10
- **Décision métier référencée** : demande produit du 2026-09-10

## Contexte

La taxonomie commerciale outdoor est fermée par [`ADR-035`](./ADR-035-closed-outdoor-equipment-taxonomy.md).
Le registre serveur permet déjà les familles `ski` et `snowboard`, mais les
raquettes et la luge étaient encore exclues du périmètre actif. Le produit doit
pouvoir afficher et publier ces deux familles sans rouvrir les autres catégories
neige ni créer de pseudo-sous-types.

## Décision

Activer exactement deux nouvelles familles commerciales dans l’univers `snow` :

- `snowshoes` — libellé français **Raquettes** ;
- `sled` — libellé français **Luge**.

Ces familles sont des catégories de premier niveau, avec des parcours génériques
identiques aux autres équipements actifs : aucun sous-type, aucune
caractéristique obligatoire et aucune règle spécifique de disponibilité ou de
tarification.

Les accessoires, packs avalanche, snowscoot et autres familles non listées ne
sont pas activés par cette décision. Aucun produit historique ne doit être
converti et le fallback `equipment` reste interne.

## Conséquences

- Le registre Core, les libellés publics, la présentation loueur et la recherche
  doivent reconnaître les deux slugs canoniques.
- Une migration idempotente ajoute ou réactive uniquement `snowshoes` et `sled`
  dans `categories`.
- Les tests de taxonomie et de migrations vérifient les deux lignes et
  l’absence de mutation des produits existants.
- Toute activation d’une autre famille neige nécessitera une décision séparée.
