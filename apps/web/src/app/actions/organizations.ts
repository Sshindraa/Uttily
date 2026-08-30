'use server';

import { revalidatePath } from 'next/cache';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  createOrganizationForUser,
  listOrganizationsForUser,
  updateOrganization,
  getMembership,
  requireMembership,
  ROLE_MANAGERS,
  type CreateOrganizationInput,
} from '@uttily/core';

export async function createOrganizationAction(input: CreateOrganizationInput) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  const { organization } = await createOrganizationForUser(db, user, input);
  revalidatePath('/dashboard');
  revalidatePath(`/dashboard/${organization.id}`);
  return { organization };
}

export async function listMyOrganizationsAction() {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  return listOrganizationsForUser(db, user.id);
}

export async function updateOrganizationAction(
  organizationId: string,
  input: { legalName?: string; defaultCurrency?: string },
) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireMembership(membership, ROLE_MANAGERS);
  const organization = await updateOrganization(db, organizationId, input);
  revalidatePath('/dashboard');
  return { organization };
}
