# ADR-045 — Activation de la famille bodyboard

- **Statut** : Acceptée pour l’implémentation
- **Date** : 2026-09-10
- **Décision métier référencée** : ajout produit de la famille bodyboard

## Contexte

Le `bodyboard` était déjà mentionné comme sous-type descriptif de la famille
`surf`. Cette représentation ne permettait pas à un client de rechercher ou à
un loueur de publier une offre bodyboard comme équipement distinct, alors que
les usages, les stocks et les prix peuvent être gérés séparément d’une planche
de surf.

La taxonomie Uttily distingue les familles commerciales des sous-types. Il
faut donc choisir un slug canonique sans modifier les produits historiques.

## Décision

Activer `bodyboard` comme famille commerciale `ACTIVE` de l’univers `surf`.

- Libellé français : **Bodyboard**
- Libellé anglais : **Bodyboard**
- Sous-types : aucun
- Caractéristiques obligatoires : aucune
- Accessoires autonomes : désactivés par défaut

Les nouvelles offres bodyboard réutilisent le parcours générique
Produit → Variante → Exemplaire, les trois photos valides requises, la
tarification, la disponibilité, la publication, la recherche, le hold, le
paiement TEST et la réservation. Aucun Photo Coach, slot photo vélo, règle
surf spécialisée ou moteur de packs n’est ajouté.

La migration idempotente `0061_activate_bodyboard_category.sql` ajoute ou
réactive uniquement la catégorie canonique `bodyboard`. Aucun produit
historique `surf`, `equipment` ou autre catégorie n’est converti.

La valeur historique `bodyboard` éventuellement stockée comme attribut d’une
variante `surf` reste inchangée et n’est pas réinterprétée automatiquement.

## Conséquences

- Le registre Core, les libellés publics, la présentation loueur et la
  recherche reconnaissent le slug `bodyboard`.
- Le bodyboard apparaît dans le filtre public « Sur l’eau » comme famille
  distincte du surf.
- Le socle de présentation et d’opérations reste générique ; aucun nouveau
  schéma métier, pack ou accessoire publiable seul n’est introduit.
- Toute future spécialisation du bodyboard nécessitera une décision séparée.
