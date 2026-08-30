# Legal decision pack — préparation de décision humaine

**Référence de version :** document vivant ; vérifier le commit courant du dépôt
avant utilisation. Les anciennes baselines `origin/main = ...` sont historiques.
**Dernière revue de cohérence :** 2026-08-30
**Statut du pack :** `PASS` pour la préparation externe ; `SIGNOFF = BLOCKED`
**Identifiants référencés :** uniquement `LEGAL-*`

Ce pack ne constitue pas des CGU, des CGV, un contrat Pro, une politique
juridique ou un avis. Il donne au juridique les questions à trancher, le
parcours actuellement codé et les conséquences de chaque choix. Aucun texte
définitif n'est rédigé ici.

## Décisions à rendre

| ID | Décideur attendu | Livrable humain attendu | Bloque |
| --- | --- | --- | --- |
| `LEGAL-001` | Juridique + porteur produit | Textes client, version active, date d'effet et preuve de consentement | CGU/CGV, version des terms, snapshot d'acceptation |
| `LEGAL-002` | Juridique + porteur produit | Conditions Pro, responsabilités, assurances et exclusions | Contrat loueur, responsabilité, articulation dommages |
| `LEGAL-003` | Juridique + produit | Clauses retrait/restitution, état, dommages, retards et contestations | Parcours pickup/return et dommages |
| `LEGAL-004` | Juridique + produit | Règles FLEXIBLE/MODERATE/FIRM, grâce et cas horaire | Annulation client et offres horaires |
| `LEGAL-005` | Juridique + finance | Base remboursable et exceptions documentées | Remboursements et exceptions |
| `LEGAL-006` | Juridique + finance | Mentions et régime contractuel des amendements/suppléments | Documents et messages amendés |
| `LEGAL-007` | Juridique + finance | Responsabilités et preuve d'acceptation Stripe Connect du partenaire | Conditions Connect et compte partenaire |
| `LEGAL-008` | Juridique + engineering | Conditions droits/localisation/cache du géocodage futur | Enrichissement géocodage, non bloquant au pilote local-first |

## Parcours contractuels à couvrir

La décision doit suivre le parcours réel, de bout en bout, et non seulement le
texte affiché au checkout.

| Étape | Questions juridiques à trancher | État technique observé |
| --- | --- | --- |
| Réservation | Quelle partie contracte avec le client ? Quand la réservation devient-elle ferme ? Quelles informations sont opposables ? | Le panier est mono-loueur ; un hold temporaire précède le paiement ; la confirmation passe par le webhook et la transaction serveur. |
| Paiement | Quels terms sont présentés, à quel moment et quelle action vaut consentement ? | Le checkout envoie `termsVersion: 'v1'`; le serveur persiste une acceptation liée à l'utilisateur et à l'heure. |
| Confirmation | Quel document confirme la réservation, avec quelle version et quelles mentions ? | Les snapshots de paiement et réservation sont persistés ; les documents transactionnels sont produits par outbox/worker. |
| Annulation | Qui peut annuler, jusqu'à quand et selon quelle politique ? | Les codes `FLEXIBLE`, `MODERATE`, `FIRM` et une grâce de 24 h conditionnelle sont calculés côté serveur. |
| Remboursement | Quel montant et quelles composantes sont remboursables ? Quelles exceptions s'appliquent ? | Le calcul actuel prend `booking.totalAmountMinor` comme base et applique un pourcentage. Ce comportement n'est pas une validation. |
| Retrait | Quelles obligations du client et du loueur au retrait ? Quelle preuve d'identité, état ou retard ? | La machine fulfillment distingue préparation, retrait et restitution ; les clauses ne sont pas rédigées. |
| Restitution | Quel état doit être rendu, dans quel délai et avec quelle preuve ? | Des rapports d'état et de dommage existent ; leur portée contractuelle reste à fixer. |
| Dommages | Quel barème, quelle procédure contradictoire, quels délais, quelle assurance et quelle caution ? | `damage_reports`, `condition_reports` et `maintenance_cases` sont disponibles ; aucune responsabilité/barème n'est choisi. |
| Amendement | Quel accord est nécessaire pour un changement, supplément ou remboursement ? | Les amendements et snapshots financiers existent techniquement ; les mentions et textes restent à valider. |
| Incident loueur | Que se passe-t-il si le loueur ne fournit pas le matériel ou annule ? | Le remboursement de compensation tardive est traité techniquement ; les exceptions et notifications restent contractuelles. |

## Chaîne de preuve du consentement

Le validateur doit préciser et approuver la chaîne complète suivante. Une ligne
de base de données portant seulement `v1`, un utilisateur et une date ne suffit
pas si le document correspondant est introuvable.

```text
UI présentée
  → document et version présentés
  → action explicite de l'utilisateur
  → timestamp UTC
  → actor/user identifié
  → snapshot persisté sans recalcul
  → document/version référencé et récupérable
```

### Contradiction actuelle à traiter

- Le code serveur fixe `legalTermsVersion: 'v1'`.
- Le checkout transmet `v1`.
- `payments` et `bookings` persistent `terms_acceptance_snapshot`.
- Aucun document CGU/CGV correspondant à `v1` n'existe actuellement dans l'application ou le dépôt.

Cette contradiction est une décision, pas une correction de code à effectuer
dans 21-P0. Le juridique doit fournir le document, son contenu/version/date
d'effet et dire si le snapshot existant suffit ou si une nouvelle preuve est
requise.

## Annulation et remboursement

### Politiques actuellement implémentées

| Politique | Règle technique actuellement observée | Décision à rendre |
| --- | --- | --- |
| `FLEXIBLE` | 100 % à au moins 24 h ; 0 % sous 24 h | Confirmer ou modifier le texte et les exceptions. |
| `MODERATE` | 100 % à au moins 5 jours ; 50 % entre 24 h et 5 jours ; 0 % sous 24 h | Confirmer les seuils et la qualification des frais. |
| `FIRM` | 100 % à au moins 14 jours ; 50 % entre 7 et 14 jours ; 0 % sous 7 jours | Confirmer les seuils et les exceptions. |
| Grâce | 100 % si réservation au moins 7 jours à l'avance et annulation dans les 24 h, avant le début | Confirmer l'existence, la durée et les exclusions. |
| Horaire 30 min | Aucun comportement dédié n'est implémenté | Choisir la règle exacte ou exclure ces offres du pilote. |

Les échéances sont calculées dans le fuseau IANA du lieu de retrait. Cette
contrainte technique ne tranche pas la qualification juridique.

### Base de remboursement à décider

Le code actuel calcule le refund à partir de `booking.totalAmountMinor`, donc
du total TTC immuable du booking, puis applique le pourcentage de politique. Il
ne faut pas présenter cette valeur comme un choix approuvé. Le validateur doit
répondre explicitement :

1. total TTC, sous-total, prix de location seul ou autre base définie ;
2. traitement des options et frais obligatoires ;
3. traitement de la commission et des frais Stripe ;
4. défaut du loueur, force majeure, annulation du loueur et paiement tardif ;
5. règles de refund total/partiel et texte présenté avant paiement ;
6. date d'effet et version de la règle.

## Conditions Pro et responsabilités

Le pack doit fournir une trame de validation, pas une clause inventée. Le
contrat Pro doit notamment demander une réponse sur :

- identité et qualité professionnelle du loueur ;
- propriété/droit de louer le matériel ;
- exactitude du catalogue, des prix, des tailles et des disponibilités ;
- préparation, retrait, restitution et horaires ;
- sécurité, entretien, état et indisponibilité d'un exemplaire ;
- dommages, perte, vol, retard et procédure contradictoire ;
- assurance, plafonds, exclusions et recours ;
- annulation par le loueur et information du client ;
- responsabilités respectives d'Uttily, du loueur et du client ;
- conservation et accès aux preuves nécessaires.

Le mécanisme d'acceptation Pro n'existe pas dans le code actuel. La décision
doit donc préciser si une preuve externe suffit pour le pilote ou si une
fonction locale sera exigée après la décision.

## Stripe Connect et partenaire

La plateforme utilise techniquement des destination charges et l'onboarding
Stripe hébergé/embarqué selon les ADR existantes. Le partenaire ne doit pas
être réputé avoir accepté les conditions sur la seule base de `chargesEnabled`,
`payoutsEnabled` ou de la fermeture d'un composant d'onboarding.

La décision doit attribuer : frais, pertes, litiges, chargebacks, remboursements,
soldes négatifs, obligations KYC déléguées à Stripe, obligations du loueur et
preuve d'acceptation des conditions applicables.

## Géocodage futur

PostgreSQL/PostGIS reste le registre canonique et le runtime local-first pour
les destinations activées. Photon et IGN sont des candidats d'enrichissement,
pas des fournisseurs branchés au parcours nominal. Avant ingestion, la décision
doit traiter droits de réutilisation, localisation, cache, conservation et
transferts. Cela ne constitue pas un blocage du premier pilote Lyon tant que le
runtime n'utilise pas un fournisseur distant.

## Dossier de réponse attendu

Pour chaque ID : réponse explicite, texte ou référence documentaire, version,
date d'effet, owner, signataire et conditions restantes. En l'absence de
réponse, conserver le statut `HUMAN_SIGNOFF_REQUIRED`/`BLOCKED` dans la matrice
de readiness.
