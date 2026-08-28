# ADR-028 : Back-office Uttily & Support V1

## Statut

Accepté

## Contexte

Dans le cadre du lancement du pilote réel d'Uttily avec des loueurs professionnels, l'équipe interne Uttily doit être en mesure d'exploiter la plateforme, de diagnostiquer les incidents et de résoudre les blocages opérationnels (ex: notification transactionnelle échouée, anomalie de paiement, diagnostic de readiness loueur) sans nécessiter d'intervention manuelle directe sur la base de données de production.

Le back-office est destiné **exclusivement à l'équipe interne Uttily** et ne doit en aucun cas être accessible aux clients loueurs (même avec un rôle `OWNER` ou `ADMIN` au sein de leur organisation).

Il ne doit pas non plus devenir une deuxième application métier lourde : sa vocation est d'être un cockpit d'investigation dense, sûr et précis, fournissant une vue unifiée à 360° et n'exposant que des actions support strictement contrôlées et auditées.

## Décisions

### 1. Zone interne dédiée et modèle d'autorisation fail-closed

- Le back-office interne est isolé sous la route `/internal` (avec redirection/protection de `/admin`).
- L'accès est conditionné strictement au flag `users.is_platform_admin = true`.
- Aucun rôle de membership d'organisation (`OWNER`, `ADMIN`, `MANAGER`, `STAFF`) ne donne accès à `/internal`.
- Tout accès non authentifié ou non autorisé lève `UNAUTHENTICATED` ou `AuthorizationError('FORBIDDEN')` et échoue en mode fail-closed côté serveur.
- Contrôle en profondeur (*defense in depth*) : vérification dans le layout Next.js, dans chaque Server Component de lecture, et dans chaque Server Action de mutation via `requireSupportPlatformAdmin`.

### 2. Moteur de recherche globale multi-entités (`searchSupport`)

- Module Core dédié sous `@uttily/core/src/support`.
- Accepte des requêtes naturelles ou des identifiants exacts (UUIDs, slugs, emails, références de réservation, identifiants Stripe).
- Couvre 6 familles d'entités :
  1. Organisations (`legalName`, `publicDisplayName`, `slug`, `id`)
  2. Établissements (`name`, `city`, `postalCode`, `id`)
  3. Réservations (`id`, client email, client name)
  4. Utilisateurs / Clients (`email`, `displayName`, `id`)
  5. Paiements (`id`, `providerPaymentIntentId`, `organizationId`)
  6. Remboursements (`id`, `providerRefundId`, `bookingId`)

### 3. Fiches de diagnostic unifiées réutilisant les autorités du domaine

- **Fiche Organisation** : réutilise le moteur officiel de pilot readiness `getOrganizationOnboardingReadiness`, l'état de synchronisation Stripe Connect (`organizationPaymentAccounts`), l'inventaire physique (`inventoryItems`), les membres et les incidents opérationnels (`maintenanceCases`, `damageReports`).
- **Fiche Réservation** : assemble une **timeline métier chronologique lisible** (création brouillon → hold → confirmation paiement → préparation → retrait → restitution/clôture ou annulation/remboursement), détaille les composants financiers (prix, suppléments, remboursements, solde final), les exemplaires alloués et les diagnostics d'emails transactionnels.
- **Fiche Paiements / Remboursements** : expose les montants réels en centimes (unités mineures), les PaymentIntents et les remboursements réels sans masquer les anomalies ni afficher de faux succès.
- **Console Notifications & Invitations** : expose l'état du cycle d'envoi (`PENDING`, `SENDING`, `SENT`, `FAILED`, `CANCELLED`), les codes d'erreur, le nombre de tentatives et le flag `requiresManualReview`.

### 4. Zéro fuite de données sensibles

- `INVITATION_SECRET`, tokens bruts d'invitation, clés secrètes API ou mots de passe ne sont **jamais** exposés dans les vues de support ni dans les journaux d'audit.
- Les identifiants retournés pour le support sont des identifiants fonctionnels sûrs.

### 5. Actions support V1 sûres, idempotentes et auditées

- Aucune mise à jour SQL arbitraire dans l'interface ("pas d'éditeur de base de données").
- Actions support V1 autorisées :
  1. `retryNotificationSupport` : ré-enfilement d'une notification en échec (`PENDING`) avec remise à zéro du lease et du compteur d'erreurs, validé et consigné dans `audit_log`.
  2. `cancelNotificationSupport` : annulation explicite d'une notification non envoyée + consigne dans `audit_log`.
  3. `resendInvitationNotificationSupport` : ré-émission de la notification d'une invitation en attente sans régénération non autorisée de secret + consigne dans `audit_log`.
  4. `reconcilePaymentSupportAction` : déclenchement du flux officiel de réconciliation Stripe pour synchroniser l'état.
- Chaque mutation enregistre une ligne dans la table append-only `audit_log` avec `actorUserId`, `action`, `targetType`, `targetId` et `metadata: { reason, ... }`.

## Conséquences

- L'équipe support Uttily dispose d'un outil opérationnel complet et sûr pour le lancement du pilote.
- L'espace Pro loueur reste totalement découplé et intact.
- Les invariants de sécurité multi-tenant et de non-exposition des secrets sont garantis par construction et testés automatiquement.
