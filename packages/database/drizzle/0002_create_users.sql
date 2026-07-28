-- Migration 0002 : table users.
-- Identité synchronisée depuis Clerk (ADR-006). Uttily reste source de vérité
-- des rôles et appartenances (organization_memberships).

CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "email_verified_at" timestamp with time zone,
  "display_name" text,
  "locale" text NOT NULL DEFAULT 'fr',
  "is_platform_admin" boolean NOT NULL DEFAULT false,
  "oidc_subject" text,
  "oidc_provider" text,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "users_email_unique" UNIQUE ("email"),
  CONSTRAINT "users_oidc_subject_unique" UNIQUE ("oidc_subject"),
  CONSTRAINT "users_email_not_empty" CHECK (length(btrim("email")) > 0)
);

CREATE INDEX "users_email_index" ON "users" ("email");
CREATE INDEX "users_oidc_subject_index" ON "users" ("oidc_subject");
