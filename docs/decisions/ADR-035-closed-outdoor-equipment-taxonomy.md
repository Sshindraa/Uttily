# ADR-035 — Taxonomie commerciale outdoor fermée

**Statut :** Accepted — canoë activé comme deuxième famille de l'univers pagaie.

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
fermé. Cette décision encadre l'activation du kayak, du canoë, du surf, du ski
puis du snowboard sans
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
| `ACTIVE` | `bike`, `kayak`, `canoe`, `surf`, `ski`, `snowboard` |
| `APPROVED_NEXT` | — |
| `APPROVED_LATER` | — |
| `INTERNAL_FALLBACK` | `equipment`, compatibilité technique seulement |

Toute autre valeur est résolue comme `UNSUPPORTED`. Le fallback interne ne
peut pas être considéré comme une famille commerciale active. La migration
0051 ajoute uniquement la catégorie canonique `kayak`; la catégorie `surf` et la
catégorie `ski` existaient déjà dans le seed initial. La migration 0052 ajoute
la catégorie canonique `snowboard`, et la migration 0053 ajoute la catégorie
canonique `canoe`. Aucun produit existant utilisant `equipment` n'est converti
et aucune catégorie historique n'est réécrite. La
fixture `kayak-dev` reste explicitement rattachée à `kayak`.

Le kayak consomme les parcours génériques déjà en place : Produit → Variante
→ Exemplaire, prix, disponibilité, photos, publication, recherche, hold,
paiement et réservation. Ses attributs descriptifs `capacity`, `construction`
et `practice` ne sont affichés que lorsqu'ils existent dans les attributs de
la variante. Ils n'introduisent aucune validation ou colonne nouvelle.

Le canoë est actif sous le seul slug `canoe`, sans sous-type ni caractéristique
spécifique inventé. Il utilise la présentation nautique neutre et les parcours
génériques Produit → Variante → Exemplaire, tarif, disponibilité, photos,
publication, recherche, hold, paiement TEST et réservation. Aucun Photo Coach,
slot photo ou règle spécialisée du kayak ou du vélo ne lui est appliqué.

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
Coach, slot photo ou règle de sécurité vélo.

Le snowboard est actif comme famille unique `snowboard`, sans sous-type,
caractéristique ou règle spécialisée inventé. Il réutilise les parcours
génériques, la publication universelle à trois photos valides, la recherche,
la réservation, le hold et le paiement TEST. Son gestionnaire photo reste
neutre : aucun Photo Coach, slot photo ou règle de sécurité vélo ou ski ne lui
est appliqué. La migration 0052 ne convertit pas les produits historiques
`equipment`.

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
- Le canoë est actif comme deuxième famille non-vélo de l'univers pagaie, sous
  le seul slug `canoe`, avec une présentation nautique neutre et sans
  caractéristique, règle ou accessoire autonome nouveau.
- Le surf est actif comme deuxième famille non-vélo avec le même seuil
  universel de trois photos valides et sans règles spécialisées supplémentaires.
  Ses sous-types sont descriptifs et restent portés par les variantes ou les
  données déjà disponibles.
- Le ski est actif comme troisième famille non-vélo, uniquement pour `alpine`,
  `touring` et `cross-country`.
- Le snowboard est actif comme quatrième famille non-vélo sous le seul slug
  `snowboard`; aucun sous-type, champ spécialisé ou règle ski n'est ajouté.
- Les autres familles neige et les catégories hors périmètre restent exclues.
- Les catégories hors périmètre et les valeurs inconnues doivent être refusées
  par les futurs flux commerciaux plutôt que converties silencieusement en
  `equipment`.
- Les accessoires des familles kayak, canoë, surf, ski et snowboard restent des compléments non
  publiables seuls par défaut ; leur moteur de supplément n'est pas livré.
- Les familles windsurf, wingfoil, kitesurf et foil ne sont pas activées par
  cette décision.
