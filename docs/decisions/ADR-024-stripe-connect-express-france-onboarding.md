# ADR-024 — Stripe Connect Express et onboarding France du MVP

- **Statut** : Accepted
- **Date** : 2026-08-17
- **Décideurs** : Porteur produit Uttily, engineering
- **Relie à** : [ADR-010 — Stripe Connect, paiement, confirmation et réconciliation](./ADR-010-stripe-connect-payment-confirmation-and-reconciliation.md), [ADR-014 — Fournisseurs de production et déploiement du worker](./ADR-014-production-providers-and-worker-deployment.md)

## 1. Contexte

Le MVP active la France en premier marché et reste limité à l'EUR au lancement. Le
paiement marketplace repose sur Stripe Connect avec des destination charges et un
compte connecté par organisation.

L'implémentation actuelle a retenu Accounts v1 avec les controller properties de
Stripe. Sa valeur par défaut d'onboarding collecte les exigences côté plateforme
(`controller.requirement_collection=application`) et n'expose pas de Dashboard
Stripe. Cette combinaison correspond au parcours Custom actuellement envisagé,
mais elle n'est pas exploitable pour le MVP français : Stripe refuse en France les
comptes configurés avec `controller.requirement_collection=application` lorsque la
plateforme ne fournit pas les Account Tokens requis.

Le MVP a déjà choisi l'onboarding hébergé par Stripe. Uttily ne construit donc pas
de formulaire KYC et ne stocke pas de données KYC. Le compte et son état de
readiness sont projetés localement à partir des événements Connect, sans faire de
la page de retour d'onboarding une preuve de capacité de paiement.

## 2. Décision

Pour la France au MVP, Uttily conserve Accounts v1 et les controller properties,
mais adopte la combinaison compatible avec Stripe Connect Express suivante :

| Responsabilité locale | Paramètre Stripe Accounts v1 | Valeur retenue |
| --- | --- | --- |
| La plateforme paie les frais Stripe (`PLATFORM`) | `controller.fees.payer` | `application` |
| La plateforme porte les pertes de paiement (`PLATFORM`) | `controller.losses.payments` | `application` |
| Le loueur dispose du Dashboard Express | `controller.stripe_dashboard.type` | `express` |
| Stripe collecte les exigences du compte (`STRIPE`) | `controller.requirement_collection` | `stripe` |

Cette décision signifie que les comptes connectés du parcours français sont des
comptes Express au sens du Dashboard et de l'onboarding, tout en restant créés
via l'API Accounts v1 et ses controller properties. Elle ne réintroduit pas les
types legacy `Express` ou `Custom` comme contrat interne.

Les destination charges restent inchangées : le PaymentIntent est créé sur la
plateforme, `transfer_data.destination` désigne le compte du loueur et
`application_fee_amount` porte la commission figée lorsqu'elle est strictement
positive. L'onboarding reste Stripe-hosted, avec les liens de rafraîchissement et
de retour existants ; Uttily ne collecte ni ne persiste le KYC.

### Relation avec ADR-010

ADR-024 ne modifie pas les décisions de paiement, de destination charges,
d'Accounts v1, de webhook, de réconciliation ou de contrôle LIVE de l'ADR-010.
Elle **supersède uniquement la valeur par défaut d'onboarding** pour le périmètre
France du MVP : la combinaison `requirement_collection=application` / Dashboard
absent est remplacée par la combinaison Express ci-dessus, notamment
`requirement_collection=stripe`. Toute autre portée de l'ADR-010 reste applicable.

L'ADR-024 doit être référencée lors de l'implémentation afin que la valeur par
défaut et les tests du use case de création de compte appliquent cette décision
pour le parcours France. Cette capsule ne modifie pas l'ADR-010.

## 3. Invariants de mise en œuvre

1. **Pays et devise** : le lancement concerne la France (`FR`) et l'EUR. Aucun
   élargissement de pays ou de devise ne découle de cette ADR.
2. **Readiness locale** : l'événement Connect signé `account.updated` reste la
   source de projection de l'état du compte. La readiness locale s'appuie sur
   les capacités et statuts Stripe nécessaires aux destination charges
   (`charges_enabled`, `payouts_enabled` et capacité de transferts). Un retour
   d'onboarding réussi ne suffit pas à marquer le compte prêt.
3. **Idempotence** : la création du compte, la génération des liens hébergés et
   le traitement des webhooks utilisent des clés ou identifiants stables. Les
   retries ne créent ni second compte local ni seconde projection d'un même
   événement.
4. **Minimisation des données** : aucun KYC, document justificatif ou donnée
   sensible collectée par Stripe n'est stocké par Uttily. Le stockage local reste
   limité aux identifiants provider, aux statuts et au read model technique de
   readiness nécessaires au fonctionnement du paiement.
5. **Garde-fou LIVE** : `PAYMENTS_LIVE_ENABLED=false` tant que les verrous
   finance/juridique de l'ADR-010 §4 ne sont pas tous fermés. Cette décision ne
   constitue pas une autorisation de paiement LIVE.

## 4. Conséquences

### 4.1 Conséquences positives

- Le parcours est compatible avec les contraintes Stripe applicables aux
  plateformes françaises sans introduire les Account Tokens.
- Stripe collecte les exigences dans son parcours hébergé et fournit le Dashboard
  Express ; Uttily évite de construire et de maintenir un parcours KYC.
- La décision réutilise le contrat local Accounts v1, les champs de readiness et
  le flux `account.updated` déjà prévus par l'ADR-010.
- Les destination charges, la commission de plateforme et la responsabilité
  financière déjà choisie pour le MVP ne changent pas.

### 4.2 Conséquences négatives

- Uttily dépend de l'UX, des exigences et de la disponibilité de l'onboarding et
  du Dashboard Stripe Express ; la personnalisation du KYC est limitée.
- La readiness est éventuellement cohérente après réception du webhook, et non
  instantanément au retour du navigateur ; les retries, déduplications et
  alertes webhook restent indispensables.
- La plateforme conserve l'exposition financière associée aux frais, pertes,
  remboursements et litiges des destination charges. Les verrous finance et
  juridique de l'ADR-010 restent donc nécessaires avant LIVE.
- Un besoin futur de collecte contrôlée par Uttily devra faire l'objet d'un
  nouveau parcours Account Tokens et d'une décision dédiée.

## 5. Options rejetées

### 5.1 Account Tokens avec `requirement_collection=application`

Rejetés pour le MVP France : cette option exige un nouveau parcours de collecte
KYC et la gestion des Account Tokens côté plateforme. Elle contredit le choix
MVP d'un onboarding Stripe-hosted sans stockage de KYC et ne résout pas le
besoin de réduire le périmètre d'implémentation.

### 5.2 Accounts V2

Reportés : le modèle V2 a un mapping et un contrat distincts. Il ne fournit pas
le même modèle de readiness que le contrat `ConnectedAccountResult` utilisé par
le MVP (`charges_enabled`, `payouts_enabled`, capacités et controller v1). Une
adoption nécessiterait une couche de mapping, une révision du contrat et une
validation séparée ; elle n'est pas nécessaire pour ce choix France.

### 5.3 Configuration Custom actuelle

Rejetée pour le MVP France : la configuration actuelle avec
`requirement_collection=application` et sans Dashboard Stripe est refusée par
Stripe en France sans Account Tokens. Elle est en outre incompatible avec le
Dashboard Express. Le fait de conserver les controller properties et Accounts v1
ne signifie donc pas de conserver cette combinaison de responsabilités.

## 6. Hors périmètre

- Toute migration SQL ou modification de schéma ;
- tout changement du contrat de données au titre de cette seule décision ;
- toute activation des paiements LIVE ou modification de
  `PAYMENTS_LIVE_ENABLED` ;
- toute modification de la responsabilité financière, des règles de commission,
  de la fiscalité, des remboursements ou des litiges au-delà du choix explicite
  des controller properties ci-dessus ;
- toute migration vers Accounts V2 ou tout nouveau parcours Account Tokens.

## 7. Références d'implémentation

- [ADR-010, §3.2–§3.3 et §4](./ADR-010-stripe-connect-payment-confirmation-and-reconciliation.md)
- [ADR-014](./ADR-014-production-providers-and-worker-deployment.md)
- [Configuration Stripe TEST et onboarding hébergé](../implementation/stripe-test-setup.md)
