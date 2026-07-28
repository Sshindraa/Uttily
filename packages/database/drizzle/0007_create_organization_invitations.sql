-- Migration 0007 : table organization_invitations.
-- Table distincte : aucun utilisateur n'est créé avant l'acceptation.
-- Le token est stocké haché (jamais en clair).

DO $$ BEGIN
  CREATE TYPE "invitation_status" AS ENUM('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "organization_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "email" text NOT NULL,
  "role" "membership_role" NOT NULL,
  "token_hash" text NOT NULL,
  "status" "invitation_status" NOT NULL DEFAULT 'PENDING',
  "invited_by" uuid,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "accepted_by_user_id" uuid,
  "revoked_at" timestamp with time zone,
  "revoked_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "invitations_token_hash_unique" UNIQUE ("token_hash"),
  CONSTRAINT "invitations_email_not_empty" CHECK (length(btrim("email")) > 0)
);

ALTER TABLE "organization_invitations"
  ADD CONSTRAINT "invitations_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;

ALTER TABLE "organization_invitations"
  ADD CONSTRAINT "invitations_invited_by_users_id_fk"
  FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE set null;

ALTER TABLE "organization_invitations"
  ADD CONSTRAINT "invitations_accepted_by_user_id_users_id_fk"
  FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE set null;

ALTER TABLE "organization_invitations"
  ADD CONSTRAINT "invitations_revoked_by_users_id_fk"
  FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE set null;

CREATE INDEX "invitations_organization_id_index" ON "organization_invitations" ("organization_id");
CREATE INDEX "invitations_email_index" ON "organization_invitations" ("email");
CREATE INDEX "invitations_status_index" ON "organization_invitations" ("status");
