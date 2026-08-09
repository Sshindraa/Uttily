# Architecture technique

## Décision actuelle

Uttily démarre comme un **monolithe modulaire TypeScript**. L'interface et les endpoints HTTP vivent dans Next.js. Le domaine métier est isolé de Next.js afin de pouvoir introduire une API NestJS ou une application mobile sans réécriture des règles métier.

```text
apps/
  web/                 Interface, Server Components et Route Handlers
  worker/              Consommation d'outbox, emails, documents, webhooks différés. Architecture détaillée dans ADR-013. Worker G5F implémenté et validé. Suite worker : 449 tests au total avec PostgreSQL local (407 passed, 42 skipped sans DATABASE_URL), 0 failed. Artefact Node exécutable (esbuild bundle, `node dist/index.js`). Bundle smoke-testé via harness local (G5H-C2C-B4). Fournisseurs de production choisis par ADR-014 (Cloudflare R2 stockage, Resend email) ; adapter R2 implémenté, testé G5H-A et câblé au worker G5H-C2C-B3 ; adapter Resend implémenté, testé G5H-B et câblé au worker G5H-C2C-B3 ; politique retry < 24 h livrée G5H-C. Packaging local Docker implémenté et validé (statique + runtime G5I-B) : build, inspection, smoke, Compose, démarrage PostgreSQL éphémère + SIGTERM.

packages/
  core/                Modules métier et cas d'utilisation
  database/            Schéma PostgreSQL, migrations et accès aux données
  contracts/           DTO, validation et contrats d'événements
  auth/                Vérification d'identité et autorisations
  ui/                  Design system
  config/              Configuration partagée
```

## Modules métier initiaux

```text
Identity & Organizations
Catalog & Inventory
Availability
Pricing
Bookings
Payments & Deposits
Fulfillment & Maintenance
Notifications & Documents
```

Un module expose une interface publique. Aucun autre module n'importe directement ses détails d'infrastructure ou ses tables internes.

## Infrastructure MVP

| Besoin | Choix |
| --- | --- |
| Base transactionnelle | PostgreSQL managé + PostGIS (Neon, ADR-005) |
| Fichiers | Stockage objet compatible S3 — Cloudflare R2 juridiction `eu` (ADR-014) |
| Paiement marketplace | Stripe Connect |
| Identité | Fournisseur OIDC ; autorisation métier dans Uttily |
| Traitement différé | Outbox PostgreSQL + worker (VPS DigitalOcean Frankfurt, ADR-014) |
| Email transactionnel | Resend (ADR-014) |
| Erreurs | Sentry ou équivalent |
| Déploiement | Environnements dev, staging et production séparés |

Redis peut être ajouté pour le cache, la limitation de débit ou des tâches rapides. Il n'est jamais l'autorité de disponibilité.

### Recherche publique et carte (G7E)

La recherche publique reste un read model informatif servi par Next.js et
PostgreSQL/PostGIS. G7E-B ajoute une carte MapLibre côté client alimentée par
MapTiler Streets via une clé publique d'environnement ; la liste accessible et
PostgreSQL restent utilisables et autoritaires lorsque la carte est indisponible.
Le contrat viewport, la classification des alternatives et la frontière de
sécurité sont détaillés dans ADR-021.

### Dashboard loueur (G7G)

G7G est implémenté : le dashboard organisation expose une projection read-only
bornée des exemplaires `BROKEN` et des blocs `MAINTENANCE` actifs ou à venir dans
les 24 heures, avec isolation par organisation, ordre déterministe et fuseau
IANA de l'établissement.

## Évolution prévue

Une API NestJS est ajoutée uniquement lorsqu'une API publique, une application mobile, des partenaires ou des cycles de déploiement indépendants le justifient. AWS complet, SQS, Redis managé et OpenTelemetry arrivent lorsque la charge ou l'équipe le nécessite.

## Direction long terme : option C

ADR-019 fixe la direction stratégique : Uttily évolue progressivement vers une
infrastructure mondiale de l'accès au matériel, sans transformer cette ambition
en périmètre MVP immédiat.

L'architecture doit pouvoir soutenir quatre capacités futures :

- `Equipment Graph` : connaissance structurée des usages et compatibilités ;
- `Digital Equipment Passport` : histoire vérifiable de chaque exemplaire ;
- `Rental Intelligence` : recommandations explicables pour clients et loueurs ;
- `Agent-ready Commerce` : distribution via partenaires et agents autorisés.

Ces capacités restent modulaires. PostgreSQL et les use cases demeurent
l'autorité transactionnelle. Les modèles d'IA sont des dépendances
interchangeables derrière des ports explicites ; ils ne décident jamais seuls
de la disponibilité, d'un prix publié, d'une facturation de dommage ou d'une
règle de sécurité. Les contrats structurés et versionnés doivent être
réutilisables par l'interface Web, de futures API et de futurs agents sans
dupliquer la logique métier.

## Règles transversales

- Montants en unités mineures entières et devise ISO 4217.
- Horodatages stockés en UTC ; fuseau du lieu conservé séparément.
- Clés d'idempotence pour les mutations critiques.
- Journal d'audit append-only pour les actions sensibles.
- Données financières et snapshots tarifaires immuables après confirmation.
- Toute communication secondaire est déclenchée par événement d'outbox.
- Tarification flexible par durée (ADR-018, conception) : la tarification
  horaire, forfaitaire et journalière via des plans tarifaires
  (`HOURLY`/`FIXED_DURATION`/`DAILY`) est planifiée. Le moteur tarifaire est
  déterministe, auditable et figé dans le snapshot. Le modèle daily-only
  actuel reste en place tant que la migration tarifaire future n'est pas
  livrée.

## Activation pays progressive

> Arbitrage produit du 2026-08-07. Voir `docs/product/lot7-arbitrage.md` et
> ADR-018.

Le premier pays activé est la France. L'architecture permet une activation
progressive : autres pays européens puis reste du monde. Aucun pays n'est codé
en dur dans le Core. L'activation d'un pays est explicite et fail-closed : la
table `countries` (migration 0031, G7C-R3) porte un drapeau `is_active` DEFAULT
false — aucun pays n'est actif par installation. L'activation d'une destination
requiert un pays actif et les traductions FR+EN (trigger
`check_destination_activation`). EUR uniquement au lancement ; l'architecture
monétaire est compatible avec plusieurs devises, mais aucune conversion n'est
implémentée dans le premier MVP.
