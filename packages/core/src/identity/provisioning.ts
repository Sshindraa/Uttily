import { eq } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { users } from '@uttily/database';
import type { AuthenticatedUser } from './types';

/**
 * Provisioning d'un utilisateur Uttily depuis l'identité Clerk (ADR-006).
 *
 * À la première connexion authentifiée, Uttily crée un `users` avec
 * oidc_subject + oidc_provider + email. Si l'utilisateur existe déjà
 * (par oidc_subject ou email), il est réutilisé.
 *
 * Uttily reste la source de vérité des rôles et appartenances.
 */
export async function provisionUserFromOidc(
  db: DatabaseClient,
  input: {
    oidcSubject: string;
    oidcProvider: string;
    email: string;
    emailVerified: boolean;
    displayName?: string | null;
  },
): Promise<AuthenticatedUser> {
  const email = input.email.trim().toLowerCase();

  // Recherche par oidc_subject d'abord.
  const [bySubject] = await db
    .select()
    .from(users)
    .where(eq(users.oidcSubject, input.oidcSubject))
    .limit(1);

  if (bySubject) {
    return mapUser(bySubject);
  }

  // Sinon, recherche par email (un utilisateur peut avoir été invité / créé).
  const [byEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (byEmail) {
    // Relie le compte à l'identité OIDC.
    const [updated] = await db
      .update(users)
      .set({
        oidcSubject: input.oidcSubject,
        oidcProvider: input.oidcProvider,
        emailVerifiedAt: input.emailVerified ? new Date() : byEmail.emailVerifiedAt,
        updatedAt: new Date(),
      })
      .where(eq(users.id, byEmail.id))
      .returning();
    if (!updated) throw new Error('Échec de mise à jour utilisateur.');
    return mapUser(updated);
  }

  // Sinon, crée l'utilisateur.
  const [created] = await db
    .insert(users)
    .values({
      email,
      oidcSubject: input.oidcSubject,
      oidcProvider: input.oidcProvider,
      emailVerifiedAt: input.emailVerified ? new Date() : null,
      displayName: input.displayName ?? null,
    })
    .returning();
  if (!created) throw new Error('Échec de création utilisateur.');
  return mapUser(created);
}

function mapUser(row: typeof users.$inferSelect): AuthenticatedUser {
  return {
    id: row.id,
    oidcSubject: row.oidcSubject ?? '',
    email: row.email,
    emailVerified: row.emailVerifiedAt !== null,
    isPlatformAdmin: row.isPlatformAdmin,
  };
}
