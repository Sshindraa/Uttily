# ADR-025 — Proposition évaluée : onboarding Stripe Connect Embedded dans Uttily

- **Statut** : Rejected
- **Date** : 2026-08-26
- **Décideurs** : Porteur produit Uttily, engineering
- **Relie à** : [ADR-010 — Stripe Connect, paiement, confirmation et réconciliation](./ADR-010-stripe-connect-payment-confirmation-and-reconciliation.md), [ADR-024 — Stripe Connect Express et onboarding France du MVP](./ADR-024-stripe-connect-express-france-onboarding.md)

Cette proposition est **rejetée pour G8A-0**. Elle ne constitue pas une
autorisation d'implémenter l'onboarding Embedded, d'activer les paiements LIVE
ou de modifier les verrous finance/juridique de l'ADR-010. Le parcours retenu
pour la release candidate et le staging reste l'onboarding Stripe-hosted
`AccountLink` documenté et accepté par l'ADR-024. Une réouverture nécessitera
une nouvelle décision explicite et une implémentation complète testée.

## 1. Contexte

Le parcours actuel crée un `AccountLink` pour l'onboarding du compte connecté.
Ce lien redirige le loueur vers `connect.stripe.com`, donc hors d'Uttily. Cette
rupture de parcours n'est pas conforme à la décision produit : l'onboarding du
loueur doit rester dans Uttily et ne doit pas rediriger vers une page Stripe
externe.

Stripe propose les Embedded Components pour afficher l'onboarding dans
l'interface de la plateforme. Le composant d'onboarding est initialisé à partir
d'une `AccountSession` éphémère créée côté serveur. Cette session permet de
fournir à Stripe le contexte de l'onboarding sans faire de son jeton de
bootstrap une donnée métier Uttily.

ADR-024 fixe déjà le parcours France du MVP : Accounts v1 avec controller
properties, responsabilités Express et collecte des exigences par Stripe. Elle
interdit à Uttily de construire un formulaire KYC ou de stocker les données KYC.
ADR-010 conserve les webhooks et l'état PostgreSQL comme autorités, et interdit
notamment de stocker ou journaliser un `client_secret`. L'intégration Embedded
doit donc modifier le contenant UX de l'onboarding, pas ces invariants.

## 2. Solution évaluée (non retenue)

### 2.1 Onboarding intégré

La solution évaluée aurait utilisé une `AccountSession` éphémère pour activer
le composant Stripe Embedded `ConnectAccountOnboarding` directement dans
l'interface Uttily. Elle aurait supprimé, pour ce parcours, l'`AccountLink` qui
redirige vers `connect.stripe.com`.

Le flux cible est le suivant :

```text
MANAGER+ authentifié
  → autorisation serveur et résolution de l'organisation
  → compte connecté depuis organization_payment_accounts
  → use case agnostique createConnectedAccountOnboardingSession
  → port provider createAccountOnboardingSession({ accountId })
  → AccountSession Stripe éphémère
  → client_secret remis en mémoire au composant ConnectAccountOnboarding
  → événements Connect signés
  → projection serveur et relecture de organization_payment_accounts
```

Le use case ne dépend pas du SDK Stripe ni de ses types. Il expose un contrat
provider-agnostique :

```text
createConnectedAccountOnboardingSession
```

Le port provider expose l'opération suivante :

```text
createAccountOnboardingSession({ accountId })
```

L'adapter Stripe traduit cette opération en création d'une `AccountSession` avec
le composant d'onboarding activé. La réponse peut contenir le `client_secret`
nécessaire à l'initialisation du composant côté navigateur, mais ce secret reste
un artefact éphémère de transport et de session : il n'est jamais une preuve de
création, d'identité, de KYC, de readiness ou de capacité de paiement.

Une nouvelle session est créée lorsque le serveur autorisé démarre un parcours.
La session n'est pas persistée dans Uttily et le navigateur ne choisit ni le
compte connecté ni l'organisation à partir d'une valeur faisant autorité côté
client.

### 2.2 Conservation de la configuration Express et des autorités

La configuration retenue par ADR-024 reste inchangée :

| Responsabilité | Paramètre Stripe Accounts v1 | Valeur conservée |
| --- | --- | --- |
| La plateforme paie les frais Stripe | `controller.fees.payer` | `application` |
| La plateforme porte les pertes de paiement | `controller.losses.payments` | `application` |
| Le loueur dispose du Dashboard Express | `controller.stripe_dashboard.type` | `express` |
| Stripe collecte les exigences du compte | `controller.requirement_collection` | `stripe` |

Accounts v1, les controller properties, la France, l'EUR et les destination
charges restent ceux des ADR-010 et ADR-024. Cette ADR ne réintroduit ni les
types legacy `Express`/`Custom`, ni Account Tokens, ni une collecte KYC locale.

Les invariants suivants restent applicables :

- les webhooks Connect signés, dédupliqués et tolérants au désordre projettent
  notamment `account.updated` ; le navigateur, le composant Embedded, la réponse
du provider et `onExit` ne peuvent pas confirmer la readiness ;
- `organization_payment_accounts` reste le read model métier local et l'autorité
  consultée par Uttily pour l'état du compte, ses identifiants provider, ses
  statuts et les capacités nécessaires au paiement ;
- la readiness locale dépend de la projection serveur et non de la fermeture du
  composant ou du retour de la session ;
- les autorités de paiement, de confirmation, de réconciliation et de contrôle
  LIVE de l'ADR-010 ne changent pas ;
- aucune donnée de carte, aucun KYC et aucun justificatif n'est stocké par
  Uttily.

### 2.3 Secret de session et données minimisées

Le `client_secret` de l'`AccountSession` :

- est créé et transmis uniquement pour initialiser le composant Embedded d'une
  requête autorisée ;
- n'est jamais persisté dans une table, une session durable, un cache, une
  télémétrie ou un audit métier ;
- n'est jamais écrit dans les logs, messages d'erreur, URLs, metadata Stripe ou
  traces de diagnostic ;
- n'est jamais interprété ou traité comme preuve métier, preuve de complétion ou
  preuve de capacité de paiement ;
- est éliminé après son usage côté serveur et côté interface selon le cycle de
  vie de la session.

Uttily ne reçoit, ne conserve et ne traite pas les données KYC ni les documents
justificatifs collectés par Stripe. Le stockage local reste borné aux
identifiants du compte provider, aux statuts, aux capacités et au snapshot
technique de readiness nécessaires au paiement, conformément à ADR-024.

### 2.4 Autorisation côté serveur

La création d'une session d'onboarding est une mutation sensible autorisée
côté serveur. Elle est réservée aux membres `MANAGER+` de l'organisation
concernée, c'est-à-dire `MANAGER`, `ADMIN` et `OWNER`. Un membre `STAFF`, un
utilisateur non membre ou un utilisateur d'une autre organisation est refusé.

Le serveur vérifie l'identité, l'appartenance, le rôle, l'organisation ciblée et
la correspondance avec le compte présent dans `organization_payment_accounts`
avant tout appel provider. L'interface ne peut pas élargir cette autorisation
en fournissant un autre `organizationId` ou `accountId`.

### 2.5 UX, Focus Mode et fin de session

Le composant `ConnectAccountOnboarding` est présenté en **Focus Mode** : le
loueur est guidé dans une tâche unique, sans confusion avec le dashboard ou un
état de paiement. Les messages Uttily sont factuels et ne promettent ni
validation immédiate ni capacité de paiement. Ils peuvent indiquer que les
informations sont transmises à Stripe ou que la validation locale attend un
événement Connect, mais ne déclarent pas une complétion sur la seule base de
l'interface.

Le callback `onExit` a une responsabilité volontairement limitée :

1. fermer le conteneur ou le mode focus de l'onboarding ;
2. déclencher une relecture serveur de l'état de l'organisation et de
   `organization_payment_accounts`.

`onExit` n'écrit aucun statut optimiste, ne marque pas l'onboarding comme
terminé, ne transforme pas le `client_secret` en preuve et ne remplace pas le
webhook `account.updated`. Si la projection locale n'a pas encore changé, l'UI
affiche l'état réellement relu, y compris une validation Stripe en attente.

### 2.6 CSP et périmètre MVP

La CSP nécessaire aux Embedded Components Stripe fait partie de
l'implémentation de cette fonctionnalité. Elle doit autoriser explicitement,
avec la portée minimale documentée, les domaines Stripe réellement requis par
le script, les frames et les connexions du composant. Aucun wildcard large ne
doit être ajouté par facilité ; les domaines retenus doivent être vérifiés avec
la version du SDK et le parcours TEST.

Le scope MVP est limité à l'onboarding initial d'un compte connecté existant.
Il n'inclut pas les composants d'**Account Management** ni de **Payouts**. Cette
limite ne retire pas au loueur le Dashboard Express décidé par ADR-024 ; elle
signifie seulement que ces parcours ne sont pas intégrés ou redessinés dans
cette feature. Toute extension fera l'objet d'une décision et d'une revue
séparées.

## 3. Invariants de la solution évaluée

1. **Autorité locale** : le serveur résout le compte connecté depuis
   `organization_payment_accounts`. Un `client_secret`, une réponse du
   composant ou un callback navigateur ne modifie pas cette table.
2. **Readiness** : seuls les événements Connect signés et leur projection locale
   déterminent l'état de readiness utilisé par Uttily. Un retour visuel réussi
   ne suffit pas à autoriser les destination charges.
3. **Idempotence et sessions** : les retries du use case ne créent ni second
   compte local ni seconde projection webhook. Une `AccountSession` peut être
   recréée lorsqu'elle expire ; elle ne constitue pas un enregistrement métier.
4. **Multi-tenant** : l'autorisation `MANAGER+`, l'organisation et le compte
   provider sont vérifiés côté serveur avant la création de la session.
5. **Minimisation** : aucun KYC, justificatif, donnée de carte ou
   `client_secret` n'est persisté ou journalisé par Uttily.
6. **Paiement inchangé** : les destination charges, la confirmation par webhook,
   la réconciliation, le snapshot financier et le verrou
   `PAYMENTS_LIVE_ENABLED=false` tant que les conditions de l'ADR-010 ne sont
   pas fermées restent applicables.
7. **CSP fail-closed** : l'intégration ne contourne pas la CSP existante et
   n'autorise que les domaines Stripe nécessaires au composant.

## 4. Conséquences de la solution évaluée

### 4.1 Conséquences positives

- Le loueur reste dans Uttily pendant l'onboarding ; le parcours n'est plus
  interrompu par une redirection vers une page Stripe externe.
- Stripe conserve la collecte des exigences et du KYC, ce qui évite à Uttily de
  construire, sécuriser et maintenir un formulaire KYC ou de stocker des
  justificatifs.
- Le contrat provider-agnostique sépare le use case métier de la création
  Stripe d'une `AccountSession` et facilite les tests avec un fake provider.
- La source de vérité de readiness, les webhooks, `organization_payment_accounts`
  et les invariants de paiement des ADR-010/024 restent inchangés.
- Le périmètre initial est explicite : l'UX Embedded répond au besoin produit
  sans engager dès maintenant les surfaces Account Management ou Payouts.

### 4.2 Conséquences négatives

- L'intégration dépend du SDK, des contraintes de rendu et de la disponibilité
  des Embedded Components Stripe ; les évolutions de Stripe et de sa CSP devront
  être suivies.
- La session est éphémère : il faut gérer l'expiration, les erreurs de
  chargement, les retries et la transmission sûre du `client_secret` sans le
  journaliser.
- L'UX peut afficher un état différent de la readiness locale pendant le délai
  de réception ou de traitement du webhook `account.updated`.
- Le parcours reste dépendant des exigences et des messages Stripe ; le fait de
  rester dans Uttily ne permet pas de personnaliser ou de stocker le KYC.
- Une extension aux changements de compte ou aux payouts nécessitera des
  autorisations, composants, tests et décisions supplémentaires.

## 5. Options rejetées

### 5.1 Continuer avec `AccountLink` et une page Stripe externe

Rejeté pour ce parcours : cette option conserve la rupture d'expérience vers
`connect.stripe.com` et contredit la décision produit de maintenir l'onboarding
dans Uttily. Elle ne doit pas être utilisée comme fallback silencieux de la
feature Embedded.

### 5.2 Construire un KYC custom Uttily

Rejeté pour le MVP. Cette option ferait porter à Uttily la collecte, la sécurité,
la rétention et la conformité des données KYC et des justificatifs. Elle
contredit ADR-024, qui retient `controller.requirement_collection=stripe` et un
onboarding sans stockage de KYC par Uttily. Un besoin de collecte contrôlée
nécessiterait une décision dédiée et l'étude des Account Tokens.

### 5.3 Utiliser `onExit` comme preuve de complétion

Rejeté. Le callback peut être déclenché avant la fin réelle, après une erreur,
ou avant la réception du webhook. Le prendre pour une preuve contredirait les
autorités et les invariants des ADR-010/024. `onExit` ferme puis relit le
serveur ; il ne fait aucune écriture optimiste.

### 5.4 Ajouter Account Management ou Payouts au MVP

Rejeté du scope de cette ADR. Ces surfaces élargissent les permissions, le
parcours produit et le contrat de l'intégration sans être nécessaires à
l'onboarding initial. Elles restent des options futures à traiter dans une ADR
et une implémentation dédiées.

## 6. Conditions de validation en cas de réouverture

La revue de l'implémentation devra au minimum vérifier :

- le contrôle serveur `MANAGER+` et l'isolation multi-tenant ;
- le câblage `createConnectedAccountOnboardingSession` →
  `createAccountOnboardingSession({ accountId })` sans dépendance Stripe dans le
  use case ;
- l'activation du composant `ConnectAccountOnboarding` avec une
  `AccountSession` éphémère ;
- l'absence de `client_secret` dans la base, les logs, les URLs, la télémétrie et
  les preuves métier ;
- le maintien des tests et invariants de webhook, de readiness et de paiement
  des ADR-010/024 ;
- le comportement `onExit` (fermeture puis relecture serveur, sans état
  optimiste) et les messages factuels en Focus Mode ;
- la CSP minimale pour les domaines Stripe nécessaires, en environnement TEST
  puis dans les environnements applicables ;
- l'absence de stockage Uttily de KYC ou de justificatifs, et l'absence des
  surfaces Account Management/Payouts du MVP.

## 7. Références

- [ADR-010 — Stripe Connect, paiement, confirmation et réconciliation](./ADR-010-stripe-connect-payment-confirmation-and-reconciliation.md)
- [ADR-024 — Stripe Connect Express et onboarding France du MVP](./ADR-024-stripe-connect-express-france-onboarding.md)
- [Configuration Stripe TEST et test manuel E2E](../implementation/stripe-test-setup.md)
- [Stripe Connect Embedded Components](https://docs.stripe.com/connect/embedded-components)
- [Stripe Connect — onboarding avec Embedded Components](https://docs.stripe.com/connect/embedded-components/onboarding)
- [Stripe API — Account Sessions](https://docs.stripe.com/api/account_sessions/create)
