# Runbook 21-OPS — Procédure d'Activation Stripe LIVE & Webhooks

**Référence opérationnelle :** Chantier 20-A & Chantier 21-P0  
**Décisions associées :** `OPS-004`, `PARTNER-002`, `C2E-03`, `C2E-04`, `C2E-05`, `ADR-010`, `ADR-024`  
**Autorités :** Engineering + Porteur Produit + Responsable Recovery  
**Règle d'or absolue :** **Zéro secret (clés API, secrets webhook, tokens) dans le dépôt Git, les logs, les issues ou la documentation. Toute preuve consignée doit être strictement non secrète (SHA commit, IDs fonctionnels `acct_...`, horodatages UTC, statuts bornés).**

---

## 1. Contexte & Séquence d'ordonnancement

Le passage en environnement LIVE active la circulation réelle de fonds bancaires. Conformément au registre des décisions (`decision-registry.md`), la séquence doit être respectée de manière ordonnée et fail-closed :

```text
1. Décisions approuvées (Legal/DPO/Finance)
      │
2. Pages & Documents publiés (v1 opposable)
      │
3. Configuration Stripe Platform (clés LIVE, webhooks Platform & Connect)
      │
4. Sécurité réseau & Edge (IP allow-list, Vercel Firewall rate-limit)
      │
5. Injection sécurisée des variables d'environnement dans Vercel
      │
6. Vérification automatique non destructive : pnpm readiness:live
      │
7. Onboarding & Raccordement du Connected Account Partenaire LIVE
      │
8. Smoke tests sécurisés (test webhook Stripe, vérification de projection)
      │
9. Signature formelle de l'opérateur et du porteur produit (OPS-004)
```

---

## 2. Phase 1 : Configuration sur le Dashboard Stripe LIVE

Connectez-vous au Dashboard Stripe en mode **LIVE** (le toggle en haut à gauche doit être sur *Live mode*).

### 2.1. Clés d'API Plateforme (Credentials)
1. Naviguer vers **Développeurs > Clés d'API**.
2. Récupérer la **Clé publiable** (commence impérativement par `pk_live_`).
3. Créer ou révéler une **Clé secrète** (commence impérativement par `sk_live_`).
   > *Recommandation de sécurité :* Utiliser une *Restricted Key* dotée des autorisations minimales nécessaires :
   > - `PaymentIntents` : Écriture
   > - `Charges` : Écriture (pour remboursements)
   > - `Refunds` : Écriture
   > - `Webhook Endpoints` : Lecture
   > - `Connected Accounts` : Écriture / Gestion Connect

### 2.2. Webhook Plateforme (Platform Webhook)
1. Naviguer vers **Développeurs > Webhooks**.
2. Cliquer sur **Ajouter un point de terminaison** (Endpoint).
3. **URL du point de terminaison :**  
   `https://<DOMAINE_PUBLIC>/api/webhooks/stripe/platform`  
   *(Exemple : `https://app.uttily.com/api/webhooks/stripe/platform`)*
4. **Version d'API :** Sélectionner `2026-06-24.dahlia` (version alignée avec `packages/core/src/stripe/client.ts`).
5. **Événements à écouter (Événements sur votre compte) :**
   - `payment_intent.succeeded`
   - `charge.refunded`
   - `refund.updated`
   - `refund.failed`
6. Cliquer sur **Ajouter un point de terminaison**.
7. Dans l'écran de détails du webhook créé, dans la section *Secret de signature*, cliquer sur **Révéler**.
8. Noter la valeur commençant par `whsec_...` (destinée à `STRIPE_PLATFORM_WEBHOOK_SECRET`).

### 2.3. Webhook Connect (Connect Webhook)
1. Toujours dans **Développeurs > Webhooks**, cliquer à nouveau sur **Ajouter un point de terminaison**.
2. **URL du point de terminaison :**  
   `https://<DOMAINE_PUBLIC>/api/webhooks/stripe/connect`
3. **Écouter les événements sur :** Cocher impérativement **Comptes connectés** (*Listen to events on Connected accounts*).
4. **Version d'API :** `2026-06-24.dahlia`.
5. **Événements à écouter :**
   - `account.updated`
6. Cliquer sur **Ajouter un point de terminaison**.
7. Révéler le secret de signature `whsec_...` (destiné à `STRIPE_CONNECT_WEBHOOK_SECRET`).

> [!CAUTION]
> **Règle d'isolation des secrets (Gate `STRIPE_WEBHOOK_ENDPOINT_SECRETS_DISTINCT`) :**  
> Le secret du webhook Platform et le secret du webhook Connect **doivent être strictement distincts**. Ne jamais réutiliser le même endpoint ou le même secret pour les deux flux.

---

## 3. Phase 2 : Sécurité Edge, Réseau & Pare-feu

Conformément à l'ADR-010 §14, le endpoint webhook applique une politique de défense en profondeur :

### 3.1. Allow-list IP des Webhooks Stripe (`STRIPE_WEBHOOK_IP_ALLOWLIST`)
En environnement `LIVE`, le code d'Uttily applique un contrôle **fail-closed** : si la requête ne provient pas d'une adresse IP autorisée de Stripe, elle est immédiatement rejetée avec un code `HTTP 403 Forbidden`.

1. Consulter la liste officielle des adresses IP des serveurs webhooks de Stripe ([Documentation Stripe](https://docs.stripe.com/ips#webhook-ips)).
2. Les adresses IPv4 officielles actuelles pour les webhooks Stripe sont :
   ```text
   3.18.12.63,3.130.192.212,13.235.14.237,13.235.122.149,18.211.135.69,35.154.171.200,52.15.183.38,54.88.130.119,54.187.174.169,54.187.205.235,54.187.216.72
   ```
3. Formater cette liste sous forme d'une chaîne unique séparée par des virgules (sans espaces) pour la variable `STRIPE_WEBHOOK_IP_ALLOWLIST`.

### 3.2. Rate Limiting Edge & Attestation (`STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED`)
1. Dans le Dashboard Vercel du projet de production :  
   Naviguer vers **Security > Firewall / WAF**.
2. Configurer une règle de limitation de débit (Rate Limit) ciblant le préfixe `/api/webhooks/stripe/*` :
   - Seuil Platform : 10 requêtes / seconde par IP (burst 20) ;
   - Seuil Connect : 5 requêtes / seconde par IP (burst 10) ;
   - Action : Retourner `HTTP 429 Too Many Requests` avec en-tête `Retry-After: 5`.
3. Une fois cette règle active sur Vercel, positionner l'attestation légale :
   `STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED=true`.

---

## 4. Phase 3 : Injection sécurisée des Variables d'Environnement dans Vercel

Injecter les variables dans le projet Vercel de production via la CLI Vercel ou l'interface d'administration sécurisée.

```bash
# Variables critiques Stripe LIVE
vercel env add STRIPE_SECRET_KEY production
# > Entrer la valeur sk_live_...

vercel env add NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY production
# > Entrer la valeur pk_live_...

vercel env add STRIPE_ENVIRONMENT production
# > Entrer: LIVE

vercel env add PAYMENTS_LIVE_ENABLED production
# > Entrer: true

vercel env add STRIPE_PLATFORM_WEBHOOK_SECRET production
# > Entrer la valeur whsec_... du webhook Platform

vercel env add STRIPE_CONNECT_WEBHOOK_SECRET production
# > Entrer la valeur whsec_... du webhook Connect

vercel env add STRIPE_WEBHOOK_IP_ALLOWLIST production
# > Entrer la liste des IPs Stripe séparées par des virgules

vercel env add STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED production
# > Entrer: true
```

---

## 5. Phase 4 : Vérification formelle d'intégrité via `pnpm readiness:live`

Une fois les variables configurées dans l'environnement de production/staging, exécuter la vérification automatisée non destructive :

```bash
pnpm readiness:live
```

### Critères d'acceptation stricts :
- Le rapport JSON doit retourner `"ready": true` ;
- `"requiredPassCount": 23` ;
- `"requiredFailCount": 0` ;
- `"gateFailCount": 0` ;
- Gate `STRIPE_WEBHOOK_ENDPOINT_SECRETS_DISTINCT` : `PASS` ;
- Gate `ANALYTICS_PRODUCTION_PRIVACY_LOCK` : `PASS` (l'analytics production doit rester verrouillé sur `DISABLED`).

> Si la commande retourne un code de sortie 1 ou `ready: false`, analyser les noms de variables en statut `MISSING`, `INVALID_PREFIX` ou `EMPTY`. **Ne pas poursuivre tant que `readiness:live` n'est pas 100% vert.**

---

## 6. Phase 5 : Onboarding & Raccordement du Partenaire Pilote (`PARTNER-002`, `C2E-03`)

1. **Invitation du loueur partenaire :**
   Le représentant légal de l'organisation partenaire accède à son espace Uttily (`/dashboard/[orgId]/onboarding`).
2. **Onboarding Stripe Express :**
   Le loueur clique sur *Configurer les paiements* et complète la saisie de son identité, IBAN bancaire et justificatifs d'entreprise sur l'interface sécurisée Stripe Connect.
3. **Réception du webhook `account.updated` :**
   Dès validation par Stripe, l'événement est reçu sur `/api/webhooks/stripe/connect`.
4. **Vérification de la projection PostgreSQL serveur :**
   Exécuter une requête en lecture seule sur la base de données de production pour certifier les capacités du compte sans passer par l'UI :
   ```sql
   SELECT 
     organization_id,
     provider_account_id,
     environment,
     onboarding_status,
     charges_enabled,
     payouts_enabled,
     transfers_capability_status
   FROM organization_payment_accounts
   WHERE organization_id = '<UUID_ORGANISATION_PARTENAIRE>'
     AND environment = 'LIVE';
   ```
5. **Critères d'acceptation du compte connecté :**
   - `environment` = `'LIVE'`
   - `onboarding_status` = `'ENABLED'`
   - `charges_enabled` = `true`
   - `payouts_enabled` = `true`
   - `transfers_capability_status` = `'ACTIVE'`
6. Le jalon `PAYMENTS` de l'onboarding loueur (`getConnectedAccountReadiness`) bascule alors automatiquement sur `ready: true`.

---

## 7. Phase 6 : Smoke Tests Opérationnels Sécurisés (Non Destructifs)

Ne **jamais** effectuer une fausse réservation commerciale avec débit bancaire réel pour tester le système avant tous les feux verts.

1. **Test de connectivité Webhook Platform :**
   - Dans le Dashboard Stripe LIVE > Webhooks > Cliquer sur l'endpoint Platform.
   - Cliquer sur **Tester les webhooks dans votre environnement** (Send test event).
   - Sélectionner `payment_intent.succeeded` avec un faux ID `pi_test_probe`.
   - Envoyer l'événement.
   - Constater le retour `HTTP 200 OK` dans l'historique des livraisons Stripe.
2. **Test de connectivité Webhook Connect :**
   - Même manipulation sur l'endpoint Connect avec un événement `account.updated`.
   - Constater le retour `HTTP 200 OK`.
3. **Contrôle des logs d'audit serveur :**
   - Vérifier dans les logs de l'application la présence de la ligne structurée :
     ```json
     {"event":"webhook.stripe","endpoint":"platform","result":"success"}
     ```
   - Vérifier qu'aucun secret ni payload bancaire n'apparaît dans les logs d'accès.

---

## 8. Phase 7 : Registre de Sign-off Opérateur (`OPS-004`)

Une fois l'ensemble des étapes complété avec succès, consigner l'enregistrement formel dans [`pilot-readiness.md`](../operations/pilot-readiness.md) :

| Rôle | Nom / Identité | Date (UTC) | Preuve non secrète | Signature |
| :--- | :--- | :--- | :--- | :--- |
| **Opérateur Technique** | | `YYYY-MM-DDTHH:mm:ssZ` | `readiness:live = PASS`, Commit SHA : `...` | Validé |
| **Pôle Paiements / Finance** | | `YYYY-MM-DDTHH:mm:ssZ` | Compte Connecté : `acct_...`, `charges: true` | Validé |
| **Porteur Produit** | | `YYYY-MM-DDTHH:mm:ssZ` | Déblocage Go-Live Pilote | Validé |
