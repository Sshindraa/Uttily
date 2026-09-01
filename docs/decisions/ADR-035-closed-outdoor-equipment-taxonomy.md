# ADR-035 — Taxonomie commerciale outdoor fermée

**Statut :** Accepted — ski activé comme troisième famille non-vélo.

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
fermé. Cette décision encadre l'activation du kayak, du surf puis du ski sans
convertir les produits historiques qui utilisent `equipment`.

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
| `ACTIVE` | `bike`, `kayak`, `surf`, `ski` |
| `APPROVED_NEXT` | — |
| `APPROVED_LATER` | — |
| `INTERNAL_FALLBACK` | `equipment`, compatibilité technique seulement |

Toute autre valeur est résolue comme `UNSUPPORTED`. Le fallback interne ne
peut pas être considéré comme une famille commerciale active. La migration
0051 ajoute uniquement la catégorie canonique `kayak`; la catégorie `surf`
existait déjà dans le seed initial. Aucun produit existant utilisant
`equipment` n'est converti et aucune migration surf n'est nécessaire. La
fixture `kayak-dev` reste explicitement rattachée à `kayak`.

Le kayak consomme les parcours génériques déjà en place : Produit → Variante
→ Exemplaire, prix, disponibilité, photos, publication, recherche, hold,
paiement et réservation. Ses attributs descriptifs `capacity`, `construction`
et `practice` ne sont affichés que lorsqu'ils existent dans les attributs de
la variante. Ils n'introduisent aucune validation ou colonne nouvelle.

Le surf est actif uniquement pour la famille `surf` et les sous-types
descriptifs `classic`, `longboard`, `softboard`, `bodyboard` et `skimboard`.
Ces valeurs ne créent aucun slug commercial supplémentaire. Les dimensions,
le volume, le niveau et les règles spécialisées windsurf, wingfoil, kitesurf
ou foil ne sont pas introduits. Le parcours surf réutilise les mêmes
invariants génériques et le gestionnaire photo neutre ; aucune règle Photo
Coach, slot ou sécurité vélo ne lui est appliquée.

Le ski est actif uniquement pour la famille `ski` et les sous-types descriptifs
`alpine`, `touring` et `cross-country`. Ces valeurs restent portées par les
champs de variante déjà disponibles et ne créent aucun slug supplémentaire.
Aucun champ de mensuration, niveau ou longueur de bâton n'est ajouté. Le ski
réutilise le parcours générique et le gestionnaire photo neutre, sans Photo
Coach, slot photo ou règle de sécurité vélo. Le snowboard et les autres
familles neige restent désactivés.

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
- Le surf est actif comme deuxième famille non-vélo avec le même seuil
  universel de trois photos valides et sans règles spécialisées supplémentaires.
  Ses sous-types sont descriptifs et restent portés par les variantes ou les
  données déjà disponibles.
- Le ski est actif comme troisième famille non-vélo, uniquement pour `alpine`,
  `touring` et `cross-country`; le snowboard et les autres familles neige ne
  sont pas activés.
- Les catégories hors périmètre et les valeurs inconnues doivent être refusées
  par les futurs flux commerciaux plutôt que converties silencieusement en
  `equipment`.
- Les accessoires des familles kayak, surf et ski restent des compléments non
  publiables seuls par défaut ; leur moteur de supplément n'est pas livré.
- Les familles windsurf, wingfoil, kitesurf et foil ne sont pas activées par
  cette décision.
