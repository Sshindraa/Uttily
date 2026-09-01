# ADR-035 — Taxonomie commerciale outdoor fermée

**Statut :** Accepted — kayak activé comme première famille non-vélo.

**Date :** 2026-09-01

**Relie à :** [ADR-034](ADR-034-category-presentation-registry.md),
[`docs/product/equipment-taxonomy.md`](../product/equipment-taxonomy.md)

## Contexte

ADR-034 a généralisé la présentation des surfaces « Mes équipements » sans
déplacer les règles métier hors du serveur. Son fallback `equipment` protège la
compatibilité des écrans historiques, mais ne peut pas devenir une autorisation
implicite de publier n'importe quelle catégorie.

Le produit doit donc distinguer l'universalité du modèle
Produit → Variante → Exemplaire d'un périmètre commercial volontairement
fermé. Cette décision encadre l'activation du kayak sans convertir les
produits historiques qui utilisent `equipment`.

## Décision

Uttily est une plateforme commerciale fermée autour de quatre univers :

1. Cycle ;
2. Kayak, canoë et pagaie ;
3. Surf et glisse nautique ;
4. Neige et glisse.

Les catégories camping, outdoor technique, sports généralistes, outillage,
jardin, événementiel, audiovisuel et construction sont explicitement hors
périmètre. Uttily ne se présente pas comme une marketplace généraliste.

La taxonomie possède trois niveaux : univers, famille d'équipement,
caractéristiques ou sous-types. Une caractéristique n'a jamais son propre slug
de catégorie.

Le registre serveur fermé et typé est porté par
`packages/core/src/catalog/equipment-taxonomy.ts` :

| Statut | Familles |
| --- | --- |
| `ACTIVE` | `bike`, `kayak` |
| `APPROVED_NEXT` | — |
| `APPROVED_LATER` | `surf`, `ski` |
| `INTERNAL_FALLBACK` | `equipment`, compatibilité technique seulement |

Toute autre valeur est résolue comme `UNSUPPORTED`. Le fallback interne ne
peut pas être considéré comme une famille commerciale active. La migration
0051 ajoute uniquement la catégorie canonique `kayak`; elle ne met à jour
aucun produit existant utilisant `equipment`. La fixture `kayak-dev` est la
seule fixture locale explicitement rattachée à cette catégorie.

Le kayak consomme les parcours génériques déjà en place : Produit → Variante
→ Exemplaire, prix, disponibilité, photos, publication, recherche, hold,
paiement et réservation. Ses attributs descriptifs `capacity`, `construction`
et `practice` ne sont affichés que lorsqu'ils existent dans les attributs de
la variante. Ils n'introduisent aucune validation ou colonne nouvelle.

## Compléments

Le contrat prépare les modes `INCLUDED`, `MANDATORY`, `OPTIONAL_FREE`,
`PAID_SUPPLEMENT` et `SEPARATELY_RENTABLE`. Ce dernier nécessite une
autorisation explicite d'Uttily et du loueur. Les accessoires des quatre
univers sont désactivés pour une publication autonome par défaut.

Ces valeurs ne constituent pas encore un moteur de supplément, une règle de
stock ou une mutation : aucun schéma ni calcul n'est ajouté dans cette ADR.

## Relation avec ADR-034

ADR-034 reste l'ADR de présentation. Le registre frontend peut continuer à
afficher une présentation générique pour `equipment` ou une valeur inconnue
afin de préserver les URLs et les interfaces historiques. Cette présentation
ne vaut ni support commercial ni droit de publication ; l'état commercial est
résolu exclusivement par le registre serveur de cette ADR.

## Conséquences et limites

- Le vélo reste le premier module approfondi et conserve ses règles déjà
  validées par ADR-031.
- Le kayak est actif comme première famille non-vélo. Il utilise le
  gestionnaire photo neutre, le seuil universel de trois photos valides et les
  règles de disponibilité, publication et réservation existantes ; aucun Photo
  Coach, slot ou bloc de sécurité vélo ne lui est appliqué.
- Surf et ski sont explicitement approuvés pour plus tard, sans activation.
- Les catégories hors périmètre et les valeurs inconnues doivent être refusées
  par les futurs flux commerciaux plutôt que converties silencieusement en
  `equipment`.
- Les familles surf et ski devront ajouter leurs propres décisions et tests
  avant activation. Les accessoires kayak restent des compléments non
  publiables seuls par défaut ; leur moteur de supplément n'est pas livré.
