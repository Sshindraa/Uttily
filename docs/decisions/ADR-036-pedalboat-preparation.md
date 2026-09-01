# ADR-036 — Préparation du pédalo sans activation

**Statut :** Superseded pour le statut commercial par
[ADR-037](ADR-037-pedalboat-activation.md) — ce document conserve la décision
historique de préparation.

**Date :** 2026-09-01

**Relie à :** [ADR-034](ADR-034-category-presentation-registry.md),
[ADR-035](ADR-035-closed-outdoor-equipment-taxonomy.md),
[`docs/product/equipment-taxonomy.md`](../product/equipment-taxonomy.md)

## Contexte

Les sept familles commerciales actives restent inchangées après le lot
`taxonomy enforcement`. Le pédalo appartient au même univers nautique, mais
aucune décision d'activation commerciale n'est encore prise. Cette ADR prépare
un contrat explicite sans créer de catégorie exposée ni de nouveau parcours.

## Contrat proposé

- slug interne proposé : `pedalboat` ;
- une seule famille, sans slug enfant ;
- libellés proposés : « Pédalo » en français et « Pedal boat » en anglais ;
- capacité éventuellement portée par les attributs de variante déjà existants,
  sans valeur obligatoire ;
- modèle Produit → Variante → Exemplaire inchangé ;
- présentation nautique générique et photos neutres, sans Photo Coach, slots
  vélo ni règle kayak, paddle ou vélo.

Le contrat est au statut de préparation `INACTIVE`. Tant qu'une décision
d'activation n'est pas prise, `pedalboat` ne fait pas partie du registre des
familles commerciales actives et reste résolu comme catégorie non supportée par
les flux commerciaux.

## Garde-fous de non-exposition

Cette tranche ne crée aucune migration, catégorie de base, fixture publiée,
entrée d'onboarding, filtre de recherche publique, offre réservable ou parcours
de réservation. Les sélecteurs et mutations continuent de dépendre du registre
fermé serveur, qui conserve exactement les sept familles actives.

Les slugs `equipment` et `paddle`, ainsi que toutes les données historiques,
restent inchangés et consultables selon les règles existantes. Aucune conversion,
suppression ou promotion implicite vers `pedalboat` n'est effectuée.

## Compléments

Les accessoires nautiques associés au pédalo restent des compléments et ne sont
pas publiables seuls par défaut. Leurs futurs modes sont ceux déjà documentés
par ADR-035 : inclus, obligatoire, optionnel gratuit, supplément payant ou
louable séparément avec autorisation explicite d'Uttily et du loueur. Aucun
moteur de packs, de suppléments, de stock ou de composition automatique n'est
ajouté.

## Décision nécessaire avant activation

Avant toute activation, le produit doit confirmer le slug canonique, le statut
commercial, l'usage de l'attribut de capacité existant et les critères complets
de publication. Cette décision devra être suivie de preuves dédiées pour les
parcours loueur/public, les photos neutres, la disponibilité, l'isolation
tenant, le hold, le paiement TEST et la réservation. Elle ne devra modifier ni
les URL ni les invariants communs.
