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

  return db.transaction(async (tx) => {
    // Recherche par oidc_subject d'abord.
    const [bySubject] = await tx
      .select()
      .from(users)
      .where(eq(users.oidcSubject, input.oidcSubject))
      .limit(1);

    if (bySubject) {
      return mapUser(bySubject);
    }

    // Sinon, recherche par email (un utilisateur peut avoir été invité / créé).
    // Le verrou sérialise les liaisons concurrentes sur un utilisateur existant.
    const [byEmail] = await tx
      .select()
      .from(users)
      .where(eq(users.email, email))
      .for('update')
      .limit(1);

    if (byEmail) {
      // Relie le compte à l'identité OIDC.
      const [updated] = await tx
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

    // Sinon, crée l'utilisateur. Sans cible explicite, PostgreSQL ignore un
    // conflit sur email ou oidc_subject, les deux colonnes étant uniques.
    const [created] = await tx
      .insert(users)
      .values({
        email,
        oidcSubject: input.oidcSubject,
        oidcProvider: input.oidcProvider,
        emailVerifiedAt: input.emailVerified ? new Date() : null,
        displayName: input.displayName ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return mapUser(created);

    // Une autre transaction a gagné l'insertion. Relire dans le même ordre
    // métier pour retourner le même utilisateur sans violer une contrainte.
    const [winnerBySubject] = await tx
      .select()
      .from(users)
      .where(eq(users.oidcSubject, input.oidcSubject))
      .limit(1);
    if (winnerBySubject) return mapUser(winnerBySubject);

    const [winnerByEmail] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
    if (winnerByEmail) return mapUser(winnerByEmail);

    throw new Error('Échec de création utilisateur.');
  });
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
