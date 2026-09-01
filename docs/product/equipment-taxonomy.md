# Taxonomie fermée des équipements outdoor

**Statut :** contrat produit canonique — périmètre verrouillé le 2026-09-01.

## Périmètre commercial

Uttily est une plateforme de location professionnelle spécialisée dans quatre
univers outdoor fermés :

| Univers | Slug d’univers | Familles prévues | Statut dans cette tranche |
| --- | --- | --- | --- |
| Cycle | `cycle` | `bike` | `ACTIVE` |
| Kayak, canoë et pagaie | `paddle` | `kayak` | `APPROVED_NEXT` |
| Surf et glisse nautique | `surf` | `surf` | `APPROVED_LATER` |
| Neige et glisse | `snow` | `ski` | `APPROVED_LATER` |

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
   `ski`).
3. **Caractéristiques ou sous-types** : valeurs descriptives de la famille,
   jamais des catégories ni des slugs indépendants.

| Famille | Sous-types ou caractéristiques canoniques |
| --- | --- |
| `bike` | sous-types `city`, `vtc`, `mtb`, `road`, `gravel`, `electric`, `cargo`, `child`, `tandem`, `fatbike` ; caractéristiques `size`, `autonomy` |
| `kayak` | `capacity` ; construction `rigid` ou `inflatable` ; pratique `sea`, `touring` ou `whitewater` |
| `surf` | sous-types `classic`, `longboard`, `softboard` |
| `ski` | sous-types `alpine`, `touring`, `cross-country` |

Le fait de couvrir l'univers « Kayak, canoë et pagaie » ne crée pas de slugs
`canoe` ou `paddle` dans cette tranche. Toute famille distincte devra être
explicitement approuvée avant son activation.

## Registre fermé côté serveur

La source de vérité typée est
[`packages/core/src/catalog/equipment-taxonomy.ts`](../../packages/core/src/catalog/equipment-taxonomy.ts).
Elle distingue :

- `ACTIVE` : famille activée commercialement ; aujourd'hui uniquement `bike` ;
- `APPROVED_NEXT` : famille approuvée pour le prochain lot ; aujourd'hui
  `kayak` ;
- `APPROVED_LATER` : famille approuvée mais différée ; aujourd'hui `surf` et
  `ski` ;
- `INTERNAL_FALLBACK` : `equipment`, compatibilité technique uniquement ;
- valeur inconnue : résolution `UNSUPPORTED`, sans conversion en catégorie
  commerciale.

Le registre prépare le contrat, mais cette tranche ne modifie ni les données
existantes, ni la recherche publique, ni les règles de publication, ni le
schéma de base. L'activation du kayak appartient au prochain lot dédié.

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
