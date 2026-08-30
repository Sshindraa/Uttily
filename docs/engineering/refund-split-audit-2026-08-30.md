# Audit technique des remboursements split — 2026-08-30

## Référence et périmètre

Audit réalisé sur `main` au commit `8593280` après fusion de la PR #28.
Le périmètre couvre les annulations, les amendements financiers, les
compensations tardives, le consumer `REFUND_REQUESTED`, la projection des
webhooks et les surfaces client.

Les références métier sont [`ADR-029`](../decisions/ADR-029-marketplace-fee-split-13-7.md),
[`ADR-023`](../decisions/ADR-023-booking-financial-amendments.md), le document
d'état des frais marketplace et le plan de déblocage du pilote.

## Conclusion

Le dépôt est correctement fail-closed aux principaux points de création :

- l'annulation split est refusée par le preview ;
- les amendements `REFUND` split sont refusés avant insertion ;
- les compensations de supplément split et les compensations tardives split
  sont refusées avant création d'un refund ;
- le chemin legacy conserve son comportement historique.

Des écarts restent néanmoins aux frontières du système. Ils ne permettent pas
encore de considérer le traitement des refunds split comme prêt pour une
activation LIVE.

## Suivi technique

Les garde-fous sans décision métier ont depuis été renforcés :

- `REFUND-AUDIT-01` : le read model client tient compte des snapshots booking
  et paiement, désactive l'action et expose `SPLIT_REFUND_UNRESOLVED` à l'interface ;
- `REFUND-AUDIT-03` : le consumer refuse les snapshots split sur les chemins
  annulation, amendement et compensation avant tout appel provider ;
- `REFUND-AUDIT-04` : le webhook tagué exige le lien booking/paiement et refuse
  les snapshots split avec l'invariant fermé existant ;
- `REFUND-AUDIT-05` : la trace d'annulation recopie désormais le snapshot
  économique lorsqu'il existe, sans activer la politique split ;
- `REFUND-AUDIT-06` : le preview compare maintenant les snapshots booking et
  paiement et reste fail-closed dès que l'un des deux est présent.

`REFUND-AUDIT-02` reste volontairement ouvert : le calcul d'annulation après
amendement et la stratégie multi-origines nécessitent toujours une décision
Finance/Juridique.

### Proposition de politique reçue le 2026-08-30

Le porteur produit propose désormais une politique de delta entre l'état
effectif avant amendement et l'état final après amendement, calculée composant
par composant. Cette proposition est formalisée dans
[`ADR-030`](../decisions/ADR-030-split-refund-policy.md) :

- les amendements successifs comparent le dernier état `APPLIED` au nouvel état
  final ;
- le client reçoit la baisse de son total payé ;
- la baisse du net loueur et la baisse de l'application fee Uttily sont
  rapprochées séparément ;
- les frais Stripe non récupérables restent un coût Uttily distinct ;
- un calcul impossible avant application laisse la réservation inchangée ;
- un échec après application conserve l'amendement et la dette visible, avec
  résolution manuelle auditée sous le SLA proposé.

Cette proposition réduit l'ambiguïté produit de `REFUND-AUDIT-02`, mais ne
clôt pas encore le blocker : l'ADR reste `Proposed` jusqu'aux validations
Finance/Juridique et à la preuve que le provider peut exécuter le rapprochement
composant par composant.

## Écarts identifiés

| ID | Priorité | Constat | Impact | Correction proposée |
| --- | --- | --- | --- | --- |
| `REFUND-AUDIT-01` | P0 | Le read model client déclare `cancellation.allowed = true` pour toute réservation `CONFIRMED` ou `READY_FOR_PICKUP`, sans tenir compte du snapshot split. Le Core refuse ensuite le preview avec `SPLIT_REFUND_UNRESOLVED`. | Le client voit un bouton d'annulation qui ouvre une erreur au lieu d'un état cohérent. | Refléter le blocage split dans le read model et afficher une explication stable. Ajouter tests Core/Web. |
| `REFUND-AUDIT-02` | P0 | `cancelConfirmedBooking` et `previewBookingCancellation` lisent les montants du booking original et attachent le refund au paiement initial. Ils n'utilisent pas `getEffectiveBooking`, qui agrège les amendements appliqués, les paiements de supplément et les refunds par origine. | Une annulation legacy après amendement financier peut rembourser un mauvais montant ou ignorer un paiement de supplément ; le cap cumulatif n'est pas garanti sur ce chemin. | La politique proposée est désormais formalisée dans `ADR-030` : delta entre états effectifs, composant par composant, et traitement par origine. Après sign-off, migrer l'annulation vers la projection effective ; d'ici là, bloquer explicitement le scénario split. |
| `REFUND-AUDIT-03` | P0 | Le consumer `REFUND_REQUESTED` vérifie l'origine, les montants et les flags, mais ne rejette pas explicitement un snapshot marketplace présent. Les créateurs actuels bloquent ce cas, mais une écriture manuelle, une ancienne version ou une incohérence de données pourrait atteindre Stripe avec des flags agrégés. | Violation possible de la règle ADR-029 : aucun refund split non spécifié ne doit être soumis au provider. | Ajouter une garde fail-closed dans `verifyRefundRequest`, puis un test d'intégration sans appel provider. |
| `REFUND-AUDIT-04` | P1 | La projection webhook du chemin tagué valide le refund, le PaymentIntent, le compte connecté, le montant et la devise, mais ne revalide pas la présence d'un snapshot split ni le lien complet booking/amendment avant de projeter le statut. | Une donnée split incohérente pourrait être considérée comme un refund legacy techniquement réussi. | Renforcer la projection avec les mêmes invariants que le consumer et ajouter les scénarios webhook correspondants. |
| `REFUND-AUDIT-05` | P1 | `booking_cancellations.marketplace_fee_snapshot` existe depuis la migration `0049`, mais le use case d'annulation ne le renseigne jamais. La trace actuelle conserve seulement les montants legacy `commission_*`. | La preuve financière d'une future annulation split serait incomplète, même après approbation de la politique. | Quand la politique est décidée, persister le snapshot économique et les composants effectivement appliqués dans la trace d'annulation. |
| `REFUND-AUDIT-06` | P1 | Le preview d'annulation ne compare pas le snapshot du booking à celui du paiement. Il considère uniquement `bookings.marketplace_fee_snapshot`. | Une dérive inter-table pourrait faire passer un paiement split dans le chemin legacy. | Lire les deux snapshots et refuser toute incohérence ou toute présence split tant qu'une politique dédiée n'est pas activée. |

## Preuves principales

- Les créateurs split sont bloqués dans `preview-booking-cancellation.ts`,
  `execute-booking-amendment-internal.ts`,
  `compensate-amendment-payment.ts` et `apply-late-compensation.ts`.
- La projection effective documente et vérifie l'invariant :
  `grossCollected - successfulRefunded - settledOffPlatform - refundStillOwed = contractualTotal`.
- Le read model client construit actuellement l'autorisation d'annulation à
  partir du seul statut dans `get-customer-bookings.ts`.
- Le consumer `REFUND_REQUESTED` et le projector webhook utilisent les flags
  Stripe agrégés `reverse_transfer` et `refund_application_fee`, ce qui ne
  permet pas de décider séparément du prix marchand, des 13 % loueur et des
  7 % client.

## Décisions nécessaires avant l'implémentation métier

La proposition `ADR-030` couvre le sens produit des points 1, 2, 4 et 5,
mais les corrections suivantes restent bloquées par les validations humaines
et ne doivent pas être activées implicitement dans le code :

1. validation formelle de la base proposée et de son traitement fiscal ;
2. validation formelle du sort de chacun des composants 13 % et 7 % lors d'un
   remboursement total ou partiel ;
3. frais Stripe non récupérables, reverse transfer, chargebacks et soldes
   négatifs ;
4. validation de l'annulation après amendement financier ou après plusieurs
   paiements ;
5. validation du délai annoncé au client, des notifications et de l'escalade
   d'un échec provider.

Ces sujets correspondent notamment à `FIN-001`, `FIN-002`, `FIN-005`, `FIN-006`,
`LEGAL-004`, `LEGAL-005` et `C2B-06` du plan de déblocage du pilote.

## Ordre de correction recommandé

1. Corriger les surfaces de lecture et le contrôle des deux snapshots
   (`REFUND-AUDIT-01` et `REFUND-AUDIT-06`).
2. Ajouter les gardes fail-closed du consumer et du webhook
   (`REFUND-AUDIT-03` et `REFUND-AUDIT-04`).
3. Faire signer la politique proposée d'annulation après amendement, puis
   adapter le calcul et le cap multi-origines (`REFUND-AUDIT-02`).
4. Après sign-off Finance/Juridique et validation provider, implémenter le
   calcul par composant ainsi que la trace d'audit (`REFUND-AUDIT-05`).

## Validation de l'audit

Les contrôles existants restent verts au commit de référence : tests rapides,
tests PostgreSQL dédiés déjà présents, lint, typecheck, format et build. Aucun
changement LIVE n'est requis ni effectué par cet audit.
