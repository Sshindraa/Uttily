# Architecture technique

## Décision actuelle

Uttily démarre comme un **monolithe modulaire TypeScript**. L'interface et les endpoints HTTP vivent dans Next.js. Le domaine métier est isolé de Next.js afin de pouvoir introduire une API NestJS ou une application mobile sans réécriture des règles métier.

```text
apps/
  web/                 Interface, Server Components et Route Handlers
  worker/              Consommation d'outbox, emails, documents, webhooks différés

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
| Base transactionnelle | PostgreSQL managé + PostGIS |
| Fichiers | Stockage objet compatible S3 |
| Paiement marketplace | Stripe Connect |
| Identité | Fournisseur OIDC ; autorisation métier dans Uttily |
| Traitement différé | Outbox PostgreSQL + worker |
| Erreurs | Sentry ou équivalent |
| Déploiement | Environnements dev, staging et production séparés |

Redis peut être ajouté pour le cache, la limitation de débit ou des tâches rapides. Il n'est jamais l'autorité de disponibilité.

## Évolution prévue

Une API NestJS est ajoutée uniquement lorsqu'une API publique, une application mobile, des partenaires ou des cycles de déploiement indépendants le justifient. AWS complet, SQS, Redis managé et OpenTelemetry arrivent lorsque la charge ou l'équipe le nécessite.

## Règles transversales

- Montants en unités mineures entières et devise ISO 4217.
- Horodatages stockés en UTC ; fuseau du lieu conservé séparément.
- Clés d'idempotence pour les mutations critiques.
- Journal d'audit append-only pour les actions sensibles.
- Données financières et snapshots tarifaires immuables après confirmation.
- Toute communication secondaire est déclenchée par événement d'outbox.
