# Business plan et stratégie — Uttily

## Vision

Uttily vise à devenir le système d'exploitation mondial de la location d'équipements : une marketplace pour les voyageurs et habitants, couplée à un SaaS opérationnel pour les loueurs professionnels.

La direction stratégique retenue est l'**option C** : Uttily construit
progressivement une infrastructure mondiale de l'accès au matériel, composée de
trois couches complémentaires — **Uttily OS**, **Uttily Marketplace** et
**Uttily Intelligence**. À terme, l'offre pourra également être distribuée par
des partenaires et des agents logiciels autorisés. La vision canonique et ses
garde-fous sont détaillés dans
[`long-term-vision.md`](long-term-vision.md) et ADR-019.

La stratégie n'est pas de se déployer partout immédiatement. Uttily crée d'abord une offre dense, fiable et utile dans une destination, puis reproduit ce modèle destination par destination.

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
| Marketplace client | Découvrir, comparer, réserver, payer et gérer une location. |
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

Catégories proposées : surf, bodyboard, combinaisons, paddle, vélo et surfskate. Cette hypothèse doit être validée par des entretiens et l'engagement réel de partenaires avant tout investissement produit spécifique.

## MVP commercial

Le but du MVP est une réservation réelle, pas une marketplace complète.

1. Référencer 5 à 10 loueurs professionnels.
2. Proposer 100 à 300 équipements dans 3 à 5 catégories.
3. Permettre la recherche et réservation pour une destination.
4. Accompagner manuellement les partenaires et les premières opérations.
5. Mesurer la fiabilité de disponibilité et la conversion.

Le critère de succès principal est :

> Le nombre de recherches qui trouvent au moins un équipement pertinent et réellement disponible.

## Modèle économique

Les prix ci-dessous sont des hypothèses à valider lors des entretiens avec les loueurs.

| Offre | Abonnement indicatif | Commission marketplace indicative | Cible |
| --- | ---: | ---: | --- |
| Starter | 0 à 29 € / mois | 12 à 15 % | Petit loueur et acquisition initiale |
| Pro | 79 à 119 € / mois | 8 à 10 % | Loueur avec besoins opérationnels avancés |
| Network | 249 à 499 € / mois | 4 à 7 % | Réseau multi-sites et intégrations |

Revenus potentiels complémentaires : frais de service client, options de protection, livraison, mise en avant locale, marque blanche, affiliation et outils analytiques.

La commission, les frais de paiement, les remboursements, les litiges et la responsabilité financière devront être validés avec Stripe, un avocat spécialisé et un expert-comptable avant la commercialisation.

## Indicateurs

### Marketplace

- destinations et loueurs actifs ;
- équipements disponibles ;
- taux de résultats disponibles ;
- conversion recherche → réservation ;
- volume de locations et panier moyen ;
- annulations, remboursements et litiges.

### SaaS

- revenu mensuel récurrent ;
- revenu moyen par loueur ;
- activation et rétention des loueurs ;
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

- volonté des loueurs de payer un abonnement, une commission, ou les deux ;
- besoin réel de caution numérique par catégorie ;
- responsabilité juridique d'Uttily dans chaque flux de paiement ;
- catégorie et destination pilote les plus liquides ;
- coût d'acquisition des loueurs et des clients ;
- valeur de la livraison ou des partenaires touristiques dans la première destination.
