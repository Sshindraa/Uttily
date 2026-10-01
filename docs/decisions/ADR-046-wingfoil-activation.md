# ADR-046 — Activation de la famille wingfoil

- **Statut** : Acceptée pour l’implémentation
- **Date** : 2026-09-11
- **Décision métier référencée** : ajout du wingfoil à l’offre nautique

## Contexte

Le produit doit distinguer le nom commercial de la pratique de la technologie
utilisée. « Foil » seul est trop générique : il peut désigner plusieurs
pratiques de glisse et ne permet pas à un client ou à un loueur de comprendre
quelle offre est sélectionnée. Le terme `wingfoil` identifie précisément la
pratique combinant une wing, une planche et un foil.

## Décision

`wingfoil` devient une famille commerciale `ACTIVE` de l’univers `surf`.

- Le slug canonique est `wingfoil`.
- Le libellé public est « Wingfoil » en français comme en anglais.
- La recherche reconnaît `wingfoil`, `wing foil`, `wingfoiling` et `wing foiling` ;
  le terme `foil` seul ne sélectionne pas cette famille.
- Aucun sous-type, attribut obligatoire, accessoire autonome ou règle de
  sécurité spécialisée n’est introduit dans cette tranche.
- Les parcours génériques Produit → Variante → Exemplaire, photos neutres,
  tarification, disponibilité, publication, recherche, hold, paiement TEST et
  réservation sont réutilisés.
- La migration 0062 ajoute ou réactive uniquement la catégorie canonique, sans
  convertir les produits historiques `surf` ou `equipment`.

## Conséquences

Le catalogue présente Wingfoil comme une famille autonome, au même niveau que
Surf et Bodyboard. Un futur travail pourra modéliser les composants d’un pack
wingfoil ou les contraintes de niveau, mais aucune règle de ce type n’est
inventée ici.

Le choix « Wingfoil » évite de mélanger cette pratique avec le surf foil,
kitefoil, eFoil ou d’autres usages du foil. Ces pratiques restent hors du
périmètre tant qu’une décision dédiée n’est pas prise.
