import { eq, and, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { organizations, organizationMemberships, auditLog } from '@uttily/database';
import { isValidSlug, slugify } from './slug';
import type { AuthenticatedUser, OrganizationRecord } from './types';
import { AuthorizationError } from './permissions';
import type { CancellationPolicyCode } from '../cancellations/types';

export interface CreateOrganizationInput {
  legalName: string;
  slug?: string;
  defaultCurrency?: string;
  proTermsAccepted?: boolean;
  proTermsVersion?: string;
}

export interface OrganizationRepository {
  findBySlug(slug: string): Promise<OrganizationRecord | null>;
  findById(id: string): Promise<OrganizationRecord | null>;
  insert(
    data: CreateOrganizationInput & { slug: string; defaultCurrency: string },
  ): Promise<OrganizationRecord>;
}

/** Devise du périmètre pilote ; l'architecture multi-devise reste future. */
export const MVP_ORGANIZATION_CURRENCY = 'EUR' as const;

export function normalizeMvpOrganizationCurrency(input?: string): string {
  const currency = (input ?? MVP_ORGANIZATION_CURRENCY).trim().toUpperCase();
  if (currency !== MVP_ORGANIZATION_CURRENCY) {
    throw new Error(
      `Devise non supportée au MVP : ${currency}. EUR est la seule devise disponible.`,
    );
  }
  return currency;
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
  const defaultCurrency = normalizeMvpOrganizationCurrency(input.defaultCurrency);

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

    const proTermsVersion = input.proTermsVersion ?? 'v1';
    await tx.insert(auditLog).values({
      actorUserId: null,
      action: 'ORGANIZATION_PRO_TERMS_ACCEPTED',
      targetType: 'ORGANIZATION',
      targetId: org.id,
      metadata: {
        actorUserId: user.id,
        proTermsVersion,
        acceptedAt: new Date().toISOString(),
        legalName,
      },
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
      publicDisplayName: organizations.publicDisplayName,
      slug: organizations.slug,
      status: organizations.status,
      isProfessional: organizations.isProfessional,
      defaultCurrency: organizations.defaultCurrency,
      defaultCancellationPolicyCode: organizations.defaultCancellationPolicyCode,
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
  return rows.map(mapOrganization);
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

export async function getOrganizationById(
  db: DatabaseClient,
  id: string,
): Promise<OrganizationRecord | null> {
  const [row] = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, id), isNull(organizations.deletedAt)))
    .limit(1);
  return row ? mapOrganization(row) : null;
}

type OrganizationQueryRow = {
  id: string;
  legalName: string;
  publicDisplayName?: string | null;
  slug: string;
  status: (typeof organizations.$inferSelect)['status'];
  isProfessional: boolean;
  defaultCurrency: string;
  defaultCancellationPolicyCode?: string | null;
};

function mapOrganization(row: OrganizationQueryRow): OrganizationRecord {
  return {
    id: row.id,
    legalName: row.legalName,
    publicDisplayName: row.publicDisplayName ?? null,
    slug: row.slug,
    status: row.status,
    isProfessional: row.isProfessional,
    defaultCurrency: row.defaultCurrency,
    defaultCancellationPolicyCode: row.defaultCancellationPolicyCode ?? 'FLEXIBLE',
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
    patch.defaultCurrency = normalizeMvpOrganizationCurrency(input.defaultCurrency);
  }
  const [row] = await db
    .update(organizations)
    .set(patch)
    .where(eq(organizations.id, organizationId))
    .returning();
  if (!row) throw new AuthorizationError('Organisation introuvable.');
  return mapOrganization(row);
}

/**
 * Met à jour les paramètres publics de l'entreprise (Chantier 15C).
 * Notamment le nom commercial affiché publiquement aux clients.
 */
export async function updateOrganizationPublicSettings(
  db: DatabaseClient,
  organizationId: string,
  input: { publicDisplayName?: string | null },
): Promise<OrganizationRecord> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.publicDisplayName !== undefined) {
    const name = input.publicDisplayName?.trim() ?? null;
    patch.publicDisplayName = name && name.length > 0 ? name : null;
  }
  const [row] = await db
    .update(organizations)
    .set(patch)
    .where(eq(organizations.id, organizationId))
    .returning();
  if (!row) throw new AuthorizationError('Organisation introuvable.');
  return mapOrganization(row);
}

/**
 * Met à jour la politique d'annulation par défaut de l'organisation (Chantier 15D).
 * Règle d'immuabilité : ne s'applique qu'aux nouvelles réservations ; les réservations
 * passées conservent leur snapshot immuable.
 */
export async function updateOrganizationCancellationPolicy(
  db: DatabaseClient,
  organizationId: string,
  policyCode: CancellationPolicyCode,
): Promise<OrganizationRecord> {
  if (!['FLEXIBLE', 'MODERATE', 'FIRM'].includes(policyCode)) {
    throw new Error(`Politique d'annulation invalide: ${policyCode}`);
  }

  const [row] = await db
    .update(organizations)
    .set({ defaultCancellationPolicyCode: policyCode, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning();
  if (!row) throw new AuthorizationError('Organisation introuvable.');
  return mapOrganization(row);
}
