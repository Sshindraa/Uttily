# ADR-031 — Règles photo par catégorie et gate de publication du pilote vélo

**Statut :** Accepted — périmètre limité au pilote vélo ; les autres catégories
conservent la règle générique d'ADR-020.

**Date :** 2026-08-30

**Décideurs :** Porteur produit Uttily, engineering

**Relie à :** [ADR-020](ADR-020-product-photo-metadata-and-publication-gate.md),
[ADR-026](ADR-026-product-photo-upload-and-delivery.md),
`docs/product/g8b-3-bike-pilot-visual-trust-and-coach.md`

## 1. Contexte

ADR-020 impose au MVP trois photos `AVAILABLE` distinctes avant publication,
mais réserve l'enforcement de vues propres à chaque catégorie à une évolution
ultérieure. Le pilote G8B-3 porte sur les vélos et sa spécification définit déjà
une narration en trois vues obligatoires. Le contrat, l'interface et la
persistance des slots sont maintenant disponibles ; le serveur et PostgreSQL
doivent appliquer la même règle.

Les exemples surf, paddle, ski, camping, escalade, plongée et autres catégories
ne constituent pas encore un standard validé. Ils ne sont donc pas concernés
par cette ADR.

## 2. Décision

### 2.1 Catégorie concernée

La règle s'applique à la catégorie dont le slug exact est `bike`. Une future
sous-catégorie ou une autre famille de matériel nécessitera une ADR dédiée ou
une extension explicitement approuvée de celle-ci.

### 2.2 Vues obligatoires pour un vélo

Un produit `bike` est publiable uniquement s'il possède au moins une photo
`AVAILABLE`, non supprimée et avec checksum distinct, dans chacun des slots
canoniques suivants :

- `HERO_PROFILE` — vue complète de profil ;
- `THREE_QUARTER_FRONT` — vue trois-quarts avant ;
- `SECONDARY_VIEW` — vue libre valorisante ou trois-quarts arrière.

Les photos complémentaires (`BATTERY`, `MOTOR`, `DISPLAY`, `CHARGER`, etc.)
restent facultatives. Les alias historiques `THREE_QUARTER` et
`SIGNATURE_DETAIL` restent lisibles pour compatibilité, mais ne satisfont pas
à eux seuls les slots canoniques de cette règle.

La contrainte des trois checksums distincts d'ADR-020 reste obligatoire en plus
de la présence des trois slots. Une photo ne peut donc pas satisfaire deux
slots, et trois lignes partageant un checksum ne sont pas valides.

### 2.3 Autres catégories

Pour toute catégorie autre que `bike`, le gate conserve la règle MVP d'ADR-020 :
au moins trois photos `AVAILABLE` non supprimées avec checksums distincts. Aucun
slot particulier n'est requis tant qu'une règle de catégorie n'a pas été
validée.

### 2.4 Enforcement et cohérence

La même règle est appliquée aux trois frontières suivantes :

1. readiness et publication via Core ;
2. publication directe SQL via le trigger PostgreSQL ;
3. visibilité publique via `PostgresPhotoPublicationGate`.

La suppression ou invalidation d'une photo valide d'un produit `PUBLISHED`
reste refusée si elle fait tomber le produit sous sa règle applicable. Les
métadonnées de slot d'une photo `AVAILABLE` sont immuables ; un remplacement
crée une nouvelle photo puis retire l'ancienne selon le flux existant.

## 3. Compatibilité et déploiement

Cette évolution ne réécrit aucune photo et ne convertit aucun alias historique.
Avant une activation sur un environnement contenant déjà des vélos publiés,
les produits concernés doivent être audités et complétés avec les slots
canoniques. Le pilote courant n'ayant pas encore de partenaire commercial
engagé, l'activation peut être validée sur staging puis appliquée avant toute
publication commerciale réelle.

Les données et migrations existantes restent append-only. Aucune analyse
d'image, modération automatique ou promesse de certification visuelle n'est
introduite par cette ADR.

## 4. Critères d'acceptation

- un vélo avec les trois slots canoniques et trois checksums distincts est
  publiable et visible publiquement ;
- un vélo avec trois photos génériques, ou avec un slot canonique manquant,
  est refusé ;
- un produit d'une autre catégorie avec trois checksums distincts conserve le
  comportement MVP ;
- Core, PostgreSQL et le gate public renvoient la même décision ;
- les suppressions concurrentes ne permettent jamais de passer sous la règle ;
- aucun badge « loueur professionnel vérifié » n'est déduit de cette ADR.
