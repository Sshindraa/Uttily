# ADR-035 — Taxonomie commerciale outdoor fermée

**Statut :** Accepted — contrat canonique préparatoire à l'activation du kayak.

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
fermé. Cette décision intervient avant l'activation du kayak et ne demande ni
migration ni modification des données existantes.

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
| `ACTIVE` | `bike` |
| `APPROVED_NEXT` | `kayak` |
| `APPROVED_LATER` | `surf`, `ski` |
| `INTERNAL_FALLBACK` | `equipment`, compatibilité technique seulement |

Toute autre valeur est résolue comme `UNSUPPORTED`. Le fallback interne ne
peut pas être considéré comme une famille commerciale active. Cette ADR ne
branche pas encore le registre sur la recherche, les données ou le gate de
publication : elle fixe le contrat qui devra être consommé par un lot
d'activation ultérieur.

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

- Le vélo reste le seul univers actif et conserve ses règles approfondies déjà
  validées par ADR-031.
- Le kayak est le prochain candidat d'activation, mais aucune règle kayak,
  donnée, recherche ou publication n'est introduite ici.
- Surf et ski sont explicitement approuvés pour plus tard, sans activation.
- Les catégories hors périmètre et les valeurs inconnues doivent être refusées
  par les futurs flux commerciaux plutôt que converties silencieusement en
  `equipment`.
- Une activation de famille devra ajouter ses propres décisions et tests pour
  les attributs, variantes, photos, entretien, sécurité, prix, caution et
  publication.
