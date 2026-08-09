# ADR-019 — Uttily comme infrastructure mondiale de location compatible avec l'ère des agents IA

- **Statut** : Accepted — direction stratégique, implémentation progressive
- **Date** : 2026-08-07
- **Décideur produit** : Porteur produit Uttily
- **Relie à** : ADR-001, ADR-002, ADR-003, ADR-011, ADR-012, ADR-013, ADR-017,
  ADR-018 ; `docs/product/business-plan.md` ;
  `docs/product/long-term-vision.md`

## 1. Contexte

Le socle Uttily couvre les fonctions indispensables d'une plateforme de
location : catalogue, exemplaires physiques, disponibilité, prix, réservation,
paiement, retrait, retour, documents et maintenance.

Ce socle peut cependant conduire à trois positionnements différents :

- une marketplace grand public comparable à un « Airbnb du matériel » ;
- un SaaS de gestion comparable à un « Shopify des loueurs » ;
- une infrastructure combinant système opérationnel, marketplace, intelligence
  et distribution multicanale.

La progression des interfaces conversationnelles et des agents capables de
rechercher ou de réaliser un checkout rend insuffisante une stratégie reposant
uniquement sur le site Web. En parallèle, l'identité numérique des produits, la
traçabilité, la réparation et la circularité prennent une importance croissante.

Uttily doit choisir une direction qui reste pertinente même si les modèles
d'intelligence artificielle, les interfaces et les fournisseurs actuels sont
remplacés.

## 2. Options

### Option A — Marketplace principalement grand public

Uttily concentre l'investissement sur l'acquisition client et la comparaison
d'offres.

Avantages : proposition simple, potentiel de marque grand public.

Limites : disponibilité difficile à fiabiliser sans intégration opérationnelle,
fort coût d'acquisition et différenciation fragile.

### Option B — SaaS métier pour loueurs

Uttily devient principalement le logiciel quotidien des professionnels.

Avantages : valeur directe, revenus récurrents et intégration profonde.

Limites : distribution client limitée et risque de devenir un outil vertical
parmi d'autres.

### Option C — Infrastructure mondiale de l'accès au matériel

Uttily combine progressivement :

- OS loueur ;
- marketplace ;
- connaissance structurée du matériel ;
- passeport des exemplaires ;
- intelligence opérationnelle ;
- distribution partenaires et agents.

Avantages : données plus fiables, effets de réseau, plusieurs canaux de
distribution et avantages défendables indépendants d'un modèle d'IA donné.

Limites : ambition plus large, séquençage indispensable, exigences élevées en
matière de confiance, interopérabilité et gouvernance des données.

## 3. Décision

Uttily retient l'**option C**.

La séquence obligatoire est :

1. construire l'OS opérationnel pour loueurs professionnels ;
2. alimenter une marketplace avec une disponibilité fiable ;
3. développer une intelligence explicable à partir des faits opérationnels ;
4. distribuer l'offre via partenaires et agents autorisés ;
5. étendre pays par pays et contribuer à la circularité des équipements.

Cette décision n'ajoute aucune fonctionnalité au MVP par elle-même. Elle guide
les choix de données, de contrats et de modularité afin de ne pas bloquer les
horizons futurs.

## 4. Principes d'architecture durables

### Autorité déterministe

PostgreSQL et les use cases Uttily restent l'autorité pour :

- disponibilité et allocation ;
- autorisations et multi-tenant ;
- prix publié et snapshot financier ;
- états de réservation ;
- idempotence et effets externes.

Une IA peut proposer, classer, expliquer ou préparer. Elle ne contourne jamais
ces autorités.

### Modèles interchangeables

Le domaine ne dépend pas directement d'un fournisseur ou d'un modèle. Toute
capacité IA passe par un port explicite avec :

- contrat versionné ;
- validation runtime ;
- timeouts et budgets ;
- politique de retry adaptée à l'effet ;
- observabilité sans données sensibles ;
- fallback déterministe ou intervention humaine ;
- tests avec fakes.

### Faits, recommandations et décisions séparés

Les données doivent distinguer :

- un fait observé ou transactionnel ;
- une déclaration d'un utilisateur ;
- une inférence ou recommandation automatisée ;
- une décision humaine ;
- l'effet finalement exécuté.

Cette séparation est indispensable pour l'audit, les contestations, la mesure de
qualité et le remplacement d'un modèle.

### Machine-readable sans API prématurée

Les politiques, prix, disponibilités et statuts sont structurés et versionnés.
Une API publique, MCP, ACP, A2A ou tout autre protocole n'est adopté que lorsqu'un
cas d'usage réel le justifie. Les standards actuels sont des signaux de direction,
pas des dépendances verrouillées.

### Interopérabilité des actifs

Les identifiants stables et le futur passeport des exemplaires doivent pouvoir
s'aligner avec des standards ouverts tels que GS1 Digital Link ou les exigences
applicables de Digital Product Passport, sans attribuer aujourd'hui à Uttily une
obligation réglementaire non confirmée.

## 5. Capacités stratégiques

### Equipment Graph

Une ontologie versionnée reliera à terme équipements, activités, utilisateurs,
compatibilités, accessoires, conditions et règles de sécurité. Les catégories
actuelles restent simples ; toute extension du modèle suit un lot dédié.

### Digital Equipment Passport

L'historique existant des exemplaires, mouvements, rapports d'état, dommages et
maintenance constitue la première fondation. QR, NFC, données fabricant,
interopérabilité et circularité sont différés.

### Rental Intelligence

Les recommandations futures portent sur la demande, l'utilisation, la flotte,
la maintenance, les prix et les opérations. Elles sont explicables, mesurées et
contrôlées par le loueur.

### Agent-ready Commerce

Les futures interfaces partenaires ou agents réutilisent les mêmes use cases
sécurisés que l'interface Uttily. Elles utilisent des identifiants publics,
contrats versionnés, holds et mutations idempotentes. Un paiement ou une
réservation exige toujours les autorisations et confirmations prévues.

## 6. Garde-fous

- Loueurs professionnels uniquement au lancement.
- Aucun panier multi-loueurs ajouté par cette décision.
- Aucune location entre particuliers ajoutée par cette décision.
- Aucun stockage de carte bancaire.
- Aucune disponibilité décidée par un modèle probabiliste.
- Aucun dommage facturé automatiquement sur une analyse d'image seule.
- Aucun prix individualisé opaque ou discriminatoire.
- Aucune recommandation de sécurité présentée comme un fait sans source.
- Aucune exploitation secondaire des données sans finalité, base légale et
  gouvernance définies.
- Les données d'un loueur restent exportables selon un contrat futur documenté.
- Toute action automatisée sensible est autorisée, auditée, idempotente et
  réversible lorsque le domaine le permet.

## 7. Conséquences immédiates

### Ce qui change

- La vision Option C devient la référence pour les arbitrages futurs.
- Les nouvelles fonctionnalités doivent préserver identités stables, provenance,
  versioning, événements et séparation humain/IA lorsque cela est pertinent.
- Les futurs backlogs peuvent créer des lots Equipment Graph, Passport,
  Intelligence ou Agent-ready après validation de leur valeur.

### Ce qui ne change pas

- Le périmètre du MVP.
- Le monolithe modulaire actuel.
- Les invariants de réservation et de paiement.
- L'ordre du Lot 7 en cours.
- Les fournisseurs et protocoles actuellement implémentés.
- L'absence d'un moteur IA dans les mutations critiques.

## 8. Signaux externes, sans verrou fournisseur

- Le règlement européen 2024/1781 établit le cadre du Digital Product Passport
  et prévoit une information électronique favorisant durabilité et circularité :
  <https://eur-lex.europa.eu/legal-content/EN/LSU/?uri=CELEX:32024R1781>.
- GS1 Digital Link fournit une syntaxe Web pour relier des identifiants de
  produits, actifs et lieux à des informations structurées :
  <https://www.gs1.org/standards/gs1-system-architecture-document/current-standard>.
- Des protocoles de commerce agentique permettent déjà d'exposer recherche et
  checkout à des agents ; leur maturité et leur adéquation devront être réévaluées
  au moment du lot concerné :
  <https://docs.stripe.com/agentic-commerce/protocol>.
- Le cadre européen de l'IA renforce l'intérêt d'une conception fondée sur le
  risque, la transparence et la responsabilité :
  <https://commission.europa.eu/news-and-media/news/ai-act-enters-force-2024-08-01_en>.

Ces références n'impliquent ni intégration immédiate ni déclaration de conformité.

## 9. Critères pour ouvrir un lot stratégique

Un lot issu de cette vision ne commence que si :

1. le problème utilisateur et la métrique de succès sont explicites ;
2. le MVP ou l'exploitation réelle produit les données nécessaires ;
3. l'autorité humaine et transactionnelle est définie ;
4. les risques privacy, sécurité, sûreté et discrimination sont évalués ;
5. le coût d'exploitation est proportionné à la valeur attendue ;
6. le design reste indépendant d'un fournisseur lorsque raisonnable ;
7. un ADR décrit tout nouveau choix structurel.
