# Phase G5G-A — Audit d'hébergement et choix des fournisseurs de production

Cette phase est une phase de recherche et décision uniquement. Aucun service n'a été installé,
déployé ou configuré. Ce document prépare la décision du porteur produit. Il ne modifie pas
ADR-005 ni ADR-013, et ne ferme aucune question ouverte.

> **Mise à jour 2026-08-05** : les décisions issues de cette évaluation ont été validées par le
> porteur produit et enregistrées dans
> [ADR-014](../decisions/ADR-014-production-providers-and-worker-deployment.md). La section
> « Décisions validées par ADR-014 » ci-dessous distingue les décisions fermées des sujets reportés.
> Le présent document conserve son rôle d'évaluation préparatoire ; ADR-014 est la décision
> exécutoire.

## 0. Décisions validées par ADR-014

### Décisions fermées

| Sujet | Décision (ADR-014) |
| --- | --- |
| Web | Vercel Pro pour le MVP commercial ; Hobby pour dev/staging uniquement |
| Base de données | Neon Launch, région `aws-eu-central-1`, accès public TLS, rôles PostgreSQL séparés Web/worker/migrations, pas d'IP Allow Rules au MVP |
| Worker | VPS DigitalOcean Frankfurt `sokar`, conteneur Docker Node 24, limites CPU/RAM à valider au déploiement, logs JSON comme seule observabilité au premier déploiement |
| Stockage objet (Q6) | Cloudflare R2, juridiction `eu`, bucket privé, API compatible S3, clés applicatives opaques/immuables/versionnées, `putIfAbsent` conditionnel, anomalie fail-closed si checksum différent |
| Email transactionnel (Q7) | Resend (Resend Pro pour le lancement commercial ; Free en dev/staging) |
| Idempotence email (Q14) | Resend supporte `providerIdempotencyKey` nativement dans la fenêtre de 24 h ; politique validée : retry automatique strictement < 24 h, puis fail-closed et intervention manuelle |
| Secrets worker | Fichier env dédié hors Git, propriétaire dédié, chmod 600, aucun secret partagé avec sokar/goldbot |
| Budget MVP commercial | ~55-58 $/mois hors taxes et dépassements |

### Sujets explicitement reportés (non fermés par ADR-014)

| Sujet | Statut |
| --- | --- |
| Neon Scale + IP Allow Rules + Vercel Static IPs (renforcement réseau) | Reporté à justification par risque ou charge (~191-226 $/mois) |
| Endpoint `/healthz`, endpoint `/metrics` Prometheus, adaptateur métriques production | Lot d'implémentation futur |
| Secret manager managé (Doppler, Infisical, Vault) | Reporté ; non choisi dans ADR-014 |
| Adapters R2 et Resend | Non implémentés dans ADR-014 ; lots ultérieurs avec tests |
| Réconciliation automatique par recherche Resend | Non prévue (aucune API documentée au 2026-08-05) |
| Question 9 (URLs signées, durée) | Ouverte |
| Question 16 (régénération/versioning métier) | Ouverte |
| Question 15 (politique objet existant avec checksum différent) | Ouverte |
| Question 5 (conservation RGPD) | Ouverte |
| Question 17 (webhooks délivrabilité/bounce) | Ouverte |
| Questions juridiques et fiscales (1, 2, 3, 4, 10, 11, 12) | Ouvertes |

### Adapters de production — statut

ADR-014 choisit les fournisseurs mais **ne livré aucun adapter**. Les ports `ObjectStorage` et
`TransactionalEmailSender` (ADR-013) restent implémentés uniquement par des fakes en mémoire. Le
worker n'est pas actuellement déployable en production tant que les adapters R2/Resend et le lot de
déploiement VPS ne sont pas livrés. `createWorkerDependenciesFromEnv` continue de lever
`WorkerConfigurationError`.

## 1. État du VPS DigitalOcean

Un audit SSH en lecture seule a été effectué sur deux VPS DigitalOcean (droplets, région FRA1
Frankfurt), accessibles via les alias SSH `pmbtc` et `sokar`. L'adresse publique est masquée
`<VPS-Frankfurt-IP>`.

| Critère | pmbtc | sokar |
| --- | --- | --- |
| Distribution | Ubuntu 24.04.4 LTS (Noble Numbat) | Ubuntu 24.04.4 LTS (Noble Numbat) |
| Architecture | x86_64 | x86_64 |
| CPU | 2 vCPU | 2 vCPU |
| Mémoire totale | 3,8 GiB | 3,8 GiB |
| Mémoire disponible | ~1,9 GiB | ~2,4 GiB |
| Swap | 2 GiB (1,1 utilisés) | 2 GiB |
| Disque | 77 Go (23 Go libres, 71 % utilisés) | 77 Go (58 Go libres, 25 % utilisés) |
| Fuseau | Etc/UTC (NTP actif) | Etc/UTC (NTP actif) |
| Node.js | v22.22.2 (≠ v24 requis) | v22.23.1 (≠ v24 requis) |
| Docker | 29.5.0 | 29.6.2 |
| Docker Compose | v5.1.3 | (présent) |
| Reverse proxy | nginx (sites: goldbot, sokar, sokar-staging) | nginx (sites: sokar, sokar-staging) |
| Firewall | ufw actif (Cloudflare origin allowlist + SSH) | ufw actif (Cloudflare origin allowlist + SSH) |
| Mises à jour | unattended-upgrades actif | unattended-upgrades actif |
| Charge existante | PM2: pmbtc-bot/indicators/node, sokar-api/connect/dashboard (+staging). PostgreSQL 5432 local, Redis 6379 local. | PM2: sokar-api/connect/dashboard (+staging). Docker: postgres:16-alpine, redis:7-alpine, localstack. PostgreSQL 5432 local. |

Notes :

- Aucune IP complète, clé SSH, hostname sensible, token ou contenu de configuration n'est reproduit.
  L'adresse publique est masquée `<VPS-Frankfurt-IP>`.
- Les deux VPS hébergent déjà des projets tiers (sokar, goldbot) via PM2 et/ou Docker ; ressources
  partagées.
- Node installé est v22, pas v24 requis par le worker (`.nvmrc` et `package.json` engines >=24).
  Nécessite installation d'un runtime Node 24 isolé (nvm ou conteneur Docker) — à planifier sans
  modifier l'environnement existant.
- `pmbtc` a moins d'espace disque (23 Go libres) et moins de RAM disponible (~1,9 GiB) ; `sokar` a
  58 Go libres et ~2,4 GiB disponibles.
- Aucun secret, fichier `.env`, `env`, `printenv`, `docker inspect` n'a été lu. Aucun service n'a
  été modifié, redémarré ou arrêté. Aucun paquet installé. Aucun firewall/DNS/SSH/systemd modifié.

Capacité estimée à exécuter le worker Uttuly :

- Le worker est un processus Node 24 léger (boucle outbox, batch borné, pas de trafic HTTP public).
  Les deux VPS peuvent l'héberger en coût marginal 0 €.
- Recommandation préliminaire : `sokar` (plus d'espace disque et de RAM disponibles) ou `pmbtc` si
  on préfère séparer des projets sokar. Le worker doit tourner dans un conteneur Docker isolé ou
  sous un utilisateur système dédié avec Node 24, sans interférer avec PM2/nginx existants.
- Risque : contention RAM avec les processus existants (sokar/goldbot consomment déjà ~1,4-1,9 GiB).
  Prévoir un healthcheck mémoire et un restart policy.

## 2. Architecture de déploiement recommandée

Recommandation (justifications succinctes) :

- Next.js Web : Vercel (inchangé vs ADR-005).
- PostgreSQL/PostGIS : Neon EU (région `aws-eu-central-1` Frankfurt, inchangé vs ADR-005).
- Worker Node 24 : VPS DigitalOcean Frankfurt (FRA1), coût marginal 0 €.
- Stockage objet : fournisseur S3-compatible européen (recommandation section 4).
- Email transactionnel : fournisseur externe (recommandation section 5).
- Stripe : inchangé.

Pourquoi on ne déplace PAS Web ni PostgreSQL sur le VPS :

- Vercel reste l'hébergement natif Next.js (App Router, Server Components, Edge/Node runtimes) —
  ADR-005 verrouillé.
- Neon fournit PostgreSQL managé + PostGIS + branching + autoscaling, région `aws-eu-central-1`
  confirmée — ADR-005 verrouillé.
- Déplacer le Web ou PostgreSQL sur le VPS apporterait une charge opérationnelle (TLS, backups,
  monitoring, mises à jour, PostGIS) sans bénéfice démontré, et violerait ADR-005 sans ADR de
  remplacement.
- Le worker est le seul composant que l'ADR-005 laisse explicitement ouvert (« sera déployé
  séparément, Lot 4+ »).

Flux réseau (numéroté 1→6) :

1. Web Vercel écrit dans Neon (outbox + tables métier) via Server Actions/Route Handlers.
2. Worker VPS Frankfurt se connecte à Neon (`aws-eu-central-1`) avec TLS (`sslmode=require` ou
   équivalent Drizzle/postgres).
3. Worker lit l'outbox, génère les documents (PDF).
4. Worker écrit les objets dans le stockage S3-compatible (putIfAbsent conditionnel).
5. Worker envoie l'email transactionnel via le fournisseur (clé d'idempotence fournisseur).
6. Worker persiste les résultats (providerMessageId, storageKey, statuts) dans Neon.

Analyse opérationnelle :

- Latence Frankfurt ↔ région Neon : les deux sont à Frankfurt (VPS FRA1, Neon
  `aws-eu-central-1`), latence intra-région attendue < 5 ms. À vérifier empiriquement avant
  production.
- Connexions PostgreSQL longues : le worker maintient une connexion persistante ; préférer un pool
  petit (1-3 connexions) avec keepalive et reconnect. Neon supporte les connexions persistantes ;
  surveiller les limites de connexions du plan.
- Pooling : Neon fournit PgBouncer (pooler serverless) ; le worker peut l'utiliser ou se connecter
  direct selon la charge.
- Restrictions IP : Neon IP Allow Rules est disponible sur le plan **Scale** (et au-dessus), **pas
  sur Launch/Free** (source : https://neon.tech/docs/introduction/extra-usage, 2026-08-05). Vercel
  utilise par défaut des IP sortantes **dynamiques** (source :
  https://vercel.com/kb/guide/how-to-allowlist-deployment-ip-address, 2026-08-05) ; les Vercel
  Static IPs sont un add-on Pro à **100 $/projet/mois** (Secure Compute est Enterprise, sur devis)
  — source : https://vercel.com/docs/networking/static-ips, 2026-08-05. Voir section 7 pour les
  deux architectures réseau.
- TLS : obligatoire (`sslmode=require` minimum, idéalement `verify-full` avec root CA Neon).
- Redémarrage automatique : Docker `restart: unless-stopped` ou systemd `Restart=on-failure` avec
  backoff.
- Healthcheck : **aucun serveur HTTP `/healthz` n'est actuellement implémenté dans le worker**.
  Pour le premier déploiement, utiliser un healthcheck de processus/conteneur (Docker `HEALTHCHECK`
  basé sur la présence du processus, ou systemd `Type=notify`/`ExecStartPost`) ; un signal de
  progression du dernier cycle (fichier borne local ou mécanisme à concevoir) ; une alerte sur
  redémarrages répétés et absence de cycles. Un véritable endpoint `/healthz` est un **lot
  d'implémentation futur**, pas une capacité existante.
- Journalisation : stdout JSON (déjà en place via `ConsoleWorkerLogger`), collecté par journald ou
  Docker logging driver avec rotation (`journald` `SystemMaxUse=500M` ou `json-file` `max-size=10m
  max-file=5`).
- Rotation des logs : journald rotation native OU Docker `json-file` avec limites.
- Sauvegardes : Neon gère les backups PostgreSQL (PITR sur plans payants) ; la config du worker
  (compose/systemd, env) doit être versionnée dans un dépôt privé ou un secret manager — pas dans
  le dépôt Git.
- Supervision : alerte sur redémarrages et absence de cycles (via logs JSON existants
  `ConsoleWorkerLogger` + un uptime checker externe sur la machine, pas sur une route HTTP
  inexistante). Un endpoint `/metrics` Prometheus et un vrai collecteur de métriques production
  sont un **lot d'implémentation futur**.
- Coût du VPS : déjà payé, coût marginal 0 €. Prix catalogue d'un droplet équivalent à Frankfurt :
  ~6-12 $/mois (1-2 GiB, 1 vCPU) ou ~18-24 $/mois (2 vCPU, 2-4 GiB) — référence DigitalOcean
  pricing 2026-08-05, ne pas consulter de donnée de facturation.

## 3. Comparaison du stockage objet

Tableau comparatif des trois fournisseurs (DigitalOcean Spaces, Cloudflare R2, AWS S3
eu-central-1).

| Critère | DigitalOcean Spaces | Cloudflare R2 | AWS S3 (eu-central-1) |
| --- | --- | --- | --- |
| Région européenne | FRA1 Frankfurt + AMS3 Amsterdam | Juridiction UE (placement physique Frankfurt non garanti — caveat) | eu-central-1 Frankfurt |
| Compatibilité S3 | Partielle | Quasi-complète | Native |
| Chiffrement au repos | AES-256 par défaut (KMS: non) | AES-256 par défaut (KMS: non / SSE-C) | AES-256 par défaut (SSE-KMS oui) |
| Chiffrement en transit | TLS | TLS | TLS |
| Contrôle d'accès privé | Bucket policies API + ACL | API tokens + Cloudflare Access (pas de bucket policies ni ACL) | IAM + bucket policies + Block Public Access |
| URLs signées | Oui, expiry jusqu'à 7 jours (SigV2/V4) | Oui, expiry jusqu'à 7 jours (SigV4) | Oui, expiry jusqu'à 7 jours (SigV4) |
| putIfAbsent atomique (CRITIQUE) | NON documenté pour PUT (If-None-Match seulement GET/HEAD) — risque de race | OUI via `If-None-Match: *` (412 PreconditionFailed) | OUI via `If-None-Match: *` (412 ou 409 ConditionalRequestConflict) |
| HEAD métadonnées | Oui (contentType, sizeBytes, ETag, métadonnées custom) | Oui (contentType, sizeBytes, ETag, métadonnées custom) | Oui (contentType, sizeBytes, ETag, métadonnées custom) |
| Checksum SHA-256 stocké + récupérable | Non documenté | Oui | Oui (ChecksumAlgorithm SHA256) |
| Lifecycle/rétention | Oui (expiration, pas tag-based) | Oui (expiration + transition IA, max 1000 règles) | Oui (complet) |
| Versioning | Oui (API) | NON (dummy implementations) | Oui (complet) |
| Coûts fixes | 5 $/mois (inclut 250 Go + 1 To egress) | 0 $ fixe (free tier 10 Go + 1M Class A + 10M Class B) | 0 $ fixe (free tier 5 Go + 2000 PUT + 20000 GET) |
| Stockage inclus | 250 Go | 10 Go | 5 Go |
| Requêtes | Illimitées dans le forfait | 4,50 $/M Class A + 0,36 $/M Class B | 0,005 $/1000 PUT + 0,0004 $/1000 GET |
| Trafic sortant | 1 To inclus puis 0,01 $/Go | GRATUIT | 100 Go inclus puis 0,09 $/Go |
| Coût MVP estimé (5 Go, 10k PUT, 50k GET, 2 Go egress) | 5 $/mois | 0 $/mois (free tier) | ~0,07 $/mois |
| Complexité d'exploitation | Faible | Modérée (tokens, pas de bucket policies) | Élevée (IAM, VPC) |
| RGPD/DPA | DPA inclus (ToS) | DPA Cloudflare v6.4 (effective 2026-04-03, SCC + DPF) | DPA AWS inclus (Service Terms, SCC) |

Recommandation : **Cloudflare R2** comme choix principal.

Raisons précises :

1. putIfAbsent atomique supporté (`If-None-Match: *`, 412) — exigence critique du port
   `ObjectStorage`.
2. Egress gratuit — avantage majeur pour un workflow de documents (téléchargements clients).
3. Free tier couvre largement le MVP (10 Go + 1M PUT + 10M GET).
4. SHA-256 checksum stocké et récupérable.
5. DPA RGPD disponible (juridiction EU).

Alternative : **AWS S3 eu-central-1** — putIfAbsent atomique natif, checksums complets, versioning,
DPA inclus. Inconvénient : egress 0,09 $/Go et complexité IAM plus élevée.

Non recommandé : **DigitalOcean Spaces** — putIfAbsent non documenté pour PUT (risque de race
condition), checksum SHA-256 stocké/récupérable non documenté. À n'utiliser que si l'on accepte
d'implémenter un verrou applicatif (HEAD+PUT race) — non acceptable pour l'idempotence document.

Caveats à appliquer (issus du critic review) :

- R2 : « juridiction EU » garantie conformité, mais la doc officielle ne garantit pas un placement
  physique à Frankfurt. Formuler comme « juridiction UE / conformité résidence données UE » sans
  affirmer « données physiquement à Frankfurt ».
- R2 : la doc officielle confirme le support de `If-None-Match` pour PutObject (412
  PreconditionFailed) ; ne pas affirmer « strong consistency » comme terme officiel — dire
  « opération conditionnelle atomique » et citer la doc.

Limites/adaptations du port `ObjectStorage` :

- Le port n'expose pas de méthode `signedUrl` (« politique de téléchargement et durée des URLs
  signées », question ouverte — `open-questions.md` ne numérote pas cette question ; utiliser le
  libellé exact) — si les téléchargements clients doivent passer par URL signée, il faudra
  étendre le port (décision produit à prendre).
- R2 ne supporte pas le versioning natif — si l'on veut un historique de versions document,
  utiliser un schéma de clés versionnées (préfixe ou suffixe) côté application.
- L'adapter R2 utilisera `@aws-sdk/client-s3` avec `endpoint` =
  `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (ou endpoint EU) et `region: 'auto'`.

## 4. Comparaison de l'email transactionnel

Tableau comparatif Resend / Postmark / Amazon SES.

| Critère | Resend | Postmark | Amazon SES |
| --- | --- | --- | --- |
| Idempotence clé fournisseur (CRITIQUE Q14) | OUI, GA. Header `Idempotency-Key` ou champ SDK `idempotencyKey`. Rétention 24 h. Même clé + même payload → même email id, pas de renvoi. Même clé + payload différent → 409 `invalid_idempotent_request`. | NON. Déclaration officielle : « Postmark does not currently support an idempotency key feature. » | NON. SendEmail API n'expose aucune clé d'idempotence ; philosophie at-least-once. |
| Message id retourné | Oui (email id) | Oui (MessageID) | Oui (MessageId) |
| Retries/timeouts | Webhook retries backoff exponentiel (5s→10h) | 10 tentatives sur ~10,5 h | Retry built-in configurable |
| Rate limits | 10 req/s par team (ajustable) | Non documenté par seconde (SMTP 10 connexions concurrentes) | Sandbox 1/s 200/jour, production ajustable |
| SPF/DKIM/DMARC | Oui (DKIM 1024-bit) | Oui (DKIM custom) | Oui (Easy DKIM 2048-bit) |
| Webhooks délivrabilité | delivered, bounced, opened, clicked, complained, svix-id dedup | Delivery, Bounce, Open, Click, Spam Complaint | Send, Reject, Bounce, Complaint, Delivery, Open, Click via CloudWatch/SNS/EventBridge |
| Localisation données | États-Unis (DPF certified, SCC) | États-Unis (Chicago + AWS, SCC) | Régions EU disponibles (eu-central-1 Frankfurt, etc.) |
| DPA/RGPD | DPA pré-signé (https://resend.com/legal/dpa) | DPA (SCC) | DPA AWS inclus |
| Coût 1 000 emails/mois | 0 $ (Free si ≤ 100/jour et ≤ 3 000/mois) ; 0,90 $/1 000 en dépassement sur forfait payant | 1,80 $ | 0,10 $ (Essentials) + 0,12 $/Go pièces jointes |
| Coût 10 000 emails/mois | 20 $/mois (forfait Pro, 50 000 inclus) — pas de tarif à la carte à 9 $ | 15 $ (forfait inclus) | 1 $ |
| Coût 50 000 emails/mois | 20 $/mois (forfait Pro, 50 000 inclus) | 55 $ | 5 $ |
| SDK Node officiel | `resend` (officiel maintenu) | `postmark` (officiel) | `@aws-sdk/client-ses` (officiel AWS v3) |
| Complexité opérationnelle | Faible (pas de sandbox, DNS records, pas de warmup shared IP) | Modérée (sandbox disponible, Sender Signature/Domain) | Élevée (sandbox obligatoire, demande production access, warmup IP dédiées 24,95 $/IP/mois) |

> Note Resend : le tarif de 0,90 $/1 000 correspond aux **dépassements activés sur un forfait payant**
> (Pro/Scale), pas à un tarif à la carte permettant de payer seulement 9 $ pour 10 000 emails. Pour
> dépasser 3 000 emails/mois, un forfait payant est requis (source :
> https://resend.com/docs/knowledge-base/account-quotas-and-limits, 2026-08-05).

### Vérification Q14 (bloquante)

Verdict exact :

- **Resend** : compatible nativement avec Q14 **dans sa fenêtre d'idempotence de 24 h**. La clé
  `providerIdempotencyKey` du port `TransactionalEmailSender` se mappe au header `Idempotency-Key`
  (ou champ SDK `idempotencyKey`). Sémantique vérifiée (source :
  https://resend.com/docs/dashboard/emails/idempotency-keys, 2026-08-05) :
  - Même clé + même payload pendant 24 h : même réponse (même email id), aucun nouvel email envoyé.
  - Même clé + payload différent : HTTP 409 `invalid_idempotent_request`.
  - Requêtes concurrentes avec la même clé : HTTP 409 `concurrent_idempotent_requests` (temporaire,
    retry ultérieur sûr).
  - Après expiration des 24 h, la documentation officielle ne garantit plus la déduplication. Une
    panne du worker entre l'acceptation par Resend et le commit DB du `providerMessageId`, si elle
    dure plus de 24 h, peut donc provoquer un double email au redémarrage.
- **Postmark** : NON COMPATIBLE nativement. Aucune clé d'idempotence fournisseur.
- **Amazon SES** : NON COMPATIBLE nativement. Aucune clé d'idempotence fournisseur.

Comparaison avec le backoff Uttily : `MAX_ATTEMPTS = 5`, backoff exponentiel 30 s → 480 s
(`packages/core/src/outbox-claim/scheduling.ts`). En fonctionnement normal, les 5 tentatives
s'achèvent en ~15 min, bien sous 24 h. Le risque n'apparaît qu'en cas d'**indisponibilité prolongée
du worker** (> 24 h) — panne VPS, OOM, dépendance bloquée — entre l'acceptation Resend et le commit
DB.

Trois politiques possibles :

- **A. Retry automatique strictement limité à < 24 h, puis fail-closed et intervention manuelle.**
  Au-delà de la fenêtre d'idempotence Resend, le worker ne retraite plus automatiquement les emails
  dont le `providerMessageId` n'est pas persisté ; ils passent en état requiring-manual-review et un
  humain décide.
- **B. Accepter explicitement le faible risque de doublon après une panne > 24 h.** Le worker
  retrait automatiquement ; un doublon est possible et doit être détecté/réconcilié a posteriori.
- **C. Réconciliation fournisseur a posteriori.** Ajouter ultérieurement une réconciliation si
  Resend expose une recherche fiable par clé d'idempotence ou métadonnée. **Ne pas affirmer que
  cette API existe** : aucune source officielle ne documente une telle recherche au 2026-08-05. À
  étudier uniquement si Resend publie cette capacité.

Recommandation : **option A** pour les emails contenant des documents contractuels (factures, reçus,
contrats), afin de garantir l'absence de double envoi automatique au-delà de la fenêtre de 24 h.

Stratégie de repli documentée (si le porteur produit refuse Resend) :

- Pour Postmark/SES, il faudrait implémenter une idempotence DB-side : table
  `email_idempotency(provider_idempotency_key PK, provider_message_id, status, created_at,
  updated_at)` avec check avant envoi et persistance du message id après succès.
- **Rappel explicite** : l'idempotence DB seule NE GARANTIT PAS l'absence de double email après un
  crash survenant entre l'acceptation par le fournisseur et le commit DB du message id. C'est une
  limitation fondamentale que le porteur produit doit accepter explicitement.

Recommandation fournisseur : **Resend** (compatible Q14 nativement dans sa fenêtre de 24 h, GA, DPA
RGPD, SDK Node officiel, coût compétitif).

Alternative : **Amazon SES** (résidence EU, coût le plus bas à grande échelle) — MAIS incompatible
Q14 nativement, nécessite l'idempotence DB-side avec le risque de double email documenté ci-dessus.

Modifications nécessaires :

- Avec Resend : aucune modification du port `TransactionalEmailSender` ; l'adapter Resend passe
  `providerIdempotencyKey` dans le header `Idempotency-Key` et retourne le `providerMessageId`
  (email id). En revanche, la **politique de retry du worker** doit être bornée à < 24 h pour les
  emails, avec transition fail-closed au-delà — c'est une adaptation du pipeline/worker à valider
  par ADR.
- Avec Postmark/SES : modifications du port et du pipeline (check DB pré-envoi, persistance
  post-envoi, table `email_idempotency`, gestion des orphelins) — décision structurelle à valider
  par ADR.

## 5. Vérification Q14 (synthèse)

- Q14 : « Exigence d'idempotence du fournisseur email » — critère bloquant.
- **Verdict final** : Resend est le seul fournisseur étudié compatible nativement avec Q14 dans sa
  fenêtre d'idempotence de 24 h. Une politique fail-closed est nécessaire au-delà de cette fenêtre
  pour garantir l'absence de double envoi automatique.
- Postmark et SES ne supportent pas l'idempotence clé fournisseur — nécessiteraient une idempotence
  DB-side avec risque résiduel de double email post-crash.
- Q14 n'est pas fermée : la politique de retry/fail-closed (option A recommandée) doit être validée
  explicitement par le porteur produit avant de clore Q14.

## 6. Estimation des coûts

Trois scénarios mensuels (USD, tarifs officiels 2026-08-05).

> Avertissement : Tous les prix sont en USD, issus des pages officielles consultées le 2026-08-05.
> Le VPS existant a un coût marginal 0 € ; son prix catalogue est indiqué pour référence sans
> consultation de donnée de facturation.

> Note VPS : le VPS existant a un **coût marginal 0 €** (ressources déjà allouées et déjà payées).
> Son **coût réel déjà payé** n'est pas consulté ici (aucune donnée de facturation lue) ; son prix
> catalogue est indiqué pour référence uniquement.

### Scénario A — Dev/Staging

| Composant | Coût |
| --- | --- |
| Vercel Hobby | 0 $ (100 Go Fast Data Transfer, 1M invocations inclus) |
| Neon Free | 0 $ (100 CU-h/projet, 0,5 Go stockage) |
| VPS existant | 0 $ (marginal) |
| Stockage R2 | 0 $ (free tier 10 Go) |
| Email Resend Free | 0 $ (3 000 emails/mo, 100/jour) |
| **Total** | **0 $/mois** |

> Note : Vercel Hobby n'est pas adapté à une exploitation commerciale. Pour un MVP commercial,
> utiliser au minimum Vercel Pro (scénario B).

### Scénario B — Petit MVP

| Composant | Coût |
| --- | --- |
| Vercel Pro | 20 $/mois (+20 $ usage credit inclus) |
| Neon Launch | ~15 $/mois (≈100 CU-h × 0,106 $ + 20 Go × 0,35 $/Go = 10,60 $ + 7 $ ≈ 17,60 $ ; arrondir ~15-18 $) |
| VPS existant | 0 $ (marginal) ; référence catalogue ~12-18 $/mois pour un droplet 2 GiB/1-2 vCPU à FRA1 |
| Stockage R2 | 0 $ (free tier couvre 5 Go + ops modestes) |
| Email Resend | 0 $ (Free ≤ 3 000, limite 100/jour) ou 20 $/mois (forfait Pro, 50 000 inclus) pour un MVP commercial |
| Monitoring | 0 $ (UptimeRobot gratuit / Vercel inclus) |
| **Total** | **~35-38 $/mois** (Free) ou **~55-58 $/mois** (Resend Pro) |

NOTE : utiliser 0,35 $/Go pour le stockage Neon (corrigé par critic review, pas 0,15 $).

> Calcul : Vercel Pro 20 $ + Neon Launch 15-18 $ + VPS 0 $ + R2 0 $ + Resend Free 0 $ = 35-38 $/mois ;
> même calcul + Resend Pro 20 $ = 55-58 $/mois.

### Scénario C — Croissance initiale

| Composant | Coût |
| --- | --- |
| Vercel Pro | 20-40 $/mois (selon usage fonctions) |
| Neon Scale | ~50-75 $/mois (≈300 CU-h × 0,222 $ + 50 Go × 0,35 $/Go = 66,60 $ + 17,50 $ ≈ 84 $ ; arrondir ~50-85 $ selon autoscaling) |
| VPS existant | 0 $ (marginal) |
| Stockage R2 | ~0,75 $/mois (50 Go × 0,015 $, ops dans free tier) |
| Email Resend Pro | 20 $/mois (50 000 emails inclus) |
| **Total** | **~91-146 $/mois** |

> Calcul : min 20 + 50 + 0 + 0,75 + 20 = 90,75 $ (arrondi 91 $) ; max 40 + 85 + 0 + 0,75 + 20 =
> 145,75 $ (arrondi 146 $).

Principaux coûts variables :

- Neon compute (CU-hours) — principal levier de coût.
- Neon stockage (0,35 $/Go-mois).
- Volume email (paliers Resend).
- Vercel function execution (au-delà du credit Pro).
- Egress stockage (nul avec R2 ; 0,09 $/Go avec S3).

> Note : ces estimations Neon sont illustratives et excluent les taxes ainsi que les éventuels coûts
> variables de history storage/instant restore et de transfert dépassant les quotas inclus. Le
> compute réel dépendra des CU-heures effectivement consommées.

### Scénario D — Sécurité réseau renforcée

| Composant | Coût |
| --- | --- |
| Vercel Pro | 20 $/mois |
| Vercel Static IPs (add-on Pro) | 100 $/projet/mois |
| Neon Scale (avec IP Allow Rules) | ~50-85 $/mois (selon usage) |
| VPS existant | 0 $ (marginal) |
| Stockage R2 | ~0,75 $/mois (50 Go) |
| Email Resend Pro | 20 $/mois (50 000 inclus) |
| **Total** | **~191-226 $/mois** |

> Calcul : min 20 + 100 + 50 + 0 + 0,75 + 20 = 190,75 $ (arrondi 191 $) ; max 20 + 100 + 85 + 0 +
> 0,75 + 20 = 225,75 $ (arrondi 226 $).

> Note : ce scénario ne se mélange pas avec le petit MVP à 35-38 $/mois. Il correspond à une exigence
> de sécurité réseau renforcée (IP Allow Rules côté Neon, IP sortantes fixes côté Vercel). Voir
> section 7 pour les deux architectures réseau.

## 7. Plan de sécurité et d'exploitation du VPS

Propositions (à valider, NON appliquées) :

- Utilisateur système dédié `uttily-worker` (pas root, pas l'utilisateur `deploy` partagé avec
  sokar/goldbot).
- Exécution : recommander **Docker Compose** (voir comparaison ci-dessous).
- Politique de redémarrage : `restart: unless-stopped` (Docker) ou `Restart=on-failure` avec
  `RestartSec=5s` (systemd).
- Secrets hors dépôt : variables d'environnement injectées via un fichier `.env` propriétaire
  `uttily-worker` (chmod 600, owner uttily-worker), jamais dans le dépôt Git. Idéalement un secret
  manager (Doppler, Infisical, ou Vault) à terme.
- Permissions minimales : l'utilisateur `uttily-worker` ne peut lire que ses propres fichiers ; pas
  d'accès aux autres projets.
- **Connexion Neon TLS** : `sslmode=verify-full` avec root CA Neon si compatible avec le driver
  `postgres`/Drizzle ; sinon `sslmode=require` minimum.

Deux architectures réseau (à valider, NON appliquées) :

#### MVP économique — recommandé

- Neon **Launch** (sans IP Allow Rules — non disponible sur ce plan).
- Accès public TLS (`sslmode=require` ou `verify-full`).
- Mot de passe PostgreSQL à forte entropie.
- Rôles DB séparés pour Web, worker et migrations (privilèges minimaux par rôle).
- Rotation des credentials.
- **Pas d'IP allowlist** sur Neon Launch.

#### Production renforcée

- Neon **Scale** avec IP Allow Rules activées.
- IP fixe du VPS (`<VPS-Frankfurt-IP>`) autorisée dans l'allowlist Neon.
- Vercel Static IPs à **100 $/projet/mois** (add-on Pro), ou autre architecture réseau (proxy
  egress, Vercel Secure Compute Enterprise) explicitement décidée.
- Recalcul du coût total : voir scénario D (~191-226 $/mois).
- Accès S3 privé : credentials R2/S3 stockés en env, bucket privé, pas d'accès public ;
  téléchargements via URL signées (extension port à décider — politique de
  téléchargement et durée des URLs signées, question ouverte).
- Limitation trafic sortant : Neon, Cloudflare R2 et Resend utilisent des infrastructures/IP
  **potentiellement dynamiques**. Ne pas proposer une allowlist d'IP sortantes fragiles sans proxy
  egress ou solution DNS-aware. Pour le premier déploiement, autoriser le trafic sortant 443/TCP
  vers les résolutions DNS des endpoints Neon/R2/Resend (ou via un proxy egress si une restriction
  stricte est exigée) — à concevoir dans un lot sécurité futur.
- Logs : `journald` (rotation native, `SystemMaxUse=500M`) ou Docker `json-file` (`max-size=10m`,
  `max-file=5`). Le worker émet déjà du JSON sans PII (`ConsoleWorkerLogger`).
- Healthcheck : **aucun endpoint `/healthz` n'existe actuellement**. Pour le premier déploiement :
  healthcheck de processus/conteneur (Docker `HEALTHCHECK` sur la présence du processus, ou systemd
  `Type=notify`), signal de progression du dernier cycle via un fichier ou mécanisme local borné (à
  concevoir), alerte sur redémarrages et absence de cycles. Ne pas configurer Docker HEALTHCHECK
  pour appeler une route HTTP inexistante.
- Métriques : **`InMemoryMetricsCollector` est réservé aux tests/harness, pas à la production**
  (source : `apps/worker/src/metrics.ts` — « NE PAS utiliser en production »). Aucun endpoint
  `/metrics` n'est implémenté. Un adaptateur de métriques production (Prometheus ou équivalent)
  reste à implémenter dans un lot futur. Pour le premier déploiement, s'appuyer sur les logs JSON
  existants et l'alerte sur redémarrages/absence de cycles.
- Alertes : alerte sur redémarrages répétés du conteneur et absence de cycles (détectée via logs
  JSON existants `ConsoleWorkerLogger` + un uptime checker externe sur la **machine hôte**, pas sur
  une route HTTP inexistante). Un véritable endpoint `/healthz` et un système d'alerte basé sur HTTP
  sont un **lot d'implémentation futur**.
- Mises à jour : `unattended-upgrades` déjà actif sur les deux VPS (sécurité) ; ne pas appliquer
  manuellement.
- Sauvegarde de la configuration : versionner `docker-compose.worker.yml` et
  `systemd/uttily-worker.service` dans un dépôt privé (pas dans le dépôt public Uttily) ; secrets à
  part.
- Procédure de rollback : garder l'image Docker N-1 taguée ; `docker compose up -d --no-deps
  uttily-worker` avec la version précédente ; le worker est idempotent (outbox), un rollback
  n'entraîne pas de perte d'effets.
- Déploiement sans interruption : pour un seul worker, un redémarrage court (graceful shutdown
  SIGTERM déjà implémenté) est acceptable ; pas de blue/green nécessaire au MVP.

Comparaison Docker Compose vs systemd :

| Critère | Docker Compose | systemd |
| --- | --- | --- |
| Isolation | Forte (conteneur, réseau, fs) | Faible (processus hôte) |
| Runtime Node 24 isolé | Oui (image node:24) | Non (nvm sur l'hôte, conflit avec Node 22 existant) |
| Gestion secrets | Env file / secrets Docker | Environment file systemd |
| Logs | Docker driver (json-file/journald) | journald natif |
| Healthcheck | HEALTHCHECK natif | ExecStartPost / scripts |
| Redémarrage | restart: unless-stopped | Restart=on-failure |
| Complexité | Modérée (Docker déjà installé) | Faible mais risque de conflit Node |
| Rollback | Image taguée N-1 | Binaire N-1 |

Recommandation : **Docker Compose** — isolation du runtime Node 24 (sans casser Node 22 existant
pour sokar/goldbot), healthcheck natif, rollback par image taguée. Docker est déjà installé sur les
deux VPS.

## 8. Recommandation finale

Synthèse :

- Web : **Vercel Pro** pour le MVP commercial (Hobby réservé au dev/staging).
- DB : **Neon Launch** sans IP allowlist au début (IP Allow Rules nécessite Scale).
- Worker : **VPS `sokar`**, Docker Compose, Node 24, avec limites CPU/RAM explicites.
- Stockage : **Cloudflare R2** avec bucket de juridiction `eu`, privé (ne pas promettre Frankfurt).
- Email : **Resend** avec politique de retry automatique **< 24 h** et **fail-closed** au-delà
  (option A).
- Secrets : fichier dédié chmod 600 pour le premier déploiement, jamais dans Git.
- Téléchargement : bucket privé ; décision ultérieure entre URL signée courte et streaming
  authentifié.
- Versioning : clés applicatives immuables/versionnées, pas de dépendance au bucket versioning (R2 ne
  supporte pas le versioning natif).

Ces éléments restent des recommandations jusqu'à approbation explicite du porteur produit.

Coût mensuel total estimé :

- Dev/staging : 0 $.
- Petit MVP (économique) : ~35-38 $ (Free) ou ~55-58 $ (Resend Pro).
- Croissance initiale : ~91-146 $.
- Sécurité réseau renforcée : ~191-226 $.

## 9. Décisions que le porteur produit doit encore approuver

1. Valider Resend comme fournisseur email **et valider la politique de retry/fail-closed < 24 h
   (option A)** pour les emails contractuels. Q14 n'est fermée qu'après validation explicite de
   cette politique.
2. Valider Cloudflare R2 comme stockage objet (juridiction UE, pas de placement physique Frankfurt
   garanti) OU préférer AWS S3 eu-central-1 (placement physique Frankfurt, egress payant).
3. Choisir le VPS cible (`sokar` vs `pmbtc`) et confirmer que la cohabitation avec sokar/goldbot est
   acceptable (contention RAM).
4. Confirmer l'usage de Docker Compose (vs systemd) pour le worker.
5. Décider si le port `ObjectStorage` doit être étendu avec une méthode `signedUrl` (« politique de
   téléchargement et durée des URLs signées » (question ouverte)) pour les téléchargements clients.
6. Décider si le versioning des documents est requis (R2 ne le supporte pas nativement → schéma de
   clés applicatif).
7. Choisir entre MVP économique (Neon Launch, pas d'IP allowlist, accès public TLS, rôles DB
   séparés) et production renforcée (Neon Scale + IP Allow Rules + Vercel Static IPs 100
   $/projet/mois).
8. Décider du secret manager (fichier .env chmod 600 court terme, Doppler/Infisical/Vault à terme).
9. Aucune modification d'ADR-005 ou ADR-013 n'est faite dans cette phase ; un ADR de remplacement
   sera nécessaire si le porteur produit valide un fournisseur de stockage/email (clore Q6, Q7, Q14)
   ou déplace un composant.

## 10. Sources officielles (consultées le 2026-08-05)

Vercel :

- https://vercel.com/pricing
- https://vercel.com/docs/regions
- https://vercel.com/docs/pricing/regional-pricing/fra1
- https://vercel.com/docs/networking/static-ips
- https://vercel.com/kb/guide/how-to-allowlist-deployment-ip-address

Neon :

- https://neon.tech/docs/introduction/extra-usage
- https://neon.com/docs/introduction/regions
- https://neon.com/docs/extensions/postgis

DigitalOcean Droplets :

- https://www.digitalocean.com/pricing/droplets
- https://docs.digitalocean.com/products/droplets/details/availability/

DigitalOcean Spaces :

- https://docs.digitalocean.com/products/spaces/details/pricing/
- https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/
- https://docs.digitalocean.com/reference/api/spaces-api/
- https://www.digitalocean.com/legal/data-processing-agreement

Cloudflare R2 :

- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/r2/api/s3/api/
- https://developers.cloudflare.com/r2/api/s3/extensions/
- https://developers.cloudflare.com/r2/reference/data-location/
- https://developers.cloudflare.com/r2/reference/data-security/
- https://developers.cloudflare.com/r2/api/tokens/
- https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- https://www.cloudflare.com/cloudflare-customer-dpa/

AWS S3 :

- https://aws.amazon.com/s3/pricing
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html
- https://docs.aws.amazon.com/whitepapers/latest/navigating-gdpr-compliance/aws-data-processing-addendum-dpa.html

Resend :

- https://resend.com/docs/dashboard/emails/idempotency-keys
- https://resend.com/pricing
- https://resend.com/docs/knowledge-base/account-quotas-and-limits
- https://resend.com/docs/add-a-domain
- https://resend.com/docs/webhooks
- https://resend.com/security/gdpr
- https://resend.com/legal/dpa
- https://resend.com/docs/send-with-nodejs

Postmark :

- https://postmarkapp.com/support/article/what-is-an-idempotency-key
- https://postmarkapp.com/pricing
- https://postmarkapp.com/developer/webhooks/webhooks-overview
- https://postmarkapp.com/dpa
- https://postmarkapp.com/eu-privacy

Amazon SES :

- https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
- https://aws.amazon.com/ses/pricing/
- https://docs.aws.amazon.com/ses/latest/dg/quotas.html
- https://docs.aws.amazon.com/general/latest/gr/ses.html
- https://docs.aws.amazon.com/ses/latest/dg/monitor-using-event-publishing.html
