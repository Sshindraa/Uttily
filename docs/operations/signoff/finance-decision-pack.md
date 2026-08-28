# Finance decision pack — préparation de décision humaine

**Base :** `origin/main = eb08f2830abad5fd6643978aee6056e6e59e7171`
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
| Commission | `PLATFORM_COMMISSION_RATE_BPS` doit être explicite ; la configuration documentée utilise `1000` = 10 % ; calcul half-up en unités mineures | Le défaut/documentation locale n'est pas un taux LIVE approuvé. `FIN-002` doit fournir taux, base, version et date d'effet. |
| Taxe | `status: 'NOT_APPLICABLE'`, `amountMinor: null`, `rateBps: null` | **`NOT_APPLICABLE` est une valeur codée, pas une validation fiscale.** `FIN-003` reste ouvert. |
| Émetteur | `invoiceIssuer: 'Uttily'` dans `apps/web/src/lib/payment-config.ts`, propagé au snapshot fiscal | **`Uttily` n'est pas un émetteur approuvé.** `FIN-004` reste ouvert. |
| Devise | EUR est imposé par les contraintes et le périmètre pilote France/Lyon | Ne pas déduire une règle fiscale d'une devise. |
| Total | Le total du PaymentIntent reprend le total immuable du brouillon | Aucun choix financier ultérieur ne doit réécrire un snapshot confirmé. |

Le résolveur échoue si des termes financiers nécessaires sont absents ; il ne
convertit pas une inconnue en zéro. En production, un taux de commission nul
est également refusé par le garde-fou actuel.

## Flux de fonds — matrice minimum

Les cellules décrivent d'abord le comportement technique observé. `À confirmer`
signale précisément la décision humaine encore attendue ; il ne s'agit pas
d'une règle inventée.

| Scenario | Client | Platform | Connected Account | Commission | Refund/Adjustment | Document generated | Decision IDs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Paiement normal | Paie `booking_drafts.total_amount_minor` en EUR via PaymentIntent | Crée le PaymentIntent en destination charge ; reçoit techniquement la commission applicative ; responsabilités commerciales à confirmer | Destination Stripe du loueur ; readiness serveur fondée sur projection du compte | Calcul actuel sur le total avec `PLATFORM_COMMISSION_RATE_BPS`, arrondi half-up ; taux/base LIVE à décider | Aucun ajustement initial ; un paiement confirmé est snapshoté et ne doit pas être recalculé | Pipeline outbox pour confirmation/contrat/reçu ; contenu, émetteur et mentions à valider | `FIN-001`, `FIN-002`, `FIN-003`, `FIN-004`, `FIN-005` |
| Annulation à 100 % | Doit recevoir le montant fixé par la règle de remboursement approuvée | Le preview actuel donne `refundAmountMinor = totalAmountMinor` et rembourse la commission calculée ; paramètres provider et frais à confirmer | Effet du reverse transfer et support des pertes à confirmer pour ce motif | Comportement preview : commission restituée intégralement à 100 % ; règle commerciale à confirmer | Exécution idempotente par le pipeline refunds ; délai, message et flags provider à confirmer selon le cas | Document/message d'annulation ou refund selon catalogue à valider | `FIN-001`, `FIN-002`, `FIN-005`, `FIN-006` |
| Remboursement partiel | Reçoit le montant arrondi selon la règle finalement approuvée | Preview actuel : `round(total * pourcentage / 100)` ; ne tranche pas la base juridique | Traitement du transfert et des frais Stripe à confirmer | Preview actuel : commission finale proratisée sur le montant retenu | Montant, flags, délai et conséquences de frais non récupérables à décider | Document de refund/avoir éventuel à définir par décision, sans génération nouvelle dans 21-P0 | `FIN-001`, `FIN-002`, `FIN-004`, `FIN-005`, `FIN-006` |
| Supplément | Paie le delta de l'amendement via un paiement distinct si le supplément est confirmé | Le chemin G7M réutilise le snapshot du paiement d'origine et calcule la commission du supplément proportionnellement à la commission originale | Compte connecté et destination sont snapshotés sur `amendment_payments` | Comportement actuel G7M-C2 : commission proportionnelle en unités mineures ; règle commerciale et fiscale à confirmer | Pas de refund initial ; expiration/succès tardif peuvent produire une compensation idempotente | Snapshots/amendment documents techniquement possibles ; document, mentions et TVA restent à valider | `FIN-002`, `FIN-003`, `FIN-004`, `FIN-005`, `FIN-006` |
| Paiement tardif sans réservation | A payé ; doit recevoir une restitution intégrale quand le paiement est encaissé mais non convertible | Compensation technique idempotente prévue hors transaction | Inversion intégrale du transfert demandée par le protocole technique actuel | Restitution intégrale de la commission dans le chemin de compensation tardive | `reverse_transfer=true` et `refund_application_fee=true` sont exigés par ADR-010 ; délai/message/frais à confirmer | Notification/document de compensation et conduite d'échec à valider | `FIN-001`, `FIN-004`, `FIN-005`, `FIN-006` |
| Compensation d'un supplément tardif | A payé le supplément ; le montant dû est compensé si le succès arrive après expiration/non-convertibilité | G7M-C4 crée un refund de compensation et un événement outbox idempotents | Le chemin exige l'inversion du transfert et la restitution de la commission | Le refund de compensation est borné au montant du supplément ; traitement fiscal/comptable à confirmer | Statut local reste suivi jusqu'au provider ; intervention si résultat ambigu | Document/message client et loueur à valider | `FIN-001`, `FIN-003`, `FIN-004`, `FIN-005`, `FIN-006` |
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
