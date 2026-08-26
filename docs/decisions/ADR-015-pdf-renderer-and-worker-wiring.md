# ADR-015 — Renderer PDF de production et câblage final du worker

- **Statut** : Accepted — G5H-C2C-B1 (décision et conception) approuvé. G5H-C2C-B2 livré (renderer PDF pdf-lib implémenté et testé). G5H-C2C-B2 Round 2 livré (corrections du renderer). G5H-C2C-B3 livré (câblage production createWorkerDependenciesFromEnv, arrêt propre, signaux). G5H-C2C-B4 livré (smoke test local du bundle compilé : harness `apps/worker/scripts/smoke-built-worker.mjs` importe `dist/index.js`, vérifie les exports, exécute `startWorker` avec fakes, émet un SIGTERM factice, vérifie shutdown unique et retrait des listeners, timeout ferme référencé 5000 ms (exit 70 si dépassé), terminaison naturelle au succès (pas de `process.exit(0)`), scrub des variables d'environnement fournisseur avant import, vérification de l'absence d'effets de bord à l'import (exitCode, listeners, console), 3 tests subprocess (bundle absent exit 2, hang/timeout exit 70, succès exit 0 naturel) ; commandes `smoke:built`, `smoke` et `smoke:verify` ; fixture dev-only `scripts/fixtures/hanging-bundle.mjs`). G5H-C2C-B4 Round 3 livré (capture des effets console différés via setImmediate pendant et après l'import ; validation stricte de `--timeout-ms` (regex `^[0-9]+$` + `Number.isSafeInteger` + borne [50, 10000], fail-closed exit 64 avec message générique sans interpolation de la valeur reçue) ; `fileParallelism: false` dans `vitest.config.ts` pour sérialiser les tests manipulant le répertoire `dist` partagé ; nouvelles fixtures dev-only `scripts/fixtures/deferred-console-bundle.mjs` et `scripts/fixtures/sync-console-bundle.mjs` ; 11 tests subprocess (bundle absent exit 2, hang/timeout exit 70, succès exit 0 naturel avec stdout exact et stderr vide, console synchrone détectée exit 1, console différée setImmediate détectée exit 1, validation stricte `--timeout-ms` exit 64 pour 5 cas invalides, fixtures absentes de dist)). Déploiement VPS et configuration réelle = lot distinct post-B4 (non livré).
- **Date** : 2026-08-06
- **Décideurs** : Équipe engineering Uttily
- **Relie à** : ADR-013, ADR-014

## 1. Contexte

- G5H-C2C-A est livré (finalizer DB-only, 211 tests worker).
- **État au moment de la décision B1** : les adapters R2 et Resend étaient implémentés
  et testés mais non câblés dans `createWorkerDependenciesFromEnv`. Le worker n'était
  pas déployable car aucun renderer PDF de production n'existait. Cet état est
  historique ; depuis G5H-C2C-B2/B3, le renderer PDF est livré et les adapters sont
  câblés (voir §10b).
- Le pipeline documentaire exige qu'un même `templateKey` +
  `DocumentRenderSnapshotV1` produise des octets identiques après crash/replay.
  Si le checksum change sans changement de snapshot/template, le pipeline détecte
  un objet R2 existant avec checksum différent et échoue fail-closed.
- Le choix du renderer doit donc traiter explicitement la reproductibilité
  binaire.

## 2. Décision 1 — Renderer retenu : pdf-lib

**Choix : pdf-lib (version 1.17.1, licence MIT).**

### Justification face aux alternatives

| Critère | pdf-lib | PDFKit | @react-pdf/renderer | Playwright/Chromium |
| --- | --- | --- | --- | --- |
| Node 24 | Oui | Oui | Oui | Oui |
| ESM | Partiel (workaround esbuild) | Non | Oui (v4+) | Oui |
| Maintenance | Inactif depuis nov 2022 | Actif (juin 2026) | Actif (avr 2026) | Très actif (Microsoft) |
| Licence | MIT | MIT | MIT | Apache 2.0 |
| Dépendances | 4, pur JS | 6, pur JS | 13, pur JS + React | ~7 MB + Chromium |
| Chromium requis | Non | Non | Non | Oui (170-450 MB) |
| esbuild bundleable | Oui (workaround mainFields) | Non (CJS only) | Avec polyfills | Oui |
| Conteneur minimal | Oui | Oui | Oui | Non (830 MB+) |
| Métadonnées PDF contrôlables | Oui (CreationDate, ModDate, ID) | Partiel (ID auto MD5) | Limité (hérite PDFKit) | Non |
| Reproductibilité binaire | Oui avec `updateMetadata: false` + dates fixes + ID fixe | Partiel (Math.random dans fonts) | Non (hérite PDFKit) | Non (timestamps Chromium) |
| UTF-8 / accents français | Nécessite polices embarquées | Nécessite polices embarquées | Nécessite polices embarquées | Natif (Chromium) |
| Tableaux | Non natif (manuel ou pdf-lib-table) | Natif (`doc.table()`) | Natif (View/Text) | Natif (HTML/CSS) |
| Sécurité | Bon (pas de réseau, pas de HTML) ; DoS sur PDF chargé | Bon | HTML injection si composant Html | SSRF, CVE Chromium, exécution JS |
| Mémoire | < 50 MB | < 100 MB | 100-200 MB | 200-400 MB |

### Raison principale

pdf-lib est la seule solution qui permet de contrôler explicitement
`CreationDate`, `ModDate`, l'identifiant de document, et de désactiver la mise à
jour automatique des métadonnées (`updateMetadata: false`). C'est la seule qui
peut produire des octets identiques pour une entrée identique sans patcher
`Math.random()` ou lancer un navigateur.

### Risques acceptés et mitigations

- Maintenance inactive depuis novembre 2022 : version pinée exactement
  (`pdf-lib@1.17.1`), monitoring de sécurité (Dependabot/Snyk), plan de
  migration vers un fork actif ou PDFKit si nécessaire.
- Pas de tableaux natifs : layout manuel via primitives (rectangles, lignes,
  texte) ou évaluation de `pdf-lib-table` en B2.
- UTF-8 nécessite polices embarquées : la police Inter (licence SIL OFL, format
  TTF) sera versionnée dans le dépôt.
- DoS sur PDF chargé (Issue #1777) : non applicable car le renderer ne charge
  jamais de PDF externe ; il crée toujours un nouveau `PDFDocument`.

### Sources officielles

**Note Node 24 :** pdf-lib 1.17.1 (novembre 2022) n'a pas été testé officiellement
sur Node 24, mais repose sur ES5/ES6 standard compatible avec Node 24. Une
vérification explicite sera effectuée en B2 (test de reproductibilité sur Node
24).

pdf-lib ne requiert aucun paquet système (pas de compilation native, pas de
dépendances C/C++, pure JavaScript). Compatible avec les conteneurs minimaux
sans paquets supplémentaires.

- Dépôt : https://github.com/Hopding/pdf-lib
- npm : https://www.npmjs.com/package/pdf-lib
- Licence : https://github.com/Hopding/pdf-lib/blob/master/LICENSE.md (MIT)
- Issue #537 (reproductibilité) : https://github.com/Hopding/pdf-lib/issues/537
- Issue #1777 (DoS) : https://github.com/Hopding/pdf-lib/issues/1777
- PDFKit : https://github.com/foliojs/pdfkit, https://www.npmjs.com/package/pdfkit
- @react-pdf/renderer : https://github.com/diegomura/react-pdf, https://www.npmjs.com/package/@react-pdf/renderer
- Playwright : https://github.com/microsoft/playwright, https://www.npmjs.com/package/playwright

## 3. Décision 2 — Templates supportés initialement

Trois `templateKey` exacts, déjà produits par le pipeline :

1. `booking-confirmation-technical-v1` — confirmation de réservation technique.
2. `rental-contract-technical-v1` — contrat de location technique.
3. `payment-receipt-technical-v1` — reçu de paiement technique.

Aucune facture fiscale, signature électronique, clause juridique ou branding non
décidé n'est ajoutée. Les templates restent techniques et neutres.

## 4. Décision 3 — Contrat de reproductibilité

**Invariant :** mêmes `templateKey` + snapshot canonique
`DocumentRenderSnapshotV1` + version du renderer → mêmes octets PDF → même
`checksumSha256` → même `sizeBytes`.

### Règles

- `contentType` : `application/pdf`.
- `CreationDate` et `ModDate` figées à une valeur stable dérivée du snapshot
  (`capturedAt` converti en `Date`), jamais `new Date()` ou `Date.now()`.
- Identifiant de document PDF : pdf-lib n'expose pas d'API publique
  `setDocumentId`. Stratégie retenue (Option A) : ne pas ajouter de trailer ID
  lorsque pdf-lib n'en génère pas par défaut sur un nouveau
  `PDFDocument.create()`. Le prototype B2 doit confirmer explicitement que les
  octets restent déterministes sans trailer ID. Si un ID est réellement requis,
  l'accès bas niveau à `pdfDoc.context.trailerInfo.ID` sera isolé dans un helper,
  pdf-lib piné exactement, et un test de régression ciblé ajouté. Cet accès n'est
  pas une API publique stable.
- Aucune valeur aléatoire : pas de `Math.random()`, pas de `crypto.randomUUID()`
  dans le rendu.
- Aucune requête réseau pendant le rendu.
- Polices embarquées et versionnées dans le dépôt (format TTF, licence SIL OFL).
- Ordre déterministe des objets PDF : pdf-lib ajoute les objets dans l'ordre
  d'appel ; le code de rendu doit toujours ajouter les éléments dans le même
  ordre pour un même template.
- `SHA-256` calculé sur les octets réellement produits par `pdfDoc.save()`.
- `sizeBytes` = `content.length` exact.
- `PDFDocument.create({ updateMetadata: false })` : désactive la mise à jour
  automatique des métadonnées par pdf-lib. `CreationDate` et `ModDate` sont
  fixées explicitement à `snapshot.capturedAt` (converti en `Date`). Tout champ
  producteur/créateur/titre ajouté est fixé explicitement. Aucune heure système,
  aucune dépendance aux métadonnées automatiques par défaut.

### Polices

- `pdf-lib@1.17.1` piné exactement.
- `@pdf-lib/fontkit` piné exactement (dépendance obligatoire pour les polices
  TTF personnalisées).
- Police utilisée en B2 : Inter Regular, version 4.1, tag v4.1, source officielle
  https://github.com/rsms/inter, licence SIL OFL.
- Fichier TTF versionné localement dans le dépôt :
  `apps/worker/assets/fonts/inter-regular.ttf`.
- SHA-256 de l'asset : `40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82`.
- Taille : 411 640 bytes.
- Licence SIL OFL jointe au dépôt :
  `apps/worker/assets/fonts/LICENSE-OFL.txt` (SIL OFL 1.1).
- Aucun téléchargement réseau au build ou au runtime.
- Embedding complet (non subset) confirmé par le prototype B2.
- Tests avec accents français, symbole euro, apostrophes, tirets et caractères
  réellement présents dans les snapshots.

### Mécanisme de détection crash/replay

En cas de replay après crash, si `putIfAbsent` retourne `ALREADY_EXISTS`, le
pipeline appelle `storage.head()` pour récupérer les métadonnées de l'objet
existant, puis compare `contentType`, `sizeBytes` et `checksumSha256`. Si l'un
de ces champs diffère, l'effet passe en `DURABLE_FAILURE` avec le code
`STORAGE_CHECKSUM_MISMATCH`, préservant le comportement fail-closed. C'est
pourquoi la reproductibilité binaire du renderer est critique : un checksum
différent après replay provoque un échec durable et explicite, jamais une
écrasement silencieux.

### Tests à exiger pour B2

1. Deux rendus dans le même processus : octets identiques.
2. Deux processus Node 24 distincts : octets identiques.
3. Build esbuild puis rendu depuis `dist` : mêmes octets que le rendu source.
4. Heure système et TZ différentes : octets identiques.
5. Accents français, euro, apostrophes et tirets.
6. Trois `templateKey`.
7. Template inconnu refusé fail-closed.
8. Snapshot invalide refusé.
9. Bornes lignes/items/textes/pages/taille.
10. PDF parsable et commençant par la signature `%PDF-`.
11. Checksum et `sizeBytes` recalculés depuis `content`.
12. Aucune requête réseau.
13. Police chargée depuis un chemin absolu dérivé de `import.meta.url`,
    indépendant du cwd.
14. Invocation du build depuis la racine et depuis `apps/worker`.
15. Bundle sans dépendance runtime manquante.

**Statut B2 :** les 15 tests ci-dessus sont implémentés et passent. Les tests de
reproductibilité multi-processus (test 2), build source/dist (test 3) et TZ
(test 4) sont également implémentés et passent. Un test d'intégration pipeline
PostgreSQL est implémenté et passe (rendu end-to-end via le pipeline documentaire
avec base PostgreSQL locale).

### Versions exactes des dépendances

- `pdf-lib@1.17.1` (exact, sans caret) — piné dans `package.json`.
- `@pdf-lib/fontkit@1.1.1` (exact, sans caret) — piné dans `package.json`.

## 5. Décision 4 — Versioning

### Immutabilité v1

Les trois `templateKey` v1 et leur code de layout sont immuables pour le
périmètre actuel. B2 implémente uniquement :

- `booking-confirmation-technical-v1`
- `rental-contract-technical-v1`
- `payment-receipt-technical-v1`

### Danger du mapping en place

`templateKey` n'est pas persisté sur `outbox_effects`. Il est dérivé à
l'exécution via `EFFECT_TO_TEMPLATE_KEY`. Un effet `GENERATE_*` PENDING existant
ne persiste pas le `templateKey` utilisé. Après un déploiement modifiant le
mapping :

- l'ancien effet peut être rejoué avec le template v2 ;
- il conserve son ancien `storage_key` UUID ;
- si l'objet v1 existe, cela produit un checksum mismatch durable ;
- si aucun objet n'existe encore, il peut produire v2 alors que l'événement
  historique avait été préparé sous v1.

### Politique

1. Une évolution graphique ne peut pas être activée par une simple modification
   en place de `EFFECT_TO_TEMPLATE_KEY`.
2. Avant toute v2, une nouvelle décision et une évolution persistée seront
   nécessaires, par exemple :
   - persister `template_key`/`render_profile_version` dans `outbox_effects` ou
     une table associée au moment de la Phase A ;
   - ou introduire de nouveaux effect types/event versions avec migration
     contrôlée.
3. Ce choix est une décision future obligatoire. Aucune solution n'est
   sélectionnée implicitement maintenant.
4. Tant que ce mécanisme persistant n'existe pas :
   - aucune v2 ;
   - aucune modification du layout v1 susceptible de changer les octets ;
   - aucun changement de police ou de version de pdf-lib pour les effets v1 ;
   - `pdf-lib` et `@pdf-lib/fontkit` doivent être pinés exactement.

### `storage_key`

`storage_key` est un UUID opaque généré par `crypto.randomUUID()` en Phase A,
persisté sur `outbox_effects.storage_key` avant le rendu, et stable lors des
replays. Il ne contient aucune PII, n'encode ni `templateKey`, ni version, ni
checksum. Le `checksumSha256` est conservé dans les métadonnées R2 et la table
`documents`, pas dans la clé. `putIfAbsent` + `head`/`get` assurent la détection
des divergences. Aucune modification de cette stratégie n'est autorisée en B2.

## 6. Décision 5 — Limites d'entrée

Le parser actuel (`parse-snapshot.ts`) n'impose aucune longueur maximale
explicite sur les champs texte, ni de limite numérique sur le nombre de lignes
ou d'items. Les limites ci-dessous sont des bornes applicatives à implémenter en
B2, cohérentes avec les données actuellement autorisées :

- Longueur maximale par champ texte rendu : 500 caractères.
- Longueur maximale d'une ligne/adresse : 500 caractères.
- Nombre maximal de lignes (`SnapshotLineItem`) : 100.
- Nombre maximal d'items (`SnapshotBookingItem`) : 100.
- Nombre maximal de pages PDF : 10.
- Taille PDF maximale : 2 MB.
- Stratégie de wrapping : coupure à la largeur de colonne, ellipsis (`…`) si
  dépassement.
- Comportement si une limite est dépassée : le renderer lève une erreur nettoyée
  avant de produire le PDF.
- Aucune donnée arbitraire injectée dans du HTML ou une URL : pdf-lib ne traite
  pas de HTML.

## 7. Décision 6 — Classification des erreurs du renderer

Option A retenue (plus petit changement cohérent) :

- Le contrat actuel est conservé : toute exception du renderer est normalisée en
  `TRANSIENT_FAILURE` + `RENDER_FAILED` par le pipeline, puis bornée par le
  budget de tentatives.
- `DOCUMENT_TOO_LARGE` n'existe pas dans l'enum
  `document_processing_failure_code` et n'est pas introduit en B1.
- Les dépassements de limites lèvent une erreur nettoyée, actuellement normalisée
  en `RENDER_FAILED` transitoire.
- Aucun nouveau code d'erreur n'est créé pendant B1 Round 2.
- Option B (contrat déterministe futur) reste documentée comme possibilité
  post-MVP si le besoin émerge.

## 8. Décision 7 — Contrat `createWorkerDependenciesFromEnv` cible

### Variables d'environnement requises (noms uniquement, aucune valeur réelle)

| Variable | Rôle | Validation |
| --- | --- | --- |
| `DATABASE_URL` | Connexion PostgreSQL poolée | Non vide, format URL |
| `R2_ACCOUNT_ID` | Identifiant de compte Cloudflare R2 ; l'adaptateur cible automatiquement l'endpoint EU de la juridiction du bucket | Alphanumérique, 6-64 caractères |
| `R2_ACCESS_KEY_ID` | Clé d'accès R2 | Non vide |
| `R2_SECRET_ACCESS_KEY` | Clé secrète R2 | Non vide |
| `R2_BUCKET_NAME` | Nom du bucket R2 | 3-63 caractères, lowercase |
| `RESEND_API_KEY` | Clé API Resend | Préfixe `re_`, max 256 caractères |
| `RESEND_FROM_EMAIL` | Email expéditeur Resend | Format email valide |
| `RESEND_BOOKING_CONFIRMED_TEMPLATE_ID` | ID de template Resend | Non vide, max 256 caractères |

**Aucune variable supplémentaire pour le renderer** : pdf-lib est une bibliothèque
locale sans configuration externe. Les polices sont embarquées dans le dépôt.

### Comportement de la factory cible (à implémenter en B3)

- Valider toute la configuration avant de démarrer la boucle.
- Construire `DatabaseClient`, `PdfLibDocumentRenderer`, `R2ObjectStorage`,
  `ResendTransactionalEmailSender`, `ConsoleWorkerLogger`,
  `InMemoryMetricsCollector` (ou équivalent production).
- Ne jamais utiliser les fakes.
- Ne jamais afficher une valeur de secret dans les erreurs ou logs.
- Fermer proprement les ressources lors de `SIGTERM`/`SIGINT` (connexion DB,
  client R2). **Note** : le SDK Resend n'a pas de ressource fermable — voir §10b
  pour le comportement réel livré en B3.
- Échouer avec `WorkerConfigurationError` nettoyée si une variable est manquante
  ou invalide.

**Note :** La fermeture propre des ressources (connexion DB, client R2, client
Resend) lors de `SIGTERM`/`SIGINT` est un livrable de B3. Le code actuel
(`index.ts`) lève volontairement `WorkerConfigurationError` avant de construire
aucune dépendance ; aucune ressource n'est donc ouverte. **Superseded par §10b** :
l'implémentation B3 livrée utilise `process.exitCode` (pas de `process.exit()`),
ferme `deps.db.$client` et détruit le client R2 via `close()`. Le SDK Resend n'ayant
pas de ressource fermable, aucun cleanup Resend n'est tenté.

## 9. Décision 8 — Découpage d'implémentation

- **G5H-C2C-B2** : Renderer PDF réel (`PdfLibDocumentRenderer`) + tests de
  reproductibilité déterministes + polices embarquées + tests unitaires et
  d'intégration.
- **G5H-C2C-B3** : Composition `createWorkerDependenciesFromEnv` + tests de
  configuration (variables manquantes, invalides, valides) + gestion
  `SIGTERM`/`SIGINT`.
- **G5H-C2C-B4 (livré)** : Smoke test local entièrement fake/mock du bundle
  compilé `apps/worker/dist/index.js`. Harness `apps/worker/scripts/smoke-built-worker.mjs`
  (chemins résolus depuis `import.meta.url`) : importe le bundle esbuild (pas les
  sources TypeScript), vérifie les exports requis (`startWorker`,
  `createWorkerDependenciesFromEnv`, `PdfLibDocumentRenderer`, `R2ObjectStorage`,
  `ResendTransactionalEmailSender`, `WorkerConfigurationError`), confirme l'absence
  d'auto-start au simple import, démarre `startWorker` avec un `WorkerRuntime` fake,
  une `SignalSource` factice et un `runLoop` fake asynchrone, émet un SIGTERM factice
  après le démarrage de la boucle, vérifie que l'AbortSignal transmis devient aborted,
  que le shutdown s'exécute exactement une fois, que les listeners SIGTERM/SIGINT sont
  retirés, et termine par terminaison naturelle (pas de `process.exit(0)`, `clearTimeout` + `return`, prouvant qu'aucun handle ne reste actif). Timeout ferme référencé 5000 ms (exit 70 si dépassé, `--timeout-ms=N` dev-harness-only borné [50, 10000] ms).
  Aucun appel réel à PostgreSQL/R2/Resend, aucun secret lu. Avant l'import du bundle, les variables d'environnement des fournisseurs (DATABASE_URL, R2_*, RESEND_*) sont supprimées de `process.env` sans lecture ni affichage, garantissant qu'une régression déclenchant le main à l'import échoue avant toute création de ressource distante. L'absence d'effets de bord à l'import est prouvée : `process.exitCode`, nombres de listeners SIGTERM/SIGINT, et appels console sont capturés et vérifiés inchangés. Commandes package :
  `smoke:built` (suppose le bundle construit) et `smoke` (build puis smoke:built).
  Commande `smoke:verify` : build frais + smoke:built + tests du harness contre ce build frais.
  Test d'échec contrôlé du harness via `apps/worker/src/smoke-harness.test.ts`
  (11 tests subprocess : échec propre bundle absent exit 2, timeout ferme exit 70 via fixture dev-only `scripts/fixtures/hanging-bundle.mjs` dont `startWorker` ne résout jamais, succès bundle présent exit 0 naturel avec stdout exact et stderr strictement vide, console synchrone pendant l'import détectée exit 1 via fixture dev-only `scripts/fixtures/sync-console-bundle.mjs`, console différée via setImmediate détectée exit 1 (pas exit 70) via fixture dev-only `scripts/fixtures/deferred-console-bundle.mjs`, validation stricte `--timeout-ms` exit 64 pour 5 cas invalides (49, 10001, 100junk, 100.5, chaîne vide) sans interpolation de la valeur reçue et échec immédiat (< 1000 ms), fixtures absentes de dist (seuls `index.js` et `index.js.map`) ; `beforeAll` build frais pour éviter un dist stale ; `assertNoSecrets` vérifie l'absence de `postgres://`, `postgresql://`, `re_`, `R2_SECRET_ACCESS_KEY`, `RESEND_API_KEY` dans stdout/stderr ; `fileParallelism: false` dans `vitest.config.ts` sérialise les tests manipulant le répertoire `dist` partagé).
  Les deux modes de build (`pnpm --filter @uttily/worker build` et
  `node apps/worker/build.mjs` depuis la racine) produisent un bundle smoke-testé.
  `node apps/worker/dist/index.js` avec environnement incomplet produit une
  `WorkerConfigurationError` propre (exit 1, aucune stack ni valeur sensible).
- **Déploiement VPS et configuration réelle** : lot distinct post-B4
  (Dockerfile, docker-compose production, secrets, configuration R2/Resend
  réelle, domaine). Non livré.

## 9b. G5H-C2C-B2 Round 2 — Corrections du renderer

Le Round 2 corrige cinq problèmes identifiés dans le renderer B2 initial. Aucune
autre décision de l'ADR n'est modifiée.

### Helper `assertPdfOutputLimits` — validation réelle aux bornes

Le renderer B2 initial validait le nombre de pages et la taille PDF via des
checks inline dans `render()`. Les tests correspondants étaient tautologiques :
le test ">10 pages" passait que le rendu réussisse OU échoue, et le test ">2 MiB"
ne vérifiait que la valeur de la constante.

Le Round 2 extrait un helper pur et fermé `assertPdfOutputLimits({ pageCount,
sizeBytes })` qui :

- valide que `pageCount` et `sizeBytes` sont des entiers non-négatifs ;
- lève `DocumentRenderError('VALIDATION')` avec un message générique (jamais les
  valeurs reçues) ;
- est testé directement à chaque borne (10/11 pages, 2 MiB/2 MiB+1, -1, 1.5).

La méthode `render()` appelle `assertPdfOutputLimits({ pageCount:
ctx.pages.length, sizeBytes: bytes.length })` après sérialisation, remplaçant
les checks inline. Un test de rendu au maximum naturel (100 lignes, 100 items)
vérifie que le PDF produit est valide et dans les limites.

### `formatAmountMinor` — formatage financier avec BigInt (pas de float)

Le helper `formatAmount` B2 utilisait `(minor / 100).toFixed(2)`, reposant sur
l'arithmétique flottante. Le Round 2 le remplace par `formatAmountMinor` qui :

- utilise `BigInt` pour la division entière et le modulo, évitant toute perte de
  précision flottante ;
- produit le format `XX,XX CUR` (séparateur virgule, sans dépendance à Intl) ;
- valide que l'entrée est un `Number.isSafeInteger` non-négatif ;
- est testé directement pour 0, 1, 99, 100, 15000, `Number.MAX_SAFE_INTEGER`
  (représentation exacte `90071992547409,91 EUR`), -1 et 1.5 (rejet).

### `formatDateNumeric` — format de date déterministe `DD/MM/YYYY HH:mm`

Le helper `formatDate` B2 utilisait `dateStyle: 'long', timeStyle: 'short'` qui
dépend des données textuelles ICU pouvant changer entre versions de Node. Le
Round 2 le remplace par `formatDateNumeric` qui :

- utilise `Intl.DateTimeFormat` avec composants explicites (year, month, day,
  hour, minute en `2-digit`/`numeric`) et `formatToParts` pour assembler la
  chaîne dans un ordre fixé par le code ;
- produit le format `DD/MM/YYYY HH:mm` avec `hourCycle: 'h23'` et
  `numberingSystem: 'latn'` ;
- est indépendant du TZ du processus (utilise le paramètre `timeZone` explicite) ;
- est testé pour l'hiver (UTC+1), l'été DST (UTC+2), le passage de minuit, et
  l'indépendance du TZ du processus.

### Textes français corrigés (accents)

Les textes codés en dur dans le renderer utilisaient l'ASCII uniquement (sans
accents). La police Inter supporte ces caractères. Le Round 2 corrige tous les
textes : `Confirmation de réservation`, `Référence réservation`, `Référence
paiement`, `Début`, `Confirmé le`, `Quantité`, `Équipement`, `Numéro de série`,
`État`, `Reçu technique`, `Période`, `Références`, `Statut réservation`, `Date
de succès`, `Montant payé`, `Document technique généré par Uttily`, `Document
technique — sans valeur contractuelle légale.`, et `Reçu technique — ne
constitue pas une facture fiscale.`

### Nom de variant > 500 chars — rejet au lieu de remplacement silencieux

`extractVariantName` B2 retournait silencieusement `'Article'` pour un nom >
500 chars, masquant le dépassement. Le Round 2 modifie le comportement :

- name absent, non-string, ou string vide → retourne `GENERIC_VARIANT_LABEL` ;
- name string de 1 à 500 chars → retourne name ;
- name string > 500 chars → lève `DocumentRenderError('VALIDATION', 'nom de
  variant trop long')`.

### Tests

Le fichier de tests unitaires du renderer contient désormais 80 tests (contre 56
avant le Round 2). Les tests tautologiques (>10 pages, >2 MiB) sont supprimés et
remplacés par des tests directs aux bornes de `assertPdfOutputLimits`, des tests
unitaires de `formatAmountMinor` et `formatDateNumeric`, des tests de
`extractVariantName` aux bornes (500/501/absent/vide/non-string), et un test de
rendu au maximum naturel (100 lignes, 100 items). Tous les tests passent (263
tests worker au total, 42 skipped pour intégration).

## 10b. G5H-C2C-B3 — Câblage production et arrêt propre

### `createWorkerDependenciesFromEnv` retourne `WorkerRuntime`

La factory ne retourne plus `WorkerDependencies` mais `WorkerRuntime { dependencies,
shutdown }`. Le `shutdown` est async, idempotent et testable.

### Validation fail-fast

Toutes les variables requises sont validées AVANT la création de la moindre
ressource :

1. `DATABASE_URL` (format, protocole, hostname, base) ;
2. R2 (4 variables via `createR2ConfigFromEnv` → `validateR2Config`) ;
3. Resend (3 variables via `createResendConfigFromEnv` → `validateResendConfig`).

### Validation `DATABASE_URL`

- chaîne non vide et sans whitespace extérieur ;
- URL parseable ;
- protocole strictement `postgres:` ou `postgresql:` ;
- hostname et nom de base non vides.

### Normalisation des erreurs

Toutes les erreurs de configuration R2/Resend sont normalisées en
`WorkerConfigurationError` avec des messages nettoyés (aucun secret, URL, clé ou
valeur sensible). Les messages R2/Resend existants (`R2ConfigError`,
`ResendConfigError`) sont déjà nettoyés et sont transmis tels quels.

### Ordre de création (après validation complète)

1. Database (`createDatabase`)
2. R2ObjectStorage
3. ResendTransactionalEmailSender
4. PdfLibDocumentRenderer
5. ConsoleWorkerLogger
6. InMemoryMetricsCollector

### Ordre de shutdown

1. DB end (`db.$client.end()`)
2. R2 close (`r2Storage.close()`)
3. Resend : aucune ressource fermable

### Resend — aucune ressource fermable

Le SDK Resend (v6.18.1) est HTTP-based sans connexion persistante — aucune
méthode `destroy()` ou `close()` n'existe. La phrase ADR-015 « fermer le client
Resend » (section §8) est corrigée : Resend n'a pas de ressource fermable. Le
shutdown ne tente donc aucun appel sur le sender.

### `R2ObjectStorage.close()`

`R2ObjectStorage` gagne une méthode étroite `close()` qui appelle
`S3Client.destroy()` — cela ne modifie PAS le port métier `ObjectStorage`.
L'interface `S3ClientLike` est mise à jour avec une méthode optionnelle
`destroy?()`.

### Échec de construction partielle

Les factories de ressources sont injectables (`WorkerResourceFactories`). Si
une factory échoue après que des ressources ont été créées, toutes les
ressources déjà ouvertes sont fermées (DB via `end()`, R2 via `close()`). Tous
les cleanups sont tentés même si l'un échoue. L'erreur est normalisée en
`WorkerConfigurationError` générique sans exposer l'erreur brute, la stack,
l'URL ou une valeur sensible.

L'environnement est injectable via `CreateWorkerDependenciesOptions.env` pour
éviter de modifier globalement `process.env` dans les tests.

### Injection de factories pour tests

Le code définit `defaultResourceFactories` contenant les vraies implémentations
production (`createDatabase`, `R2ObjectStorage`, `ResendTransactionalEmailSender`,
`PdfLibDocumentRenderer`, `ConsoleWorkerLogger`, `InMemoryMetricsCollector`). La
fonction `createWorkerDependenciesFromEnv` utilise le pattern
`{ ...defaultResourceFactories, ...options?.factories }` :

- Sans `options.factories` (production) : seules les implémentations réelles sont
  utilisées. Le chemin production n'utilise jamais de fake.
- Avec `options.factories` (tests) : les factories fournies remplacent
  partiellement les implémentations réelles par des fakes contrôlés.

Cela garantit que le chemin de production n'utilise jamais de fake, tout en
permettant une injection complète pour les tests.

### Shutdown concurrent via Promise mémorisée

Le shutdown utilise une Promise mémorisée (`createShutdownFn`). Tous les appels
concurrents reçoivent la même Promise. DB et R2 ne sont fermés qu'une seule fois,
même si `shutdown()` est appelé plusieurs fois en parallèle.

### `R2ObjectStorage.close()` — idempotence réelle

`R2ObjectStorage` gagne un flag privé `closed`. La méthode `close()` n'appelle
`S3Client.destroy()` qu'une seule fois, même si elle est appelée plusieurs fois.
Cela ne modifie PAS le port métier `ObjectStorage`. L'interface `S3ClientLike`
est mise à jour avec une méthode optionnelle `destroy?()`.

### `startWorker()`

Fonction injectable pour tests :

- accepte `intervalMs`, `batchLimit`, `signal` (AbortSignal externe),
  `createRuntime` (factory injectable), `signalSource` (source de signaux
  injectable, `SignalSource`) et `runLoop` (boucle injectable) ;
- branche `SIGTERM`/`SIGINT` sur un `AbortController` interne AVANT
  `createRuntime()` pour qu'un signal reçu pendant la construction asynchrone
  soit mémorisé ;
- si un signal est reçu pendant `createRuntime()`, la boucle n'est pas démarrée
  et le shutdown est exécuté ;
- le cleanup s'exécute dans un bloc `finally` ;
- les listeners sont retirés après shutdown ;
- le listener du signal externe (`AbortSignal`) est nommé et retiré dans le
  bloc `finally` via `removeEventListener` ;
- `process.exitCode` est utilisé (pas de `process.exit()` dans le chemin normal) ;
- aucun effet de bord au chargement du module.

## 10. Conséquences

- pdf-lib est inactif depuis 2022 : risque de sécurité et de maintenance.
  Mitigation : version pinée, monitoring, plan de migration.
- Pas de tableaux natifs : layout manuel. Mitigation : primitives pdf-lib
  suffisent pour les 3 templates techniques.
- Polices embarquées augmentent la taille du dépôt d'environ 100-300 KB par
  police. Acceptable.
- Le renderer ne dépend d'aucune ressource réseau : compatible avec un
  conteneur minimal.
- Le workaround esbuild consiste à ajouter `mainFields: ['module', 'main']`
  dans la configuration de build (`build.mjs`), forçant esbuild à préférer le
  champ `module` de pdf-lib qui contient le code ESM. pdf-lib est bundled par
  esbuild (non ajouté au tableau `external`) car c'est une dépendance pure
  JavaScript sans nécessité de `node_modules` au runtime. Cette configuration a
  été appliquée en B2 (et non reportée à B4) car elle était nécessaire pour le
  test de reproductibilité source/dist : le rendu depuis `dist` doit produire
  les mêmes octets que le rendu source, ce qui exige un bundle esbuild
  fonctionnel incluant pdf-lib et `@pdf-lib/fontkit`.
- **Police Inter au runtime Docker (G5I-A)** : le renderer charge la police TTF
  depuis le disque au runtime via `readFileSync` depuis un chemin dérivé de
  `import.meta.url` (pas d'inlining esbuild). Depuis `dist/index.js`, le chemin
  résolu est `../assets/fonts/inter-regular.ttf`. L'image Docker production
  (`Dockerfile.worker`) copie donc `apps/worker/assets/fonts/` vers
  `/app/assets/fonts/` pour que le renderer trouve la police au runtime. Sans ce
  fichier, le rendu PDF échoue avec `DocumentRenderError('VALIDATION')`.
