# Taxonomie fermée des équipements outdoor

**Statut :** contrat produit canonique — périmètre verrouillé le 2026-09-01.

## Périmètre commercial

Uttily est une plateforme de location professionnelle spécialisée dans quatre
univers outdoor fermés :

| Univers | Slug d’univers | Familles prévues | Statut dans cette tranche |
| --- | --- | --- | --- |
| Cycle | `cycle` | `bike` | `ACTIVE` |
| Kayak, canoë et pagaie | `paddle` | `kayak`, `canoe`, `paddleboard` | `ACTIVE` |
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
2. **Famille d'équipement** : slug stable du produit (`bike`, `kayak`, `canoe`,
   `paddleboard`, `surf`, `ski`, `snowboard`).
3. **Caractéristiques ou sous-types** : valeurs descriptives de la famille,
   jamais des catégories ni des slugs indépendants.

| Famille | Sous-types ou caractéristiques canoniques |
| --- | --- |
| `bike` | sous-types `city`, `vtc`, `mtb`, `road`, `gravel`, `electric`, `cargo`, `child`, `tandem`, `fatbike` ; caractéristiques `size`, `autonomy` |
| `kayak` | `capacity` ; construction `rigid` ou `inflatable` ; pratique `sea`, `touring` ou `whitewater` |
| `canoe` | aucun sous-type ou caractéristique spécialisé dans cette tranche |
| `surf` | sous-types `classic`, `longboard`, `softboard`, `bodyboard`, `skimboard` |
| `ski` | sous-types `alpine`, `touring`, `cross-country` |
| `paddleboard` | `capacity` (`single` ou `tandem`) ; construction `rigid` ou `inflatable` |
| `snowboard` | aucun sous-type ou caractéristique spécialisé dans cette tranche |

Le slug historique `paddle` reste inchangé et n'est pas promu. La famille
`paddleboard` est active sous un seul slug canonique ; `single` correspond au
paddle simple et `tandem` au paddle tandem. Les options ne créent aucun slug
enfant.

### Activation paddleboard

Le registre serveur définit `paddleboard` comme famille `ACTIVE`. L'interface
affiche « Paddle » en français et « Stand-up paddle » en anglais. Le slug
`paddle` déjà présent dans le seed initial reste une valeur historique
ambiguë : aucune donnée historique n'est convertie et ce slug n'est pas
publiable comme famille commerciale.

La migration 0054 ajoute ou réactive uniquement la catégorie canonique
`paddleboard`; le seed local la prépare sans déplacer `kayak-dev` et sans
publier de produit synthétique. Les options `capacity` (`single`, `tandem`) et
`construction` (`rigid`, `inflatable`) réutilisent les attributs de variante
existants lorsqu'ils sont présents ; aucune dimension obligatoire ni nouvelle
colonne n'est ajoutée.

Le paddle réutilise les parcours génériques loueur et public, les trois photos
valides requises avant publication, la recherche, la réservation, le hold et
le paiement TEST. Il n'active ni Photo Coach, ni slots photo vélo, ni règle
kayak/canoë, ni moteur de packs. Le pédalo reste inactif.

## Registre fermé côté serveur

La source de vérité typée est
[`packages/core/src/catalog/equipment-taxonomy.ts`](../../packages/core/src/catalog/equipment-taxonomy.ts).
Elle distingue :

- `ACTIVE` : familles activées commercialement ; aujourd'hui `bike`, `kayak`,
  `canoe`, `paddleboard`, `surf`, `ski` et `snowboard` ;
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

L'activation canoë ajoute la catégorie canonique `canoe` via la migration 0053,
sans conversion des produits historiques `equipment`. Aucun sous-type, champ
ou caractéristique spécialisée n'est introduit. Le parcours générique et la
présentation nautique neutre sont réutilisés, sans Photo Coach, slot vélo,
règle kayak ou accessoire autonome.

L'activation paddle ajoute la catégorie canonique `paddleboard` via la
migration 0054, sans conversion des produits historiques `equipment` ou
`paddle`. Elle utilise un seul slug avec les options descriptives `single`,
`tandem`, `rigid` et `inflatable` portées par les attributs de variante déjà
disponibles. Sa présentation est générique nautique, avec « Paddle » en
français et « Stand-up paddle » en anglais ; aucune règle Photo Coach, slot
vélo, règle kayak/canoë ou dimension obligatoire n'est ajoutée.

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

Pour le paddle, les compléments `pagaie`, `pompe`, `leash`, `gilet`,
`chariot`, `sac étanche` et `combinaison` suivront ce même contrat : inclus,
obligatoire, optionnel gratuit, supplément payant ou louable séparément
uniquement si Uttily et le loueur l'autorisent. Ils restent des compléments
non publiables seuls par défaut ; aucun moteur de packs ou de suppléments n'est
préparé dans cette tranche.
