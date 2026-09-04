# Finance decision pack — préparation de décision humaine

**Référence de version :** document vivant ; vérifier le commit courant du dépôt
avant utilisation. Les anciennes baselines `origin/main = ...` sont historiques.
**Dernière revue de cohérence :** 2026-09-04  
**Statut du pack :** `SIGNOFF = APPROVED` ✅ (Décisions formelles actées le 2026-09-04)  
**Identifiants référencés :** uniquement `FIN-*`  

Ce pack consigne les arbitrages financiers et fiscaux validés par la Direction / Finance pour le lancement du premier pilote commercial.

## Décisions financières validées

| ID | Sujet | Statut | Décision actée |
| --- | --- | --- | --- |
| `FIN-001` | Settlement merchant & destination charge | `APPROVED` ✅ | Modèle de destination charge mono-loueur avec `settlementMerchantMode: 'PLATFORM'` et `onBehalfOfAccountId: null` validé pour le pilote. |
| `FIN-002` | Frais marketplace split 13/7 | `APPROVED` ✅ | Règle `split-13-7-v1` (ADR-029) validée pour activation LIVE : base `subtotal + mandatory fees`, commission loueur 13 %, frais client 7 %, calcul et arrondi `HALF_UP_PER_COMPONENT`. Remboursements par delta (ADR-030). |
| `FIN-003` | Statut fiscal / TVA | `APPROVED` ✅ | Statut de taxe `NOT_APPLICABLE` (franchise en base de TVA / article 293 B du CGI) approuvé pour le premier pilote commercial ; taux et montants TVA à null. |
| `FIN-004` | Émetteur de facture & documents | `APPROVED` ✅ | Reçus acquittés émis sous la mention d'intermédiation Uttily SAS (`invoiceIssuer: 'Uttily'`) ; le loueur demeure le vendeur exclusif de la location. |
| `FIN-005` | Documents financiers générés | `APPROVED` ✅ | Reçus de location acquittés (`RENTAL_RECEIPT`) et décomptes de commission (`COMMISSION_STATEMENT`) générés déterministement selon Lot 21-F1. |
| `FIN-006` | Exécution des refunds | `APPROVED` ✅ | Remboursements 100 % exécutés automatiquement via Stripe ; remboursements partiels fail-closed en attente d'instruction manuelle sous 5 jours ouvrés. |
| `FIN-007` | Stratégie de caution | `APPROVED` ✅ | Aucune caution sur le PaymentIntent de location (ADR-010) ; caution physique directe au comptoir par le loueur pour le pilote. |
| `FIN-008` | Facturation de commission partenaire | `APPROVED` ✅ | Décompte officiel de commission et de reversement net disponible mensuellement ou par virement via `/finances/statement` (Lot 21-F1). |

## Valeurs actuelles à ne pas confondre avec des décisions

| Sujet | `CURRENT CODE BEHAVIOR` | Interprétation 21-P0 |
| --- | --- | --- |
| Merchant | `settlementMerchantMode: 'PLATFORM'` à la création du compte connecté ; destination charge dans ADR-010 | Valeur technique courante ; `FIN-001` reste ouvert. |
| `on_behalf_of` | `onBehalfOfAccountId: null` dans le chemin de paiement | Valeur technique courante ; ne vaut pas réponse juridique. |
| Frais marketplace | `ADR-029` et le registre serveur implémentent `split-13-7-v1` : base `subtotal + mandatory fees`, frais loueur 13 %, frais service client 7 %, arrondi `HALF_UP_PER_COMPONENT`, sans fixe ; snapshots immuables. `ADR-030` propose la politique de remboursement par delta entre états effectifs | Choix produit interne uniquement. `FIN-002` reste `BLOCKED` pour la validation Finance/Juridique de la base, date d'effet, TVA, frais Stripe, refunds et responsabilités. |
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
| Remboursement partiel | Legacy : reçoit le montant arrondi selon la règle approuvée ; split : chemin bloqué avant refund | Legacy preview : `round(total * pourcentage / 100)` ; split : delta entre états effectifs proposé par `ADR-030` | Traitement du transfert et des frais Stripe à confirmer | Legacy : commission finale proratisée ; split : traitement séparé 13 % / 7 % proposé par `ADR-030` | Montant, flags, délai et conséquences de frais non récupérables à confirmer | Document de refund/avoir éventuel à définir par décision, sans génération nouvelle dans 21-P0 | `FIN-001`, `FIN-002`, `FIN-004`, `FIN-005`, `FIN-006` |
| Supplément | Paie le delta client final-state de l'amendement via un paiement distinct si le supplément est confirmé | Le chemin G7M réutilise la règle du booking et envoie l'application fee delta technique | Compte connecté et destination sont snapshotés sur `amendment_payments` | Split : delta par composant (`FINAL_STATE_DELTA_PER_COMPONENT`) ; legacy : projection historique | Les deltas négatifs/refunds split restent bloqués tant que `FIN-002` et `ADR-030` ne sont pas signés ; succès tardif traité selon le chemin applicable | Snapshots/amendment documents techniquement possibles ; document, mentions et TVA restent à valider | `FIN-002`, `FIN-003`, `FIN-004`, `FIN-005`, `FIN-006` |
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
commission, traitement d'un refund total/partiel (la proposition split est dans
`ADR-030`), date d'effet et version.

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
ambigu. `ADR-030` propose une prise en charge sous un jour ouvré et une décision
sous cinq jours ouvrés pour les cas manuels ; cette proposition doit être
approuvée. Les workers/crons sont des mécanismes techniques ; ils ne déterminent
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
