# ADR-030 — Politique proposée de remboursement split

**Statut :** Proposed — proposition produit formalisée le 2026-08-30 ;
validation Finance/Juridique requise avant toute activation (`FIN-002 =
BLOCKED`).

**Date :** 2026-08-30

**Dépendances :** [ADR-023](ADR-023-booking-financial-amendments.md),
[ADR-029](ADR-029-marketplace-fee-split-13-7.md)

## Contexte

Les amendements financiers peuvent produire plusieurs états économiques
successifs pour une même réservation. Un remboursement calculé à partir du
booking original ou d'un pourcentage appliqué directement au delta peut ignorer
un amendement précédent et produire des écarts d'arrondi.

Le modèle `split-13-7-v1` conserve les snapshots complets et expose déjà le
delta `FINAL_STATE_DELTA_PER_COMPONENT`. En revanche, le provider actuel ne
permet pas encore de représenter séparément le prix marchand, les 13 % loueur
et les 7 % client avec les seuls paramètres agrégés
`reverse_transfer` et `refund_application_fee`.

## Décision proposée

Cette politique couvre les baisses d'amendement, les remboursements totaux ou
partiels et les compensations tardives d'un paiement split. Une annulation
après amendement doit d'abord obtenir son droit à remboursement selon la
politique juridique applicable ; une fois ce montant déterminé, elle réutilise
le même allocateur par composant sans changer la règle d'éligibilité.

### 1. Base du remboursement

Pour chaque amendement qui réduit la réservation, le montant est calculé entre
deux états économiques complets :

```text
état effectif avant amendement − état final après amendement
```

- Au premier amendement, l'état précédent est la réservation originale.
- Pour les amendements suivants, l'état précédent est le dernier amendement
  `APPLIED`.
- La réservation originale reste immuable et constitue la preuve historique.
- Chaque delta est traité une seule fois ; une différence déjà remboursée ou
  encore due ne peut pas être recréée par un rejeu.

Les deux états sont recalculés composant par composant avec la règle historique
du booking, puis soustraits. Il est interdit d'appliquer directement 7 % ou
13 % au delta de prix. Pour le moteur existant, les champs de delta sont
`next − old` ; une baisse donne donc un delta négatif et l'obligation positive
correspondante est son opposé.

Pour une baisse, les montants positifs à traiter sont donc :

```text
remboursement client = max(0, totalClientAvant − totalClientAprès)
reprise loueur       = max(0, netLoueurAvant − netLoueurAprès)
restitution Uttily   = max(0, fraisUttilyAvant − fraisUttilyAprès)
```

L'invariant économique attendu est :

```text
remboursement client = reprise loueur + restitution Uttily
```

La projection `getEffectiveBooking` reste l'autorité de lecture de l'état
effectif. Les snapshots `financialSnapshotBefore` et `financialSnapshotAfter`
de chaque amendement restent les preuves des états comparés.

### 2. Répartition du remboursement split

Pour une baisse de réservation :

- le client reçoit la baisse de son total payé, soit la baisse de la base et de
  ses frais de service de 7 % ;
- le loueur ne reçoit pas un remboursement : son droit économique est ramené au
  nouveau net `base − frais loueur de 13 %` ; si un transfert a déjà eu lieu,
  Uttily reprend uniquement la baisse de ce net ;
- Uttily restitue la baisse de son application fee, égale à la baisse des frais
  loueur et des frais client.

Les frais de traitement Stripe non récupérables restent un coût Uttily séparé.
Ils ne peuvent pas être retranchés silencieusement du remboursement client ou
du net loueur. Le traitement comptable et la preuve de ce coût font partie du
sign-off Finance.

Le provider devra offrir un chemin d'exécution capable de rapprocher ces
composants au centime, en distinguant notamment un transfert déjà effectué d'un
transfert qui ne l'est pas. Les flags Stripe agrégés ne suffisent pas à eux
seuls. Tant que ce chemin n'est pas validé et testé, les remboursements split
restent bloqués par `SPLIT_REFUND_UNRESOLVED`.

Lorsque le transfert Stripe a déjà été effectué, l'opération provider peut
nécessiter un remboursement client brut égal au total client, une reprise du
transfert et une restitution de l'application fee. Le résultat économique
attendu côté loueur est alors la seule baisse du net loueur ; la restitution de
l'application fee ne doit pas être comptée deux fois. Si le transfert n'a pas
encore été effectué, le rapprochement doit ajuster le règlement à venir plutôt
que créer une reprise fictive. Les montants effectivement exécutés et les
écarts éventuels doivent être persistés et réconciliés avant tout statut
`SUCCEEDED`.

### 3. Calcul impossible, échec ou désaccord

Trois états sont distingués :

1. **Calcul impossible avant application** : l'amendement est refusé, la
   réservation reste inchangée et aucun mouvement financier n'est créé.
2. **Échec après application** : l'amendement reste `APPLIED`, l'obligation de
   remboursement reste visible en `FAILED_REQUIRES_MANUAL_ACTION` et n'est pas
   effacée rétroactivement. Sa résolution manuelle est auditée et peut aboutir
   à `SETTLED_OFF_PLATFORM` conformément à l'ADR-023.
3. **Désaccord commercial** : le dossier passe en traitement manuel. Le loueur
   fournit les éléments, mais seul le support Uttily doit pouvoir clôturer le
   dossier financièrement ou déclarer un règlement hors plateforme avec une
   preuve d'audit. Cette capacité n'est pas une action automatisée du
   back-office V1 (ADR-028) tant que la présente ADR n'est pas approuvée.

Le SLA proposé est : prise en charge sous un jour ouvré, décision et émission
du remboursement sous cinq jours ouvrés maximum, puis affichage bancaire
généralement sous cinq à dix jours ouvrés selon le provider et la banque.

Le message client doit refléter l'état réel :

```text
Calcul impossible avant application

Nous ne pouvons pas confirmer cette modification automatiquement. Votre
réservation actuelle reste inchangée et aucun montant supplémentaire ni
remboursement n'a été appliqué. Notre équipe examinera votre demande sous un
jour ouvré et vous apportera une réponse définitive au plus tard sous cinq
jours ouvrés.
```

```text
Remboursement en attente après application

Votre réservation a bien été modifiée et un remboursement de [MONTANT] € reste
dû. Nous ne pouvons pas encore confirmer son émission automatique. Notre équipe
prendra en charge le dossier sous un jour ouvré et vous confirmera son émission
ou la solution retenue au plus tard sous cinq jours ouvrés. Après émission vers
votre moyen de paiement d'origine, son affichage bancaire prend généralement
cinq à dix jours ouvrés.
```

## Invariants à préserver

- Les montants restent des entiers en unités mineures avec devise explicite.
- Les snapshots comparés restent immuables et portent la version de règle et
  la règle d'arrondi.
- Un amendement successif ne rembourse jamais une différence déjà traitée.
- Le plafond cumulatif et l'invariant multi-origines de l'ADR-023 restent vrais
  pendant `PENDING`, `SUBMITTED` et `FAILED_REQUIRES_MANUAL_ACTION`.
- Aucun succès n'est annoncé au client avant confirmation du provider.
- Toute mutation est transactionnelle, idempotente et auditée.
- Les chemins legacy et split restent séparés ; cette ADR ne convertit aucune
  réservation legacy.

## Conséquences

Cette politique rend le calcul des baisses déterministe pour les amendements
successifs et conserve une preuve complète de chaque état. Elle nécessite en
contrepartie un flux provider et une projection financière capables de
représenter la répartition client/loueur/Uttily, ainsi qu'un suivi séparé des
frais Stripe supportés par Uttily.

La présence de cette ADR ne vaut pas approbation Finance/Juridique et ne débloque
pas l'exécution LIVE. Le code actuel doit continuer à échouer fermé sur les
refunds split jusqu'à clôture de `FIN-002`, `FIN-005`, `FIN-006`, `LEGAL-004`,
`LEGAL-005` et des validations associées du plan pilote.

## Conditions pour passer à `Accepted`

Avant toute activation, il faut obtenir :

1. la validation Finance de la base, des composants, des frais Stripe, du
   settlement et de la comptabilisation ;
2. la validation Juridique des annulations, amendements, messages, délais et
   règlements hors plateforme ;
3. un contrat provider validé pour les remboursements partiels, la reprise du
   transfert et la restitution de l'application fee ;
4. des tests unitaires, PostgreSQL, webhook, idempotence et réconciliation
   couvrant plusieurs amendements et plusieurs origines de paiement ;
5. une preuve de staging puis une readiness LIVE distincte.

## Plan d'implémentation après approbation

1. Versionner la politique approuvée et son identifiant de règle.
2. Construire les états effectifs avant/après depuis les snapshots append-only.
3. Utiliser `FINAL_STATE_DELTA_PER_COMPONENT` pour produire les obligations
   client, loueur et Uttily sans double remboursement.
4. Adapter les ports/adapters Stripe et la projection webhook au flux
   composant par composant.
5. Ajouter le ledger ou les champs d'audit nécessaires pour les frais Stripe
   non récupérables et les reprises de transfert.
6. Valider les messages client, le SLA, la résolution manuelle et la
   réconciliation avant toute levée du fail-closed.
