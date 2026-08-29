# ADR-029 — Split des frais marketplace 13/7

**Statut :** implémentation technique autorisée par le produit ; sign-off
Finance/Juridique externe requis avant activation LIVE (`FIN-002 = BLOCKED`).

**Date :** 2026-08-29

## Contexte

Le premier modèle de paiement mélangeait la base de location et une
commission configurable par environnement. Cette représentation ne permettait
pas d'afficher séparément le prix payé par le client, les frais de service et
les frais imputables au loueur.

## Décision

Le registre serveur fermé expose une seule règle active : `split-13-7-v1`.

- base marketplace : `subtotalAmountMinor + mandatoryFeesAmountMinor` ;
- frais plateforme loueur : 13 % (`1300` bps), arrondi `HALF_UP_PER_COMPONENT` ;
- frais de service client : 7 % (`700` bps), avec le même arrondi ;
- aucun frais fixe ; frais mensuel Uttily OS : `0` ;
- total client : base + frais de service ;
- net de la base loueur : base - frais plateforme loueur ;
- `platformApplicationFeeAmountMinor` : somme des deux composants ;
- invariant : `customerTotal - platformApplicationFee = merchantNet`.

Chaque draft, payment, booking et amendement split conserve son snapshot
économique immuable. Les paiements utilisent le total client et l'application
fee technique du snapshot. `commissionAmountMinor`, quand il reste présent,
est uniquement une projection de compatibilité du frais loueur ; il n'est
jamais l'autorité du split.

## Compatibilité et périmètre

Les lignes legacy restent legacy : aucune migration rétroactive de taux ou de
montant n'est effectuée. Les chemins inconnus, snapshots falsifiés, versions de
règle inconnues et refunds split non spécifiés échouent fermés. Les refunds
legacy conservent leur comportement existant.

Les amendements split utilisent `FINAL_STATE_DELTA_PER_COMPONENT` sous la règle
historique du booking. Un delta négatif n'est pas converti en refund tant que
la politique Finance/Juridique n'est pas signée.

### CURRENT_SPLIT_FEE_REFUND_BEHAVIOR

Le provider actuel ne reçoit que le montant global du paiement et les flags
agrégés `reverse_transfer` / `refund_application_fee`. Il ne permet donc pas
de décider séparément du remboursement du prix marchand, des 13 % loueur et
des 7 % client. Les chemins d'annulation, d'amendement en baisse et de
compensation tardive sont bloqués avant toute création ou soumission de
refund split. Les refunds legacy continuent à utiliser leur comportement
historique, avec leurs flags persistés.

Le registre serveur est la seule autorité des taux et de la version. Ni le
navigateur ni une variable d'environnement ne peuvent les fournir.

## Conséquences

La recherche, l'offre, le draft et le checkout exposent la même économie
all-in. Le checkout détaille la location, les frais de service et le total.
Les vues Pro affichent le prix de location, le frais plateforme loueur et le
net de location ; un net de location n'est pas présenté comme un payout Stripe.

Le choix produit 13/7 est enregistré, mais ne constitue pas à lui seul une
validation comptable, fiscale, juridique ou de settlement. `FIN-002` reste
`BLOCKED` jusqu'à la décision externe sur base, date d'effet, fiscalité,
remboursements et responsabilités.
