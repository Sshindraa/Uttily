import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const TEST_ORGANIZATION_SLUG = 'test-org-dev';

export function isBrowserE2eEnvironment(environment = process.env) {
  return (
    environment?.UTTILY_BROWSER_E2E === '1' &&
    environment?.NODE_ENV !== 'production' &&
    typeof environment?.E2E_CLERK_USER_EMAIL === 'string' &&
    environment.E2E_CLERK_USER_EMAIL.trim().length > 0
  );
}

export function assertBrowserE2eEnvironment(environment = process.env) {
  if (!isBrowserE2eEnvironment(environment)) {
    throw new Error(
      'Le fixture membership E2E exige UTTILY_BROWSER_E2E=1, un environnement non production et E2E_CLERK_USER_EMAIL.',
    );
  }

  if (!/^[^\s@+]+\+clerk_test@[^\s@]+$/i.test(environment.E2E_CLERK_USER_EMAIL.trim())) {
    throw new Error('E2E_CLERK_USER_EMAIL doit être une adresse Clerk de test dédiée.');
  }
}

function resolveLocalDatabaseUrl(environment = process.env) {
  const databaseUrl = environment.DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() !== databaseUrl) {
    throw new Error('DATABASE_URL doit pointer vers PostgreSQL local.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL doit pointer vers PostgreSQL local.');
  }

  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !['postgres:', 'postgresql:'].includes(parsedUrl.protocol) ||
    !LOCAL_DATABASE_HOSTS.has(hostname)
  ) {
    throw new Error('DATABASE_URL doit pointer vers PostgreSQL local.');
  }

  return databaseUrl;
}

export async function ensureBrowserE2eMembership(environment = process.env) {
  assertBrowserE2eEnvironment(environment);
  const email = environment.E2E_CLERK_USER_EMAIL.trim().toLowerCase();
  const sql = postgres(resolveLocalDatabaseUrl(environment), { max: 1 });

  try {
    await sql.begin(async (tx) => {
      const users = await tx`
        SELECT "id"
        FROM "users"
        WHERE "email" = ${email}
          AND "deleted_at" IS NULL
          AND "oidc_provider" = 'clerk'
          AND "oidc_subject" IS NOT NULL
        LIMIT 1
        FOR UPDATE
      `;
      if (users.length !== 1) {
        throw new Error('Utilisateur Clerk E2E non provisionné dans la base locale.');
      }

      const organizations = await tx`
        SELECT "id"
        FROM "organizations"
        WHERE "slug" = ${TEST_ORGANIZATION_SLUG}
          AND "status" = 'ACTIVE'
          AND "deleted_at" IS NULL
        LIMIT 1
        FOR UPDATE
      `;
      if (organizations.length !== 1) {
        throw new Error('Organisation de test absente de la base locale.');
      }

      const userId = users[0].id;
      const organizationId = organizations[0].id;
      const memberships = await tx`
        SELECT "id"
        FROM "organization_memberships"
        WHERE "organization_id" = ${organizationId}
          AND "user_id" = ${userId}
        LIMIT 1
        FOR UPDATE
      `;

      if (memberships.length === 0) {
        await tx`
          INSERT INTO "organization_memberships" (
            "organization_id", "user_id", "role", "status", "accepted_at"
          )
          VALUES (${organizationId}, ${userId}, 'OWNER', 'ACTIVE', now())
        `;
      } else {
        await tx`
          UPDATE "organization_memberships"
          SET
            "role" = 'OWNER',
            "status" = 'ACTIVE',
            "accepted_at" = COALESCE("accepted_at", now()),
            "removed_at" = NULL,
            "updated_at" = now()
          WHERE "id" = ${memberships[0].id}
        `;
      }
    });
  } finally {
    await sql.end();
  }
}

function isMainModule() {
  return (
    process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
  );
}

if (isMainModule()) {
  ensureBrowserE2eMembership()
    .then(() => {
      console.log('Browser E2E membership fixture applied.');
    })
    .catch(() => {
      console.error('Browser E2E membership fixture failed.');
      process.exitCode = 1;
    });
}
