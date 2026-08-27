'use server';

import { revalidatePath } from 'next/cache';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { runAction } from '@/lib/action-mapper';
import type { ActionResult } from '@uttily/contracts';
import {
  openMaintenanceCase,
  resolveMaintenanceCase,
  type OpenMaintenanceResult,
  type ResolveMaintenanceResult,
} from '@uttily/core';
import { isValidUuid } from '@/lib/validation';

export async function openMaintenanceCaseAction(
  organizationId: string,
  _prev: ActionResult<OpenMaintenanceResult>,
  formData: FormData,
): Promise<ActionResult<OpenMaintenanceResult>> {
  const inventoryItemId = String(formData.get('inventoryItemId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  const notes = String(formData.get('notes') ?? '').trim() || null;
  const idempotencyKey = String(formData.get('idempotencyKey') ?? crypto.randomUUID());

  if (!isValidUuid(inventoryItemId)) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Exemplaire invalide.',
      fieldErrors: { inventoryItemId: 'Exemplaire invalide.' },
    };
  }

  if (reason.length < 2) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Le motif de la maintenance est requis.',
      fieldErrors: { reason: 'Le motif doit faire au moins 2 caractères.' },
    };
  }

  return runAction(async () => {
    const { db, user, organizationId: authOrgId } = await requireCatalogManagerOf(organizationId);

    const result = await openMaintenanceCase(db, {
      organizationId: authOrgId,
      inventoryItemId,
      actorUserId: user.id,
      reason,
      notes,
      idempotencyKey,
    });

    revalidatePath(`/dashboard/${authOrgId}`);
    revalidatePath(`/dashboard/${authOrgId}/fleet`);
    revalidatePath(`/dashboard/${authOrgId}/fleet/maintenance`);
    revalidatePath(`/dashboard/${authOrgId}/inventory/${inventoryItemId}`);
    return result;
  });
}

export async function resolveMaintenanceCaseAction(
  organizationId: string,
  _prev: ActionResult<ResolveMaintenanceResult>,
  formData: FormData,
): Promise<ActionResult<ResolveMaintenanceResult>> {
  const maintenanceBlockId = String(formData.get('maintenanceBlockId') ?? '');
  const targetConditionRaw = String(formData.get('targetCondition') ?? 'GOOD');
  const notes = String(formData.get('notes') ?? '').trim() || null;
  const idempotencyKey = String(formData.get('idempotencyKey') ?? crypto.randomUUID());

  if (!isValidUuid(maintenanceBlockId)) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Bloc de maintenance invalide.',
      fieldErrors: { maintenanceBlockId: 'Dossier invalide.' },
    };
  }

  const targetCondition =
    targetConditionRaw === 'NEW' || targetConditionRaw === 'FAIR' ? targetConditionRaw : 'GOOD';

  return runAction(async () => {
    const { db, user, organizationId: authOrgId } = await requireCatalogManagerOf(organizationId);

    const result = await resolveMaintenanceCase(db, {
      organizationId: authOrgId,
      maintenanceBlockId,
      actorUserId: user.id,
      targetCondition,
      notes,
      idempotencyKey,
    });

    revalidatePath(`/dashboard/${authOrgId}`);
    revalidatePath(`/dashboard/${authOrgId}/fleet`);
    revalidatePath(`/dashboard/${authOrgId}/fleet/maintenance`);
    return result;
  });
}
