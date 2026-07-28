# ADR-006 — Authentification via Clerk (OIDC)

- **Statut** : accepté
- **Date** : 2026-07-27

## Contexte

Uttily a besoin d'une identité fiable pour les clients et les membres d'organisations loueurs. L'architecture (cf. `overview.md`) prévoit un fournisseur OIDC externe pour l'identité, avec une autorisation métier conservée dans PostgreSQL. `open-questions.md` exigeait une décision sur le fournisseur OIDC avant le Lot 1.

## Décision

Utiliser **Clerk** comme fournisseur d'identité et de gestion des sessions pour l'application Next.js.

## Règles non négociables

- Clerk gère **uniquement l'identité** : authentification, sessions, vérification d'email, gestion des credentials.
- **Uttily reste la source de vérité** pour `users`, `organizations`, `organization_memberships`, les rôles (`OWNER`, `ADMIN`, `MANAGER`, `STAFF`) et les permissions.
- Les Organizations et rôles Clerk ne sont **jamais** utilisés comme autorité métier.
- À la première connexion authentifiée via Clerk, Uttily crée ou réutilise un `users` avec `oidc_subject` (Clerk user id) et `oidc_provider = 'clerk'`.
- Les rôles métier sont déterminés dans `packages/core` à partir de `organization_memberships`, jamais depuis le token Clerk.

## Raisons

- Intégration native Next.js (App Router, Server Components, middleware).
- OIDC conforme, gestion des sessions sécurisée, MFA, vérification d'email.
- Charge opérationnelle réduite : pas de gestion de mots de passe côté Uttily.
- Aucune donnée de carte bancaire ni credential sensible stockée par Uttily.

## Conséquences

- Dépendance à un service SaaS externe pour l'identité ; un ADR distinct sera requis pour toute migration future.
- Les variables d'environnement Clerk (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`) sont fournies via Vercel ; aucune ne est versionnée.
- L'admin Uttily (`is_platform_admin`) reste positionné manuellement en base avec audit ; Clerk ne détermine jamais ce statut.
- La suppression logique d'un `users` n'impacte pas immédiatement la session Clerk ; la réconciliation est assurée par webhook `user.deleted` (introduit au Lot 1 de manière minimale).

## Non retenu

- Auth0, WorkOS, Keycloak auto-hébergé : viables mais moins intégrés à Next.js pour le démarrage.
- Authentification maison : écarte toute responsabilité de gestion de credentials.
