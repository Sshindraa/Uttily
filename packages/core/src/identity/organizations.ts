import { eq, and, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { organizations, organizationMemberships } from '@uttily/database';
import { isValidSlug, slugify } from './slug';
import type { AuthenticatedUser, OrganizationRecord } from './types';
import { AuthorizationError } from './permissions';

export interface CreateOrganizationInput {
  legalName: string;
  slug?: string;
  defaultCurrency?: string;
}

export interface OrganizationRepository {
  findBySlug(slug: string): Promise<OrganizationRecord | null>;
  findById(id: string): Promise<OrganizationRecord | null>;
  insert(
    data: CreateOrganizationInput & { slug: string; defaultCurrency: string },
  ): Promise<OrganizationRecord>;
}

/**
 * Crée une organisation et la membership OWNER de l'utilisateur courant
 * en une seule transaction (invariant : atomicité).
 */
export async function createOrganizationForUser(
  db: DatabaseClient,
  user: AuthenticatedUser,
  input: CreateOrganizationInput,
): Promise<{ organization: OrganizationRecord }> {
  const legalName = input.legalName.trim();
  if (legalName.length < 2) {
    throw new Error('La raison sociale doit faire au moins 2 caractères.');
  }
  const slug = input.slug ? input.slug : slugify(legalName);
  if (!isValidSlug(slug)) {
    throw new Error('Slug invalide.');
  }
  const defaultCurrency = input.defaultCurrency ?? 'EUR';
  if (defaultCurrency.length !== 3) {
    throw new Error('Devise invalide (ISO 4217, 3 lettres).');
  }

  return await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    if (existing.length > 0) {
      throw new Error('Ce slug est déjà utilisé.');
    }

    const [org] = await tx
      .insert(organizations)
      .values({
        legalName,
        slug,
        defaultCurrency,
        isProfessional: true,
        status: 'ACTIVE',
      })
      .returning();
    if (!org) throw new Error('Échec de création de l\u2019organisation.');

    await tx.insert(organizationMemberships).values({
      organizationId: org.id,
      userId: user.id,
      role: 'OWNER',
      status: 'ACTIVE',
      acceptedAt: new Date(),
    });

    return { organization: mapOrganization(org) };
  });
}

/**
 * Liste les organisations dont l'utilisateur est membre actif.
 */
export async function listOrganizationsForUser(
  db: DatabaseClient,
  userId: string,
): Promise<OrganizationRecord[]> {
  const rows = await db
    .select({
      id: organizations.id,
      legalName: organizations.legalName,
      slug: organizations.slug,
      status: organizations.status,
      isProfessional: organizations.isProfessional,
      defaultCurrency: organizations.defaultCurrency,
    })
    .from(organizations)
    .innerJoin(
      organizationMemberships,
      and(
        eq(organizationMemberships.organizationId, organizations.id),
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, 'ACTIVE'),
        isNull(organizations.deletedAt),
      ),
    );
  return rows as OrganizationRecord[];
}

export async function getOrganizationBySlug(
  db: DatabaseClient,
  slug: string,
): Promise<OrganizationRecord | null> {
  const [row] = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.slug, slug), isNull(organizations.deletedAt)))
    .limit(1);
  return row ? mapOrganization(row) : null;
}

function mapOrganization(row: typeof organizations.$inferSelect): OrganizationRecord {
  return {
    id: row.id,
    legalName: row.legalName,
    slug: row.slug,
    status: row.status,
    isProfessional: row.isProfessional,
    defaultCurrency: row.defaultCurrency,
  };
}

/**
 * Met à jour une organisation. Réservé à l'OWNER.
 */
export async function updateOrganization(
  db: DatabaseClient,
  organizationId: string,
  input: { legalName?: string; defaultCurrency?: string },
): Promise<OrganizationRecord> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.legalName !== undefined) {
    const name = input.legalName.trim();
    if (name.length < 2) throw new Error('Raison sociale trop courte.');
    patch.legalName = name;
  }
  if (input.defaultCurrency !== undefined) {
    if (input.defaultCurrency.length !== 3) {
      throw new Error('Devise invalide.');
    }
    patch.defaultCurrency = input.defaultCurrency;
  }
  const [row] = await db
    .update(organizations)
    .set(patch)
    .where(eq(organizations.id, organizationId))
    .returning();
  if (!row) throw new AuthorizationError('Organisation introuvable.');
  return mapOrganization(row);
}
