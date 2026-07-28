-- Migration 0004 : table organization_memberships.
-- Porte le rôle métier (OWNER, ADMIN, MANAGER, STAFF).
-- Uttily est la source de vérité des rôles (ADR-006, invariants §1).

DO $$ BEGIN
  CREATE TYPE "membership_role" AS ENUM('OWNER', 'ADMIN', 'MANAGER', 'STAFF');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "membership_status" AS ENUM('ACTIVE', 'SUSPENDED', 'REMOVED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "organization_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "role" "membership_role" NOT NULL,
  "status" "membership_status" NOT NULL DEFAULT 'ACTIVE',
  "invited_by" uuid,
  "accepted_at" timestamp with time zone,
  "removed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Un utilisateur a au plus une membership par organisation.
-- La contrainte composite UNIQUE est déclarée ici en SQL explicite.
ALTER TABLE "organization_memberships"
  ADD CONSTRAINT "memberships_organization_user_unique"
  UNIQUE ("organization_id", "user_id");

ALTER TABLE "organization_memberships"
  ADD CONSTRAINT "memberships_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;

ALTER TABLE "organization_memberships"
  ADD CONSTRAINT "memberships_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade;

ALTER TABLE "organization_memberships"
  ADD CONSTRAINT "memberships_invited_by_users_id_fk"
  FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE set null;

CREATE INDEX "memberships_organization_id_index" ON "organization_memberships" ("organization_id");
CREATE INDEX "memberships_user_id_index" ON "organization_memberships" ("user_id");
