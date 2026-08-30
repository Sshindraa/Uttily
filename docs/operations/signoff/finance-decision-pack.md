# Finance decision pack — préparation de décision humaine

**Référence de version :** document vivant ; vérifier le commit courant du dépôt
avant utilisation. Les anciennes baselines `origin/main = ...` sont historiques.
**Dernière revue de cohérence :** 2026-08-30
**Statut du pack :** `PASS` pour la préparation externe ; `SIGNOFF = BLOCKED`
**Identifiants référencés :** uniquement `FIN-*`

Ce pack expose le comportement technique observé et les choix qui restent à
rendre par finance/expert-comptable/juridique. Aucun montant, taux, statut
fiscal ou émetteur n'est approuvé par ce document.

## Décisions financières

| ID | Question à rendre | Owner | Blockers |
| --- | --- | --- | --- |
| `FIN-001` | Settlement merchant, `on_behalf_of`, frais Stripe, remboursements, litiges, soldes négatifs et réserves | Finance + juridique | Merchant/settlement, compte connecté |
| `FIN-002` | Base, taux, arrondi, fixe/minimum/maximum, frais Stripe, TVA de la commission et traitement des refunds | Finance + produit | Commission, remboursements partiels |
| `FIN-003` | Statut de taxe, règle, taux/montant, données fiscales et effet sur la commission | Expert-comptable + juridique | TVA/fiscalité |
| `FIN-004` | Émetteur de facture/reçu, vendeur, mentions et version de règle | Expert-comptable + juridique | Invoice issuer et documents |
| `FIN-005` | Catalogue, déclenchement, destinataires et mentions des documents financiers/amendements | Finance + juridique | Reçus/factures, amendements |
| `FIN-006` | Délai et message des refunds, frais non récupérables, notifications et conduite des échecs | Finance + juridique | Refunds et paiements tardifs |
| `FIN-007` | Stratégie de caution et paramètres du futur flux | Finance + juridique + produit | Dépôt de garantie |
| `FIN-008` | Facturation/règlement de la commission partenaire et rapprochement | Finance + expert-comptable | Facturation partenaire |

## Valeurs actuelles à ne pas confondre avec des décisions

| Sujet | `CURRENT CODE BEHAVIOR` | Interprétation 21-P0 |
| --- | --- | --- |
| Merchant | `settlementMerchantMode: 'PLATFORM'` à la création du compte connecté ; destination charge dans ADR-010 | Valeur technique courante ; `FIN-001` reste ouvert. |
| `on_behalf_of` | `onBehalfOfAccountId: null` dans le chemin de paiement | Valeur technique courante ; ne vaut pas réponse juridique. |
| Frais marketplace | `ADR-029` et le registre serveur implémentent `split-13-7-v1` : base `subtotal + mandatory fees`, frais loueur 13 %, frais service client 7 %, arrondi `HALF_UP_PER_COMPONENT`, sans fixe ; snapshots immuables | Choix produit interne uniquement. `FIN-002` reste `BLOCKED` pour la validation Finance/Juridique de la base, date d'effet, TVA, frais Stripe, refunds et responsabilités. |
| Taxe | `status: 'NOT_APPLICABLE'`, `amountMinor: null`, `rateBps: null` | **`NOT_APPLICABLE` est une valeur codée, pas une validation fiscale.** `FIN-003` reste ouvert. |
| Émetteur | `invoiceIssuer: 'Uttily'` dans `apps/web/src/lib/payment-config.ts`, propagé au snapshot fiscal | **`Uttily` n'est pas un émetteur approuvé.** `FIN-004` reste ouvert. |
| Devise | EUR est imposé par les contraintes et le périmètre pilote France/Lyon | Ne pas déduire une règle fiscale d'une devise. |
| Total | Le PaymentIntent reprend `customerTotalAmountMinor` du snapshot split ; le booking conserve aussi la base marchande pour la lecture Pro | Aucun choix financier ultérieur ne doit réécrire un snapshot confirmé. Les legacy conservent leur total historique. |

Le résolveur échoue si des termes financiers nécessaires sont absents ; il ne
convertit pas une inconnue en zéro. Pour un split, la règle et les montants
viennent exclusivement du snapshot serveur versionné. Une version inconnue ou
un snapshot incohérent est rejeté ; aucun taux de frais ne vient de
l'environnement.

## Flux de fonds — matrice minimum

Les cellules décrivent d'abord le comportement technique observé. `À confirmer`
signale précisément la décision humaine encore attendue ; il ne s'agit pas
d'une règle inventée.

| Scenario | Client | Platform | Connected Account | Commission | Refund/Adjustment | Document generated | Decision IDs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Paiement normal | Paie le `customerTotalAmountMinor` en EUR : base de location + 7 % de frais de service | Crée le PaymentIntent en destination charge ; reçoit techniquement `platformApplicationFeeAmountMinor = frais loueur + frais service` ; responsabilités commerciales à confirmer | Destination Stripe du loueur ; la projection Pro distingue base, frais loueur et net de location | `split-13-7-v1` est la règle technique courante ; choix produit non validé LIVE par Finance/Juridique | Aucun ajustement initial ; un paiement confirmé est snapshoté et ne doit pas être recalculé | Pipeline outbox pour confirmation/contrat/reçu ; client reçoit le total all-in, loueur voit ses composants | `FIN-001`, `FIN-002`, `FIN-003`, `FIN-004`, `FIN-005` |
| Annulation à 100 % | Legacy : doit recevoir le montant fixé par la règle de remboursement approuvée ; split : chemin bloqué avant refund | Legacy preview : `refundAmountMinor = totalAmountMinor` et commission historique ; split : `SPLIT_REFUND_UNRESOLVED` | Effet du reverse transfer et support des pertes à confirmer | Legacy : commission historique ; split : composants 13 % / 7 % non proratisés automatiquement | Exécution idempotente legacy ; split sans création/soumission tant que la politique n'est pas signée | Document/message d'annulation ou refund selon catalogue à valider | `FIN-001`, `FIN-002`, `FIN-005`, `FIN-006` |
| Remboursement partiel | Legacy : reçoit le montant arrondi selon la règle approuvée ; split : chemin bloqué avant refund | Legacy preview : `round(total * pourcentage / 100)` ; split : base/composants à décider | Traitement du transfert et des frais Stripe à confirmer | Legacy : commission finale proratisée ; split : traitement séparé 13 % / 7 % à décider | Montant, flags, délai et conséquences de frais non récupérables à décider | Document de refund/avoir éventuel à définir par décision, sans génération nouvelle dans 21-P0 | `FIN-001`, `FIN-002`, `FIN-004`, `FIN-005`, `FIN-006` |
| Supplément | Paie le delta client final-state de l'amendement via un paiement distinct si le supplément est confirmé | Le chemin G7M réutilise la règle du booking et envoie l'application fee delta technique | Compte connecté et destination sont snapshotés sur `amendment_payments` | Split : delta par composant (`FINAL_STATE_DELTA_PER_COMPONENT`) ; legacy : projection historique | Les deltas négatifs/refunds split restent bloqués tant que `FIN-002` n'est pas signé ; succès tardif traité selon le chemin applicable | Snapshots/amendment documents techniquement possibles ; document, mentions et TVA restent à valider | `FIN-002`, `FIN-003`, `FIN-004`, `FIN-005`, `FIN-006` |
| Paiement tardif sans réservation | Legacy : restitution intégrale quand le paiement est encaissé mais non convertible ; split : compensation bloquée avant refund | Compensation legacy idempotente prévue hors transaction ; split : `SPLIT_REFUND_UNRESOLVED` avant création/soumission | Inversion intégrale du transfert demandée par le protocole legacy actuel | Legacy : restitution intégrale de la commission ; split : composants à décider | `reverse_transfer=true` et `refund_application_fee=true` restent le chemin legacy ; délai/message/frais à confirmer | Notification/document de compensation et conduite d'échec à valider | `FIN-001`, `FIN-004`, `FIN-005`, `FIN-006` |
| Compensation d'un supplément tardif | Legacy : le montant dû est compensé si le succès arrive après expiration/non-convertibilité ; split : compensation bloquée | G7M-C4 reste idempotent pour legacy ; split : blocage avant création/soumission du refund | Le chemin legacy exige l'inversion du transfert et la restitution de la commission | Legacy : refund borné au montant du supplément ; split : traitement 13 % / 7 % à décider | Statut local suivi jusqu'au provider pour legacy ; split sans appel provider | Document/message client et loueur à valider | `FIN-001`, `FIN-003`, `FIN-004`, `FIN-005`, `FIN-006` |
| Paiement échoué ou abandonné | Ne doit pas être présenté comme débité définitivement | Le PaymentIntent/attempt suit les états provider ; aucun refund réussi n'est déclaré sans preuve | Aucun règlement final attendu ; responsabilité de frais éventuels à confirmer | Aucun montant de commission validé sans paiement confirmé | Réconciliation et idempotence existent ; message client et éventuels délais restent à confirmer | Notification d'échec selon catalogue à valider | `FIN-001`, `FIN-005`, `FIN-006` |

## Questions détaillées pour validation

### `FIN-001` — settlement et responsabilités

Répondre par écrit à :

1. entité settlement merchant ;
2. utilisation ou non de `on_behalf_of` ;
3. partie supportant les frais Stripe ;
4. partie supportant refunds, chargebacks, litiges et soldes négatifs ;
5. mécanisme contractuel de récupération d'une somme avancée au loueur ;
6. réserve de trésorerie, seuils et autorité de suspension.

La destination charge, le compte connecté unique et le mono-loueur sont les
contraintes techniques existantes. Elles ne répondent pas à ces questions.

### `FIN-002` — commission

Pour chaque offre/partenaire pilote : base (total TTC, sous-total ou autre),
taux BPS, éventuel fixe, min/max, arrondi, frais Stripe, TVA/facture de la
commission, traitement d'un refund total/partiel, date d'effet et version.

### `FIN-003` et `FIN-004` — fiscalité et émetteur

Préciser vendeur juridique, `APPLIED` ou `NOT_APPLICABLE`, règle de calcul,
taux/montant, données fiscales du loueur, traitement de la commission, émetteur
de la facture/reçu et mentions obligatoires. Le snapshot fiscal est immuable
après paiement : une incompatibilité catalogue doit être corrigée avant un
nouveau brouillon, pas après confirmation.

### `FIN-005` et `FIN-006` — documents et refunds

Valider les déclencheurs et destinataires de confirmation, contrat, reçu,
facture, avoir et documents d'amendement, puis le délai et le message client
pour refund normal, refund tardif, refund partiel, échec provider et résultat
ambigu. Les workers/crons sont des mécanismes techniques ; ils ne déterminent
pas les obligations de notification.

### `FIN-007` — caution

Choisir explicitement une stratégie parmi `CARD_AUTHORIZATION`,
`EXTENDED_AUTHORIZATION`, `CARD_ON_FILE`, `INSURANCE`, `EXTERNAL_DEPOSIT` ou
`NO_DEPOSIT`, avec catégories, montant, durée, déclenchement, preuve de dommage,
responsabilité et restitution. ADR-010 exclut la caution du PaymentIntent de
location ; aucune implémentation n'est ajoutée ici.

### `FIN-008` — partenaire

Décrire l'émetteur, la périodicité, la devise, les pièces et le rapprochement de
la facture/commission partenaire. Une destination charge et un payout Stripe
ne constituent pas automatiquement une facture commerciale entre Uttily et le
loueur.

## État de clôture du pack

`FINANCE PACK = PASS` signifie que les questions, valeurs courantes, scénarios
et prochaines actions sont exposés sans défaut caché. Aucun `FIN-*` n'est
`APPROVED` dans ce dépôt.
