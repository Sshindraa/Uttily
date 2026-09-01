# Taxonomie fermée des équipements outdoor

**Statut :** contrat produit canonique — périmètre verrouillé le 2026-09-01.

## Périmètre commercial

Uttily est une plateforme de location professionnelle spécialisée dans quatre
univers outdoor fermés :

| Univers | Slug d’univers | Familles prévues | Statut dans cette tranche |
| --- | --- | --- | --- |
| Cycle | `cycle` | `bike` | `ACTIVE` |
| Kayak, canoë et pagaie | `paddle` | `kayak` | `ACTIVE` |
| Surf et glisse nautique | `surf` | `surf` | `ACTIVE` |
| Neige et glisse | `snow` | `ski`, `snowboard` | `ACTIVE` |

Le registre n'autorise pas les catégories camping, outdoor technique, sports
généralistes, outillage, jardin, événementiel, audiovisuel ou construction.
Une valeur absente du registre est **non supportée**. Le slug technique
`equipment` existe uniquement pour préserver la compatibilité des données et
des interfaces historiques ; il ne constitue pas une famille commerciale
publiable.

## Trois niveaux, sans explosion des slugs

La taxonomie sépare strictement :

1. **Univers** : regroupement commercial fermé (`cycle`, `paddle`, `surf`,
   `snow`).
2. **Famille d'équipement** : slug stable du produit (`bike`, `kayak`, `surf`,
   `ski`, `snowboard`).
3. **Caractéristiques ou sous-types** : valeurs descriptives de la famille,
   jamais des catégories ni des slugs indépendants.

| Famille | Sous-types ou caractéristiques canoniques |
| --- | --- |
| `bike` | sous-types `city`, `vtc`, `mtb`, `road`, `gravel`, `electric`, `cargo`, `child`, `tandem`, `fatbike` ; caractéristiques `size`, `autonomy` |
| `kayak` | `capacity` ; construction `rigid` ou `inflatable` ; pratique `sea`, `touring` ou `whitewater` |
| `surf` | sous-types `classic`, `longboard`, `softboard`, `bodyboard`, `skimboard` |
| `ski` | sous-types `alpine`, `touring`, `cross-country` |
| `snowboard` | aucun sous-type ou caractéristique spécialisé dans cette tranche |

Le fait de couvrir l'univers « Kayak, canoë et pagaie » ne crée pas de slugs
`canoe` ou `paddle` dans cette tranche. Toute famille distincte devra être
explicitement approuvée avant son activation.

## Registre fermé côté serveur

La source de vérité typée est
[`packages/core/src/catalog/equipment-taxonomy.ts`](../../packages/core/src/catalog/equipment-taxonomy.ts).
Elle distingue :

- `ACTIVE` : familles activées commercialement ; aujourd'hui `bike`, `kayak`,
  `surf`, `ski` et `snowboard` ;
- `APPROVED_NEXT` : famille approuvée pour le prochain lot ; aucune après
  l'activation du kayak ;
- `APPROVED_LATER` : familles approuvées mais différées ; aucune dans le
  registre actuel ;
- `INTERNAL_FALLBACK` : `equipment`, compatibilité technique uniquement ;
- valeur inconnue : résolution `UNSUPPORTED`, sans conversion en catégorie
  commerciale.

L'activation du kayak ajoute sa catégorie canonique via la migration 0051 et
met à jour uniquement la fixture locale `kayak-dev`. Les produits historiques
`equipment` ne sont pas convertis. Le kayak réutilise les données, la
recherche, la publication et les parcours de réservation existants ; ses
caractéristiques descriptives ne sont affichées que si elles sont présentes.

L'activation surf réutilise la catégorie déjà seedée `surf`, sans migration et
sans conversion des produits `equipment`. Elle active uniquement la famille
et ses sous-types descriptifs `classic`, `longboard`, `softboard`, `bodyboard`
et `skimboard`. Aucun champ dimensions, volume ou niveau, aucune règle
spécialisée de glisse et aucun moteur d'accessoires n'est ajouté.

L'activation ski réutilise la catégorie déjà seedée `ski`, sans migration et
sans conversion des produits `equipment`. Elle active uniquement les sous-types
descriptifs `alpine`, `touring` et `cross-country` du même slug `ski`. Les
variantes existantes portent l'information lorsqu'elle est disponible ; aucun
champ de mensuration, niveau ou longueur de bâton n'est ajouté. Le télémark,
les raquettes, les luges, le snowscoot et les packs avalanche restent désactivés.

L'activation snowboard ajoute la catégorie canonique `snowboard` via la
migration 0052, sans conversion des produits historiques `equipment`. Aucun
sous-type, champ ou caractéristique spécialisée n'est introduit. Le parcours
générique et les photos neutres sont réutilisés, sans règle vélo ou ski.

## Compléments

Les modes futurs d'un complément sont :

- `INCLUDED` — inclus avec l'équipement principal ;
- `MANDATORY` — requis pour l'usage autorisé ;
- `OPTIONAL_FREE` — optionnel et gratuit ;
- `PAID_SUPPLEMENT` — supplément payant ;
- `SEPARATELY_RENTABLE` — louable séparément uniquement si Uttily et le loueur
  l'autorisent.

Les accessoires vélo, nautisme, surf et neige ne sont pas publiables seuls par
défaut. Aucun schéma de complément ni moteur de supplément n'est créé ici ; les
règles de stock, prix, disponibilité et autorisation feront l'objet d'une
décision avant leur implémentation.
