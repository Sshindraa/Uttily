# ADR-014 — Fournisseurs de production et déploiement du worker

- **Statut** : Accepté
- **Date** : 2026-08-05
- **Décideurs** : Porteur produit Uttily, équipe engineering
- **Relie à** : ADR-005, ADR-013
- **Clôture** : ADR-013 questions 6, 7 et 14

## 1. Contexte

L'ADR-005 a verrouillé l'hébergement Web sur Vercel et la base PostgreSQL sur Neon en région
européenne. L'ADR-013 a défini l'architecture des documents transactionnels (outbox, pipelines,
worker provider-neutral) et a laissé ouvertes les questions 6 (fournisseur de stockage objet), 7
(fournisseur d'email transactionnel) et 14 (exigence d'idempotence du fournisseur email).

La phase G5G-A a produit une évaluation préparatoire
(`docs/implementation/g5g-provider-and-vps-assessment.md`) auditant le VPS DigitalOcean Frankfurt,
comparant les fournisseurs de stockage objet et d'email transactionnel, et estimant les coûts. Le
porteur produit a validé les décisions suivantes, enregistrées dans le présent ADR.

**Périmètre de cet ADR** : décision d'architecture et de documentation uniquement. Aucun SDK, aucun
adapter R2 ou Resend, aucun changement de port TypeScript, aucun changement du worker, aucun
Dockerfile ou fichier Compose, aucun changement de schéma ou migration, aucun test métier, aucun
déploiement, aucun compte fournisseur créé ou modifié. Les adapters de production restent non
implémentés après cet ADR ; ils seront livrés dans des lots ultérieurs avec tests.

## 2. Décisions

### 2.1 Web

- **Vercel Pro** pour le MVP commercial.
- Vercel Hobby uniquement pour le développement ou les essais non commerciaux.
- ADR-005 reste applicable et n'est pas remplacée.

### 2.2 Base de données

- **Neon Launch** pour le MVP économique.
- Région européenne compatible avec l'architecture existante (`aws-eu-central-1`).
- Accès public protégé par TLS, credentials PostgreSQL à forte entropie, rôles PostgreSQL séparés
  pour Web, worker et migrations (privilèges minimaux par rôle).
- **Pas d'IP Allow Rules au MVP** : cette fonction nécessite Neon Scale.
- Neon Scale + Vercel Static IPs est **reporté** à un renforcement futur justifié par le risque ou
  la charge (voir section 9).
- **Deux connexions distinctes (G5G-C)** :
  - `DATABASE_URL` : endpoint **pooled** (hostname avec `-pooler`), utilisé par
    l'application Web et le worker en runtime distant.
  - `DATABASE_DIRECT_URL` : endpoint **direct** (hostname sans `-pooler`),
    réservé aux migrations Drizzle Kit et opérations administratives explicites.
  - Les tests unitaires n'utilisent aucune base. Les tests d'intégration
    PostgreSQL destructifs utilisent uniquement PostgreSQL local (garde-fou
    `assertLocalhost` rejette toute URL distante dans `DATABASE_URL`).
  - Le helper `resolveMigrationUrl` (`packages/database/src/resolve-migration-url.ts`)
    applique un garde-fou fail-closed : une `DATABASE_URL` distante sans
    `DATABASE_DIRECT_URL` est rejetée, et une `DATABASE_DIRECT_URL` contenant
    `-pooler` est rejetée. Voir `docs/implementation/environments.md`.
- **Environnement de développement actuel** : projet Neon `Uttily-dev` (plan
  Free, `aws-eu-central-1`, PostgreSQL 16). PostgreSQL local (Docker Compose)
  reste la cible des tests d'intégration destructifs. La base Neon Dev ne
  contient pas encore le schéma Uttily ; les migrations seront appliquées dans
  une étape séparée après configuration manuelle des secrets.

### 2.3 Worker

- Hébergement sur le VPS DigitalOcean Frankfurt identifié par l'alias `sokar`.
- La cohabitation avec les workloads existants (sokar/goldbot) est acceptée pour le MVP.
- Exécution dans un conteneur **Node.js 24** avec Docker Compose.
- Des limites CPU et mémoire explicites devront être définies et validées pendant le lot de
  déploiement, à partir des ressources réellement disponibles sur `sokar`.
- Aucun changement du runtime Node.js 22 utilisé directement sur l'hôte par les autres projets.
- **Aucun endpoint `/healthz` ou `/metrics` n'est présenté comme existant** : ces endpoints ne sont
  pas implémentés dans le worker actuel.
- Le premier déploiement s'appuiera sur les logs JSON existants (`ConsoleWorkerLogger`), l'état du
  processus, les redémarrages et l'absence de cycles détectée depuis les logs. Un endpoint
  `/healthz`, un endpoint `/metrics` Prometheus et un vrai collecteur de métriques production sont
  un lot d'implémentation futur.
- `InMemoryMetricsCollector` est réservé aux tests/harness et ne doit pas être utilisé en
  production (source : `apps/worker/src/metrics.ts`).

#### G5I-A/G5I-B — Packaging local Docker implémenté et validé (statique + runtime)

La phase G5I-A a livré le packaging local Docker du worker **sans déploiement** :
`Dockerfile.worker` (multi-stage builder/runtime-base/validation/production,
`node:24-slim`, production = stage par défaut = dernier FROM),
`docker-compose.worker.yml` (durcissement : non-root UID/GID 1001, `read_only`,
`cap_drop: ALL`, `no-new-privileges`, `mem_limit: 512m`, `cpus: 1.0`,
`stop_grace_period: 2m`, logging `json-file` roté, `env_file` externe),
`apps/worker/.env.example` (modèle versionnable à valeurs factices), un guide ops
(`docs/implementation/g5i-a-worker-local-packaging.md`) et un test de validation
statique (`apps/worker/src/docker-packaging.test.ts`, 71 tests, sans daemon Docker).
Correctif packaging : `postgres` déplacé de `devDependencies` à `dependencies` dans
`apps/worker/package.json` (dépendance runtime externalisée par esbuild).
Packaging Docker implémenté et validé statiquement ET en runtime Docker
(G5I-B) : build, inspection, smoke, échec de configuration, Compose, démarrage
avec PostgreSQL éphémère et SIGTERM tous exécutés avec succès. **Aucun déploiement exécuté.**
G5I-A : validation statique uniquement (daemon Docker non démarré). G5I-B :
Colima démarré avec autorisation, validations Docker runtime exécutées avec succès
(Docker Engine 29.5.2, Compose 5.3.1). Correctifs runtime G5I-B : `pnpm deploy
--legacy` (pnpm v10) et chemins absolus pour `COPY --from=builder` (Docker
Engine 29.5.2). Le déploiement VPS réel (SSH, configuration Neon/R2/Resend, secrets)
reste un lot distinct futur. Voir `docs/implementation/g5i-a-worker-local-packaging.md`.

### 2.4 Stockage objet — fermeture de la question 6 (ADR-013)

- **Fournisseur retenu : Cloudflare R2.**
- Bucket privé créé avec **juridiction `eu`**. Ne pas promettre un placement physique précis à
  Frankfurt : la documentation officielle R2 garantit une juridiction UE, pas un datacenter
  spécifique.
- Utiliser l'API compatible S3 (`@aws-sdk/client-s3` avec endpoint R2) — **adapter implémenté et
  testé dans G5H-A** (`apps/worker/src/adapters/r2-object-storage.ts`), **câblé au worker** depuis
  G5H-C2C-B3. Credentials non configurés, bucket non créé (configuration déploiement post-B4).
- **Clés applicatives opaques, immuables et versionnées** : le versioning des documents est géré
  côté application via un schéma de clés, pas via le bucket versioning S3 natif (R2 ne fournit pas
  le versioning natif).
- Les écritures restent conditionnelles/idempotentes via `putIfAbsent` (`If-None-Match: *`,
  412 PreconditionFailed). Un objet existant avec checksum différent reste une **anomalie
  fail-closed** (conforme à ADR-013 et à la question ouverte 15, qui reste ouverte).
- **Questions laissées ouvertes** :
  - question 9 (politique de téléchargement et durée des URLs signées) — non fermée ;
  - question 16 (régénération d'une nouvelle version documentaire) — non fermée.

### 2.5 Email — fermeture des questions 7 et 14 (ADR-013)

- **Fournisseur retenu : Resend.**
- **Resend Pro** est retenu pour le lancement commercial ; Resend Free reste possible en
  dev/staging (limite 100/jour, 3 000/mois).
- L'adapter devra transmettre la clé stable `providerIdempotencyKey` comme clé d'idempotence Resend
  (header `Idempotency-Key` ou champ SDK `idempotencyKey`). **Adapter implémenté et testé dans G5H-B**
  (`apps/worker/src/adapters/resend-transactional-email-sender.ts`), **câblé au worker** depuis
  G5H-C2C-B3. Aucune configuration réelle, aucun domaine configuré, aucun email réel envoyé
  (configuration déploiement post-B4).
  Politique retry < 24 h et fail-closed livrée G5H-C2A/C2B/C2C-A.
- **La déduplication native est garantie uniquement dans la fenêtre documentée de 24 heures**
  (source : https://resend.com/docs/dashboard/emails/idempotency-keys, 2026-08-05) :
  - même clé + même payload pendant 24 h : même réponse (même email id), aucun nouvel email ;
  - même clé + payload différent : HTTP 409 `invalid_idempotent_request` ;
  - requêtes concurrentes avec la même clé : HTTP 409 `concurrent_idempotent_requests` (temporaire,
    retry ultérieur sûr) ;
  - après expiration des 24 h, la documentation officielle ne garantit plus la déduplication.

#### Politique validée : option A (retry < 24 h, puis fail-closed)

- **Retry automatique strictement limité à une fenêtre strictement inférieure à 24 heures**, puis
  **fail-closed et intervention manuelle**.
- Aucun nouvel envoi automatique ne doit être tenté lorsque l'on ne peut plus garantir que la clé
  est encore dans la fenêtre de déduplication Resend.
- Cette politique est validée pour les emails contenant des documents contractuels (factures, reçus,
  contrats, confirmations).

#### Distinction des états de livraison (à implémenter dans l'adapter/pipeline)

L'ADR exige que l'adapter/pipeline distingue explicitement :

1. **Livraison jamais tentée** — aucun appel externe n'a été effectué ; retry autorisé dans la
   fenêtre < 24 h.
2. **Livraison certainement refusée** — le fournisseur a renvoyé une erreur déterministe (4xx non
   idempotent, validation refusée) ; pas de retry automatique aveugle.
3. **Livraison au résultat incertain après appel externe** — timeout, erreur réseau, 5xx, ou crash
   survenu après l'appel externe sans confirmation de persistance du `providerMessageId`.

**En cas de résultat incertain, la sécurité contre le double envoi prime sur la livraison
automatique.** Si l'âge du premier appel approche de 24 h ou le dépasse, l'effet passe en état
requiring-manual-review et un humain décide ; aucun retry automatique n'est tenté au-delà de la
fenêtre.

La mécanique exacte de persistance de l'âge du premier appel et l'adapter Resend seront implémentés
dans un lot ultérieur avec tests. Aucune API de recherche Resend par clé d'idempotence n'est
documentée officiellement au 2026-08-05 ; aucune réconciliation automatique par recherche fournisseur
n'est donc prévue dans cet ADR.

#### Conception finale verrouillée — G5H-C1 (ADR-013 §13.1 à §13.11)

La conception finale de la politique d'idempotence Resend < 24 h et fail-closed est
**verrouillée** dans ADR-013 §13.1 à §13.11 (G5H-C1). Les décisions clés sont :

- **Cutoff à 23 heures** (`PROVIDER_IDEMPOTENCY_WINDOW_SECONDS = 82 800`) — marge
  d'1 h absorbant latence réseau p99, décalage d'horloge NTP, indisponibilité worker
  courte et retry backoff. Tous les calculs d'âge utilisent PostgreSQL
  `transaction_timestamp() - provider_first_attempt_started_at`.
- **Nouvel état `REQUIRES_MANUAL_REVIEW`** ajouté à `notification_delivery_status` —
  immuable par le worker, résoluble uniquement par intervention humaine via un use
  case administratif futur (transactions administratives atomiques).
- **Contrat Core `EmailSendResult`** (discriminated union) : `SENT` |
  `DETERMINISTIC_REFUSAL` | `TRANSIENT_NOT_SENT` | `UNCERTAIN`. Les adapters
  conformes retournent `EmailSendResult` et normalisent leurs erreurs attendues.
  MAIS le pipeline Core conserve un try/catch défensif autour de
  `await sender.send()` pour toute exception inattendue (sender défectueux,
  exception non-Error, bug adapter), normalisée en `UNCERTAIN` (fail-closed).
- **Retry idempotent des résultats `UNCERTAIN` < 23 h** : un résultat incertain
  avec âge < 23 h ET `attempts < MAX_ATTEMPTS` est retryé automatiquement avec
  exactement la même `providerIdempotencyKey` et le même payload. Si l'email a
  déjà été envoyé, Resend déduplique dans la fenêtre 24 h. `REQUIRES_MANUAL_REVIEW`
  n'est atteint que si âge ≥ 23 h (cutoff) ou `MAX_ATTEMPTS` atteint avec résultat
  incertain.
- **Colonne `provider_first_attempt_started_at`** (timestamptz, nullable, immuable
  une fois renseignée) persistée dans la transaction courte fenced de Phase B avant
  l'appel externe.
- **Migration 0029 unique transactionnelle planifiée** (non créée dans G5H-C1) :
  remplacement transactionnel des enums (`notification_delivery_status` et
  `document_processing_failure_code`) + colonne `provider_first_attempt_started_at`
  + CHECK constraints + triggers de transition + trigger d'immutabilité + index
  partiels, le tout dans une seule migration. Cible PostgreSQL 16. Le runner
  Drizzle (drizzle-orm 0.36.4) exécute toutes les migrations en attente dans une
  transaction commune — le découpage en deux fichiers est interdit car il ne
  crée pas de commit intermédiaire. Journal attendu : 28 → 29 migrations (PAS 30).
- **Budget de retry email séparé** : le budget de retry email est basé
  exclusivement sur `outbox_effects.attempt_count` de l'effet `SEND_EMAIL`, pas
  sur `outbox_events.attempt_count` (compteur de claims/observabilité). Le claim
  `READY_FOR_TRANSACTIONAL_EMAIL` filtre sur `SEND_EMAIL.attempt_count <
  MAX_ATTEMPTS` via JOIN avec `outbox_effects`.
- **Finalizer DB-only** : helper indépendant (`apps/worker/src/finalizer.ts`)
  traitant les crashs après dernière tentative (lease expirée +
  `SEND_EMAIL.attempt_count >= MAX_ATTEMPTS` → `REQUIRES_MANUAL_REVIEW` /
  `PROVIDER_RESULT_UNCERTAIN`) et les cutoffs sans appel (âge >= 23 h →
  `REQUIRES_MANUAL_REVIEW` / `EMAIL_RETRY_WINDOW_EXPIRED`). Aucun appel
  fournisseur. `FOR UPDATE SKIP LOCKED`. Invariant absolu : aucune 6e requête
  fournisseur n'est jamais effectuée.
- **Nouveaux failure codes** : `PROVIDER_RESULT_UNCERTAIN` et
  `EMAIL_RETRY_WINDOW_EXPIRED` (NOUVEAU). `REQUIRES_MANUAL_REVIEW` a toujours un
  `failure_code` non-null.
- **Résolution manuelle atomique future** : deux transactions administratives
  atomiques (« envoyé confirmé » et « non envoyé confirmé ») reportées à un lot
  ultérieur. Aucune instruction de modification SQL manuelle partielle autorisée
  tant que ce use case n'est pas implémenté.
- **Mapping Resend complet** et **machine d'états exhaustive** (35 cas) documentés
  dans ADR-013 §13.5 et §13.6.

**L'implémentation est livrée** : G5H-C2A (fondation PostgreSQL), G5H-C2B (contrat Core + adapter Resend), G5H-C2C-A (finalizer DB-only), G5H-C2C-B1 (décision renderer PDF), G5H-C2C-B2 (renderer PDF implémenté), G5H-C2C-B3 (câblage production createWorkerDependenciesFromEnv, arrêt propre, signaux), G5H-C2C-B4 (smoke test local du bundle compilé). Déploiement VPS et configuration réelle (Neon, R2, Resend, secrets, Docker) = lot distinct post-B4 (non livré).

### 2.6 Secrets

- Premier déploiement : fichier d'environnement dédié au worker, **hors Git**, propriétaire dédié,
  permissions 600.
- Aucun secret partagé avec les autres projets du VPS (`sokar`, `goldbot`).
- Un secret manager managé est **reporté** ; cet ADR ne choisit ni Doppler, ni Infisical, ni Vault.

### 2.7 Budget retenu

| Scénario | Total mensuel (USD, hors taxes et dépassements) |
| --- | --- |
| Dev/staging | ~0 $ |
| MVP commercial | ~55-58 $ (Vercel Pro 20 + Neon Launch 15-18 + VPS 0 marginal + R2 ~0 + Resend Pro 20) |
| Croissance initiale | ~91-146 $ |
| Architecture réseau renforcée (reportée) | ~191-226 $ |

> Note : ces estimations Neon sont illustratives et excluent les taxes ainsi que les éventuels coûts
> variables de history storage/instant restore et de transfert dépassant les quotas inclus. Le
> compute réel dépendra des CU-heures effectivement consommées.

## 3. Alternatives étudiées

### Stockage objet

- **AWS S3 eu-central-1** : alternative viable (putIfAbsent atomique natif, checksums complets,
  versioning, placement physique Frankfurt garanti, DPA AWS inclus). Non retenu au MVP car egress
  payant (0,09 $/Go après 100 Go) et complexité IAM plus élevée. Pourrait être reconsidered lors d'un
  renforcement réseau si la résidence physique Frankfurt devient une exigence juridique.
- **DigitalOcean Spaces** : non retenu. `putIfAbsent` non documenté pour PUT (risque de race
  condition) ; checksum SHA-256 stocké/récupérable non documenté. Incompatible avec l'exigence
  d'idempotence documentaire d'ADR-013.

### Email transactionnel

- **Amazon SES** : non retenu. Aucune clé d'idempotence fournisseur (SendEmail API) ; nécessiterait
  une idempotence DB-side avec risque résiduel de double email après un crash entre acceptation
  fournisseur et commit DB. Coût le plus bas à grande échelle et résidence EU disponibles, mais
  incompatible avec Q14 nativement.
- **Postmark** : non retenu. Déclaration officielle : « Postmark does not currently support an
  idempotency key feature » (source : https://postmarkapp.com/support/article/what-is-an-idempotency-key,
  2026-08-05). Incompatible avec Q14.

### Hébergement worker

- **systemd** : alternative à Docker Compose. Non retenu car le runtime Node.js 24 isolé serait en
  conflit avec le Node.js 22 existant sur l'hôte (nvm) ; Docker Compose offre l'isolation du
  runtime, un healthcheck natif (de processus, pas HTTP) et un rollback par image taguée.

## 4. Sécurité et isolation multi-tenant

- Le worker n'expose aucune donnée multi-tenant dans ses logs : `ConsoleWorkerLogger` interdit
  explicitement les PII (recipientEmail, noms, adresses, providerMessageId, storageKey, payload,
  variables d'environnement, chaînes de connexion).
- Les métriques sont à cardinalité bornée (labels limités à `pipeline`/`outcome`/`failureCode`) ;
  les UUID, bookingId, organizationId, email, providerMessageId, storageKey sont interdits comme
  labels.
- L'outbox payload ne contient jamais de montants, d'emails, de noms, d'adresses, de numéros de
  carte, de `client_secret` Stripe, d'URLs signées ou de snapshots métier (ADR-013 §2).
- Le bucket R2 est privé ; aucun accès public. Les téléchargements clients relèvent de la question
  ouverte 9 (URL signée courte vs streaming authentifié) — non fermée.
- Les rôles PostgreSQL sont séparés pour Web, worker et migrations avec privilèges minimaux.
- Les secrets du worker sont dans un fichier dédié chmod 600, hors Git, jamais partagés avec les
  autres projets du VPS.
- Aucune donnée de carte bancaire n'est stockée ou traitée par le worker (conforme à ADR-010 et
  ADR-013).

## 5. Idempotence Resend et frontière des 24 heures

### Verdict Q14

Resend est le seul fournisseur étudié compatible nativement avec Q14 **dans sa fenêtre
d'idempotence de 24 h**. Une politique fail-closed est nécessaire au-delà de cette fenêtre pour
garantir l'absence de double envoi automatique.

### Comparaison avec le backoff Uttily

Le backoff Uttily est `MAX_ATTEMPTS = 5`, backoff exponentiel 30 s → 480 s
(`packages/core/src/outbox-claim/scheduling.ts`), soit ~15 min pour les 5 tentatives en
fonctionnement normal — bien sous 24 h. Le risque n'apparaît qu'en cas d'**indisponibilité prolongée
du worker** (> 24 h) entre l'acceptation Resend et le commit DB du `providerMessageId`.

### Politique validée (option A)

- Retry automatique uniquement dans une fenêtre strictement inférieure à 24 h.
- Au-delà : fail-closed, état requiring-manual-review, intervention humaine.
- En cas de résultat incertain après appel externe : la sécurité contre le double envoi prime sur la
  livraison automatique.

### Limitation explicite

L'idempotence DB seule ne garantit pas l'absence de double email après un crash survenant entre
l'acceptation par le fournisseur et le commit DB du `providerMessageId`. La politique fail-closed
< 24 h est la garantie principale contre ce risque. Aucune réconciliation automatique par recherche
fournisseur n'est prévue (aucune API Resend de recherche par clé documentée au 2026-08-05).

## 6. Stockage R2 et immuabilité applicative

- `putIfAbsent` est la seule méthode d'écriture du port `ObjectStorage` (ADR-013, `ports.ts`) ;
  aucun overwrite silencieux.
- Un objet existant avec checksum/taille/contentType identiques est un replay sûr.
- Un objet existant avec checksum/taille/contentType différents est une **anomalie durable
  fail-closed** (conforme à ADR-013 et à la question ouverte 15, qui reste ouverte).
- Le versioning des documents est géré par **clés applicatives opaques, immuables et versionnées**
  (préfixe ou suffixe côté application), pas par le bucket versioning S3 natif (R2 ne le fournit
  pas).
- La politique métier de régénération documentaire (quand régénérer, conservation des versions
  antérieures) reste ouverte (question 16) — non fermée par cet ADR.

## 7. Topologie Web / DB / worker

```text
Vercel Pro (Web, Next.js)
   │  écrit outbox + tables métier
   ▼
Neon Launch (PostgreSQL + PostGIS, aws-eu-central-1, accès public TLS)
   ▲  lit outbox, persiste résultats
   │
VPS DigitalOcean Frankfurt (sokar, conteneur Docker Node 24)
   ├── worker lit outbox, génère documents
   ├── worker écrit objets → Cloudflare R2 (juridiction eu, bucket privé, S3-compatible)
   └── worker envoie emails → Resend (Idempotency-Key = providerIdempotencyKey)
```

Flux réseau :

1. Web Vercel écrit dans Neon (outbox + tables métier) via Server Actions/Route Handlers.
2. Worker VPS Frankfurt se connecte à Neon (`aws-eu-central-1`) avec TLS
   (`sslmode=require` minimum, idéalement `verify-full`).
3. Worker lit l'outbox, génère les documents (PDF).
4. Worker écrit les objets dans R2 via `putIfAbsent` conditionnel (`If-None-Match: *`).
5. Worker envoie l'email transactionnel via Resend (`Idempotency-Key`).
6. Worker persiste les résultats (`providerMessageId`, `storageKey`, statuts) dans Neon.

### Remarques réseau

- Neon, Cloudflare R2 et Resend utilisent des infrastructures/IP potentiellement dynamiques. Une
  allowlist d'IP sortantes fragiles n'est pas recommandée sans proxy egress ou solution DNS-aware.
- L'IP Allow Rules côté Neon nécessite Neon Scale (non disponible sur Launch) — reporté.
- Vercel utilise par défaut des IP sortantes dynamiques ; les Vercel Static IPs (100 $/projet/mois,
  add-on Pro) sont reportées.

## 8. Coûts

Tous les prix sont en USD, issus des pages officielles consultées le 2026-08-05.

| Composant | Plan | Coût mensuel |
| --- | --- | --- |
| Vercel | Pro | 20 $ (+20 $ usage credit inclus) |
| Neon | Launch | ~15-18 $ (≈100 CU-h × 0,106 $ + 20 Go × 0,35 $/Go) |
| VPS DigitalOcean | existant (sokar) | 0 $ marginal (déjà payé) |
| Cloudflare R2 | Standard | ~0 $ au démarrage (free tier 10 Go + 1M Class A + 10M Class B, egress gratuit) |
| Resend | Pro | 20 $ (50 000 emails inclus, 0,90 $/1 000 en dépassement) |

**Total MVP commercial : ~55-58 $/mois** hors taxes et dépassements.

Scénarios additionnels (issus de G5G-A) :

- Dev/staging : ~0 $.
- Croissance initiale : ~91-146 $.
- Architecture réseau renforcée (reportée) : ~191-226 $ (Vercel Pro 20 + Vercel Static IPs 100 +
  Neon Scale ~50-85 + R2 ~0,75 + Resend Pro 20).

## 9. Conséquences

### Positives

- Questions 6, 7 et 14 de l'ADR-013 résolues ; le worker n'est plus bloqué par une décision
  fournisseur ouverte.
- Coût marginal du worker nul (VPS déjà payé).
- R2 : egress gratuit, free tier généreux, putIfAbsent atomique, juridiction UE.
- Resend : idempotence native dans la fenêtre de 24 h, SDK Node officiel, DPA RGPD.
- ADR-005 préservé (Vercel + Neon inchangés).
- Isolation multi-tenant et cardinalité bornée déjà en place dans le worker.

### Négatives

- R2 ne fournit pas le versioning natif → versioning applicatif par clés.
- R2 : juridiction UE garantie, mais placement physique Frankfurt non garanti.
- Resend : déduplication native limitée à 24 h → politique fail-closed obligatoire au-delà, avec
  intervention manuelle possible.
- Resend : données traitées aux États-Unis (DPF certified, SCC) — pas de résidence UE native.
- Neon Launch : pas d'IP Allow Rules (nécessite Scale) → accès public TLS au MVP.
- Cohabitation worker / sokar / goldbot sur le même VPS → contention RAM possible, limites
  CPU/mémoire à valider.
- Aucun endpoint `/healthz` ni `/metrics` implémenté → observabilité premier déploiement limitée aux
  logs et redémarrages.

## 10. Éléments explicitement reportés

- Neon Scale + IP Allow Rules + Vercel Static IPs (renforcement réseau) — reporté à justification
  par risque ou charge.
- Endpoint `/healthz`, endpoint `/metrics` Prometheus, adaptateur métriques production — lot
  d'implémentation futur.
- Secret manager managé (Doppler, Infisical, Vault) — reporté ; non choisi dans cet ADR.
- Adapters R2 et Resend — non implémentés dans cet ADR ; lots ultérieurs avec tests.
- Réconciliation automatique par recherche Resend — non prévue (aucune API documentée).
- Question 9 (URLs signées) — ouverte.
- Question 16 (régénération/versioning métier) — ouverte.
- Question 15 (politique objet existant avec checksum différent) — ouverte.
- Question 5 (conservation RGPD) — ouverte.
- Question 17 (webhooks délivrabilité/bounce) — ouverte.
- Questions juridiques et fiscales (1, 2, 3, 4, 10, 11, 12) — ouvertes.

## 11. Plan d'implémentation par lots

Cet ADR ne livré aucun code. Les lots suivants seront définis ultérieurement :

1. **Lot adapter R2** : implémenter `ObjectStorage` avec `@aws-sdk/client-s3` + endpoint R2
   (`If-None-Match: *`, checksum SHA-256, `head`, `get`), tests unitaires et intégration.
2. **Lot adapter Resend** : implémenter `TransactionalEmailSender` avec SDK `resend`, transmission
   du `providerIdempotencyKey` via `Idempotency-Key`, retour du `providerMessageId`, tests
   unitaires.
3. **Lot politique retry < 24 h + fail-closed** : persistance de l'âge du premier appel,
   transition requiring-manual-review au-delà de la fenêtre, distinction des trois états de
   livraison (jamais tentée / certainement refusée / incertaine), tests d'intégration PostgreSQL.
4. **Lot déploiement VPS** : Dockerfile, `docker-compose.worker.yml`, limites CPU/RAM, utilisateur
   dédié, fichier env chmod 600, healthcheck de processus, logs journald/json-file rotation.
5. **Lot observabilité futur** : endpoint `/healthz`, endpoint `/metrics` Prometheus, adaptateur
   métriques production, alertes.
6. **Lot renforcement réseau futur** : Neon Scale + IP Allow Rules + Vercel Static IPs (sur
   justification).

## 12. Stratégie de rollback fournisseur

### Stockage R2

- Le port `ObjectStorage` est provider-neutral ; un adapter AWS S3 eu-central-1 peut être implémenté
  sans changer le port ni le pipeline.
- Les clés applicatives sont opaques et portables ; un migration R2 → S3 implique une copie des
  objets (par clé) et un changement d'endpoint/credentials, pas de changement de schéma DB.
- `putIfAbsent` conditionnel est supporté par R2 et S3 ; la sémantique idempotente est préservée.

### Email Resend

- Le port `TransactionalEmailSender` est provider-neutral ; un adapter SES ou Postmark peut être
  implémenté, mais **sans idempotence native** (Q14) — nécessiterait l'idempotence DB-side avec
  risque résiduel de double email documenté.
- Un rollback Resend → SES implique la perte de la garantie d'idempotence native et exige la
  politique DB-side + acceptation explicite du risque de doublon.

### Worker VPS

- Rollback par image Docker taguée N-1 (`docker compose up -d --no-deps uttily-worker` avec la
  version précédente). Le worker est idempotent (outbox) ; un rollback n'entraîne pas de perte
  d'effets déjà persistés.

## 13. Sources officielles (consultées le 2026-08-05)

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

DigitalOcean :

- https://www.digitalocean.com/pricing/droplets
- https://docs.digitalocean.com/products/droplets/details/availability/

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

Amazon SES :

- https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
- https://aws.amazon.com/ses/pricing/

AWS S3 :

- https://aws.amazon.com/s3/pricing
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html
