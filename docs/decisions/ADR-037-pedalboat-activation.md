# ADR-037 — Activation du pédalo

**Statut :** Accepted — activation commerciale de `pedalboat`.

**Date :** 2026-09-01

**Relie à :** [ADR-034](ADR-034-category-presentation-registry.md),
[ADR-035](ADR-035-closed-outdoor-equipment-taxonomy.md),
[ADR-036](ADR-036-pedalboat-preparation.md),
[`docs/product/equipment-taxonomy.md`](../product/equipment-taxonomy.md)

## Contexte

La préparation du pédalo était documentée par ADR-036, sans catégorie exposée
ni activation commerciale. Le contrat produit est maintenant verrouillé pour
activer une première famille de pédalo dans l'univers nautique, sans modifier
la Phase 1, les familles déjà actives ou les données historiques.

## Décision

Uttily active une seule famille commerciale sous le slug canonique
`pedalboat` :

- statut serveur : `ACTIVE` ;
- libellé français : « Pédalo » ;
- libellé anglais : « Pedal boat » ;
- aucun slug enfant ni catégorie par caractéristique ;
- capacité facultative, uniquement via les attributs de variante existants
  lorsqu'elle est déjà disponible ;
- aucune dimension, propulsion, valeur obligatoire ou caractéristique
  technique nouvelle.

Le registre fermé serveur reste l'autorité pour les mutations, la publication,
les sélecteurs et la recherche. La migration idempotente 0055 ajoute ou réactive
la ligne de catégorie `pedalboat` sans convertir `equipment`, `paddle` ou toute
autre donnée historique. Le seed local prépare la catégorie, mais ne publie pas
de fixture synthétique.

## Parcours et invariants

Le pédalo réutilise les parcours génériques loueur et public : Produit →
Variante → Exemplaire, photos, tarif, disponibilité transactionnelle,
publication, recherche, hold, paiement TEST, réservation et maintenance. Le
seuil universel existant de trois photos valides avant publication est conservé.

La présentation est nautique et neutre. Aucun Photo Coach, slot photo vélo,
règle de sécurité vélo, règle kayak ou règle paddle n'est appliqué. Les
permissions, l'isolation tenant, l'anti-surbooking, les snapshots de prix,
l'idempotence des paiements et les URLs restent inchangés.

## Hors périmètre

Cette activation ne convertit ni ne supprime les produits historiques
`equipment` ou `paddle`. Elle n'active aucune autre catégorie et n'ajoute pas
de moteur de packs, de suppléments, de composition automatique, de règle de
sécurité spécialisée ou d'accessoire publiable seul. Les décisions futures sur
les compléments conservent les modes `INCLUDED`, `MANDATORY`, `OPTIONAL_FREE`,
`PAID_SUPPLEMENT` et `SEPARATELY_RENTABLE`, sans implémentation dans cette
tranche.

## Preuves attendues

Les tests ciblés couvrent le registre, la migration et le seed, la présentation
neutre et les labels, la non-conversion historique, les sélecteurs et la
recherche active. Les parcours d'intégration loueur/public et Browser Clerk
TEST valident la création, les variantes, les exemplaires, les photos, le prix,
la disponibilité, la publication, la recherche, le hold, le paiement TEST et la
réservation. La validation exhaustive reste déléguée à la CI ; aucune suite
`test:full` n'est relancée localement.
