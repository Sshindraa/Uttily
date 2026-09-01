# Business plan et stratégie — Uttily

## Vision

Uttily vise à devenir le système d'exploitation de la location outdoor
professionnelle dans un périmètre commercial fermé : une marketplace
spécialisée pour les voyageurs et habitants, couplée à un SaaS opérationnel
pour les loueurs professionnels. Les quatre univers et les familles
activables sont définis dans la [taxonomie canonique](equipment-taxonomy.md).

La direction stratégique retenue est l'**option C** : Uttily construit
progressivement une infrastructure mondiale de l'accès au matériel, composée de
trois couches complémentaires — **Uttily OS**, **Uttily Marketplace** et
**Uttily Intelligence**. À terme, l'offre pourra également être distribuée par
des partenaires et des agents logiciels autorisés. La vision canonique et ses
garde-fous sont détaillés dans
[`long-term-vision.md`](long-term-vision.md) et ADR-019.

La stratégie n'est pas de se déployer partout immédiatement ni de devenir une
marketplace généraliste. Uttily crée d'abord une offre dense, fiable et utile
dans une destination, puis reproduit ce modèle destination par destination.

## Problème

### Côté client

Louer un équipement implique encore souvent une recherche dispersée, des disponibilités incertaines, des appels téléphoniques, des cautions peu transparentes et des contrats papier.

La promesse Uttily est :

> Trouver et réserver le bon équipement, au bon endroit et au bon moment, en quelques minutes.

### Côté loueur

Les professionnels utilisent fréquemment plusieurs outils pour le stock, le calendrier, les paiements, les contrats, les cautions et leur site. Cela cause des doubles réservations, de l'administration, une faible visibilité et une mauvaise exploitation des données.

La promesse Uttily est :

> Gérer toute son activité depuis un seul outil et recevoir de nouveaux clients.

## Produit B2B2C

| Surface | Rôle |
| --- | --- |
| Marketplace client spécialisée | Découvrir, comparer, réserver, payer et gérer une location dans le périmètre fermé. |
| SaaS loueur | Gérer catalogue, exemplaires, disponibilité, prix, réservations, opérations et performance. |
| Plateforme Uttily | Paiement, contrats, caution, administration, risque et distribution. |

Le MVP est limité aux loueurs professionnels. Les particuliers, partenaires touristiques, livraison, casiers et assurance intégrée restent des extensions futures.

## Positionnement

Uttily associe la découverte et la réservation d'une marketplace à l'outillage opérationnel d'un SaaS de location.

Les différenciateurs recherchés sont :

- disponibilité réellement synchronisée ;
- stock détaillé par exemplaire ;
- recherche par lieu, période et durée ;
- expérience internationale mobile-first ;
- intégration progressive des partenaires touristiques ;
- qualité des opérations : caution, contrat, retrait, retour et maintenance.

À long terme s'ajoutent quatre avantages défendables : connaissance structurée
des équipements (`Equipment Graph`), passeport numérique de chaque exemplaire,
intelligence opérationnelle explicable et commerce compatible avec plusieurs
canaux et agents. Ils restent hors MVP tant qu'un lot dédié n'est pas approuvé.

L'avantage défendable vient surtout de la densité de l'offre locale, de la qualité des données de disponibilité, des relations avec les loueurs et de l'intégration dans leurs opérations.

## Cible et pilote

### Clients

- touristes français et internationaux ;
- familles, groupes et pratiquants occasionnels ;
- personnes qui ne souhaitent pas transporter ou acheter leur équipement.

### Partenaires initiaux

- magasins de location ;
- écoles de surf ;
- bases nautiques ;
- loueurs de vélos ;
- campings, hôtels et conciergeries disposant d'un stock professionnel.

### Destination pilote

Hypothèse initiale : **Hossegor, Capbreton et Seignosse**.

Le pilote commence par la famille `bike`. `kayak`, `surf` et `ski` sont désormais
actifs dans le registre commercial fermé. Les autres familles neige et
catégories ne font pas partie de la marketplace Uttily.

## MVP commercial

Le but du MVP est une réservation réelle, pas une marketplace complète.

1. Référencer 5 à 10 loueurs professionnels.
2. Proposer 100 à 300 équipements dans les familles actives du registre fermé.
3. Permettre la recherche et réservation pour une destination.
4. Accompagner manuellement les partenaires et les premières opérations.
5. Mesurer la fiabilité de disponibilité et la conversion.

Le critère de succès principal est :

> Le nombre de recherches qui trouvent au moins un équipement pertinent et réellement disponible.

## Modèle économique

Uttily adopte un modèle transactionnel marketplace, couplé à un logiciel de gestion
(**Uttily OS**) mis à disposition **gratuitement** des loueurs professionnels
partenaires pour capter leur inventaire physique sans friction d'onboarding ni
risque lié à la saisonnalité.

| Flux | Règle produit actuelle | Modalité |
| --- | ---: | --- |
| Frais plateforme loueur | 13 % de la base marketplace | Part loueur du modèle `split-13-7-v1`, prélevée via l'application fee Stripe |
| Frais de service client | 7 % de la base marketplace | Part client affichée séparément et incluse dans le total payé |
| Logiciel opérationnel (Uttily OS) | 0 € / mois (Gratuit) | Gestion d'inventaire, exemplaires physiques, retraits/retours, états des lieux et disponibilité |

Revenus potentiels complémentaires : options de protection/assurance, livraison,
mise en avant locale, marque blanche, affiliation et outils analytiques. Les
frais de service client sont déjà inclus dans le modèle primaire 13/7 ci-dessus.

Le modèle 13/7 est un choix produit documenté dans ADR-029 ; la base fiscale,
la date d'effet, les frais de paiement, les remboursements, les litiges et la
responsabilité financière devront être validés avec Stripe, un avocat
spécialisé et un expert-comptable avant la commercialisation (FIN-002 reste
`BLOCKED`).

## Indicateurs

### Marketplace

- destinations et loueurs actifs ;
- équipements disponibles ;
- taux de résultats disponibles ;
- conversion recherche → réservation ;
- volume d'affaires brut (GMV), locations et panier moyen ;
- frais plateforme loueur et application fee marketplace ;
- annulations, remboursements et litiges.

### Performance & Écosystème Loueurs

- nombre d'exemplaires physiques actifs et synchronisés ;
- volume de chiffre d'affaires généré par loueur ;
- activation et rétention des loueurs sur Uttily OS ;
- réservations et taux d'utilisation par équipement.

### Opérations

- taux de double réservation : objectif zéro ;
- temps de préparation et de retour ;
- retards ;
- dommages ;
- délai de résolution des incidents.

## Déploiement

1. Entretiens avec au moins vingt professionnels et signature de trois pilotes.
2. Lancement local accompagné.
3. Densification de la destination : disponibilité, avis, partenaires touristiques et SEO local.
4. Duplication dans une destination suivante seulement après preuve de conversion et de rétention.
5. Internationalisation progressive selon les paiements, contrats, fiscalité, assurance, langues et support.

## Hors MVP, mais prévus par la vision

- location entre particuliers ;
- packs intelligents et recommandations météo ;
- livraison et casiers autonomes ;
- assurance et gestion de sinistres ;
- abonnements voyageurs et fidélité ;
- API partenaires, widget et marque blanche ;
- tarification dynamique et prévision de demande ;
- déploiement international et multi-devise.

## Hypothèses à valider avant de bâtir ces extensions

- niveau d'acceptation du taux de commission par catégorie et profil de loueur ;
- besoin réel de caution numérique par catégorie ;
- responsabilité juridique d'Uttily dans chaque flux de paiement ;
- catégorie et destination pilote les plus liquides ;
- coût d'acquisition des loueurs et des clients ;
- valeur de la livraison ou des partenaires touristiques dans la première destination.
