-- Migration 0009 : index unique partiel sur les invitations PENDING.
--
-- Empêche au niveau PostgreSQL les invitations PENDING en double pour
-- une même organisation et un même email. Un index unique partiel est
-- utilisé afin de n'imposer l'unicité que sur les invitations PENDING
-- (les invitations ACCEPTED/REVOKED/EXPIRED peuvent coexister pour
-- le même email, ce qui permet de réinviter après expiration/révocation).

CREATE UNIQUE INDEX "invitations_pending_org_email_unique"
  ON "organization_invitations" ("organization_id", "email")
  WHERE "status" = 'PENDING';
