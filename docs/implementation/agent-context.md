# Contexte d'implémentation pour les agents

## Ce qui est construit

Le premier produit Uttily permet à un client de rechercher, réserver, payer puis récupérer un équipement auprès d'un loueur professionnel. Le loueur peut administrer son entreprise, ses établissements, son catalogue, ses exemplaires physiques et ses opérations de location.

Le produit ne cherche pas encore à couvrir toutes les catégories, tous les pays ni la location entre particuliers.

## Personae et permissions

| Persona | Peut faire |
| --- | --- |
| Visiteur | Rechercher et consulter l'offre publique. |
| Client | Réserver, payer, consulter ou annuler selon la politique applicable. |
| Owner | Gérer son organisation, ses établissements, son équipe et son activité. |
| Admin loueur | Gérer catalogue, prix, réservations et employés selon ses droits. |
| Employé | Préparer, remettre, réceptionner et signaler un problème sur le matériel. |
| Admin Uttily | Assister et administrer la plateforme selon un accès audité. |

Un même utilisateur peut être client et membre de plusieurs organisations. Les rôles sont déterminés dans la base Uttily, jamais uniquement dans le fournisseur d'identité.

## Modules initiaux

| Module | Responsabilité |
| --- | --- |
| Identity & Organizations | Utilisateurs, organisations, membres, rôles et établissements. |
| Catalog & Inventory | Produits, variantes, photos et exemplaires physiques. |
| Availability | Blocages, maintenance, recherche d'exemplaires et concurrence. |
| Pricing | Règles de prix, taxes, options et snapshots. |
| Bookings | Brouillons, holds, réservations, annulations et transitions d'état. |
| Payments & Deposits | Paiements, webhooks, remboursements, cautions et journal financier. |
| Fulfillment & Maintenance | Retrait, retour, état, dommages, retard et maintenance. |
| Notifications & Documents | Emails, contrats, reçus, QR codes et outbox. |

## Stack de départ

- Next.js et TypeScript pour l'interface, le rendu serveur et les endpoints.
- PostgreSQL + PostGIS pour les données et la recherche géographique.
- ORM à choisir au premier lot, avec migrations SQL inspectables.
- Stockage objet compatible S3 pour photos et documents.
- Stripe Connect pour les paiements ; aucune carte bancaire n'est stockée par Uttily.
- Fournisseur OIDC (Clerk — ADR-006) pour l'identité ; autorisation métier dans PostgreSQL.
- Outbox PostgreSQL et worker séparé pour les tâches différées.

## Contrat de données

- Tous les montants : `amount_minor` entier et `currency` ISO 4217.
- Tous les instants : UTC. Chaque établissement possède un `time_zone` IANA.
- Toutes les tables liées à un loueur portent `organization_id`.
- Les identifiants sont des UUID v4 générés par PostgreSQL via `gen_random_uuid()`.
- Les documents, appels de paiement et webhooks conservent la référence du fournisseur externe.
- Les snapshots de réservation et les écritures du registre financier sont immuables.

## Définition de terminé

Une tâche est terminée lorsque :

1. ses critères du backlog sont satisfaits ;
2. les autorisations serveur sont appliquées ;
3. les tests appropriés passent ;
4. aucune règle de concurrence ou de multi-tenant n'est contournée ;
5. la documentation et les migrations sont à jour ;
6. le changement reste dans le périmètre du MVP.
