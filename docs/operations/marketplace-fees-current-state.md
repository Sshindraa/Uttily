# État canonique — frais marketplace

**Dernière revue :** 2026-08-30
**Statut :** implémentation technique présente ; activation LIVE bloquée par `FIN-002`

Ce document est le point d'entrée pour toute analyse du modèle de frais
marketplace. Il décrit l'état du dépôt et ne constitue pas un sign-off Finance,
Juridique ou fiscal.

## Références canoniques

| Sujet | Source |
| --- | --- |
| Décision et périmètre | [`ADR-029`](../decisions/ADR-029-marketplace-fee-split-13-7.md) |
| Remboursements split et diminutions après amendement | [`ADR-030`](../decisions/ADR-030-split-refund-policy.md) |
| Moteur de calcul | [`packages/core/src/marketplace-fees/engine.ts`](../../packages/core/src/marketplace-fees/engine.ts) |
| Types et parser du snapshot | [`packages/core/src/marketplace-fees/types.ts`](../../packages/core/src/marketplace-fees/types.ts) |
| Schéma et migration | [`packages/database/drizzle/0049_split_marketplace_fees.sql`](../../packages/database/drizzle/0049_split_marketplace_fees.sql) |
| Paiement et application fee | [`packages/core/src/payment-initiation/initiate-payment.ts`](../../packages/core/src/payment-initiation/initiate-payment.ts) |
| Checkout client | [`Checkout client — page de paiement`](../../apps/web/src/app/checkout/[draftId]/page.tsx) |

Si ce document ou l'ADR-029 est absent du commit analysé, le modèle 13/7 n'est
pas présent dans cette référence Git. Il faut alors identifier la branche ou le
commit qui porte 22-B0 avant de conclure à une absence dans le dépôt.

Pendant une transition de branche, `origin/main` peut encore contenir l'ancien
modèle configurable à 10 % et `PLATFORM_COMMISSION_RATE_BPS`. Cette présence
décrit une baseline legacy ; elle ne doit pas être comparée au moteur 13/7 sans
vérifier le commit qui porte 22-B0.

## Règle technique `split-13-7-v1`

La base est `subtotalAmountMinor + mandatoryFeesAmountMinor`.

- frais imputés au loueur : 13 % (`1300` bps) ;
- frais de service client : 7 % (`700` bps) ;
- arrondi : `HALF_UP_PER_COMPONENT` ;
- aucun frais fixe ni minimum/maximum ;
- total payé par le client : base + frais de service ;
- net de la base loueur : base - frais loueur ;
- `platformApplicationFeeAmountMinor` : frais loueur + frais client.

Exemple pour une base de 100,00 € : le client paie 107,00 €, le frais loueur
vaut 13,00 €, le frais client 7,00 €, le net de base loueur 87,00 € et
l'application fee technique vaut 20,00 €.

L'invariant contrôlé est :

```text
customerTotal - platformApplicationFee = merchantNet
```

## Snapshot et compatibilité legacy

Le snapshot `marketplaceFeeSnapshot` est la source de vérité du split. Il est
conservé de manière immuable sur les drafts, paiements, réservations et
amendements concernés.

Les champs historiques restent nécessaires pour lire les réservations legacy :

- `totalAmountMinor` représente la base marchande dans un booking split et le
  total historique dans un booking legacy ;
- `customerTotalAmountMinor` représente le montant réellement payé par le
  client pour un booking split ;
- `commissionAmountMinor` est seulement la projection de compatibilité du frais
  loueur ; il ne représente pas l'application fee totale du split.

Les réservations legacy ne sont pas recalculées et ne sont pas converties au
modèle 13/7.

## Remboursements et annulations split (ADR-030)

Le moteur de calcul d'annulation composant par composant est désormais
implémenté conformément à [`ADR-030`](../decisions/ADR-030-split-refund-policy.md) :
- `calculateSplitCancellationRefund` calcule la répartition exacte : remboursement
  client, reprise loueur (13 %), restitution Uttily (13 % + 7 %) et montants retenus,
  avec la règle d'arrondi `HALF_UP_PER_COMPONENT` ;
- `previewBookingCancellation` et `cancelConfirmedBooking` autorisent l'annulation
  des réservations split et enregistrent le `marketplaceFeeDelta` dans la table
  `booking_cancellations` ;
- les annulations intégrales (100 %) sont exécutées directement sur le provider
  (adéquation parfaite de la destination charge avec `reverse_transfer` et
  `refund_application_fee`) ; les annulations partielles basculent en
  `FAILED_REQUIRES_MANUAL_ACTION` conformément à l'ADR-030 §3.2 pour traitement manuel audité.

Avant une activation LIVE, `FIN-002` doit encore fixer et faire approuver la
base fiscale, la date d'effet, la TVA, les frais Stripe, le settlement, les
chargebacks et les responsabilités. La présence du moteur et de ses tests ne vaut
pas validation externe.

## Vérification rapide par un agent

1. Vérifier `git branch --show-current`, `git rev-parse HEAD` et `git status`.
2. Lire cette page et l'ADR-029.
3. Chercher `MARKETPLACE_FEE_RULE_VERSION` et `0049_split_marketplace_fees.sql`.
4. Distinguer `origin/main` de la branche analysée ; une baseline historique ne
   décrit pas nécessairement le commit courant.
5. Vérifier séparément l'état technique et le statut `FIN-002`.
