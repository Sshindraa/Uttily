'use server';

import { revalidatePath } from 'next/cache';
import {
  createManualBlock,
  releaseManualBlock,
  createRecurringManualBlockSeries,
  updateRecurringManualBlockSeries,
  suspendRecurringManualBlockSeries,
  resumeRecurringManualBlockSeries,
  deleteRecurringManualBlockSeries,
  releaseRecurringManualBlockOccurrence,
  type CreateManualBlockResult,
  type InventoryBlockRecord,
  type CreateRecurringManualBlockSeriesInput,
  type UpdateRecurringManualBlockSeriesInput,
  type RecurringManualBlockSeriesMutationResult,
  type ReleaseRecurringManualBlockOccurrenceResult,
} from '@uttily/core';
import type { ActionResult } from '@uttily/contracts';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { runAction } from '@/lib/action-mapper';
import { isValidUuid } from '@/lib/validation';

export async function createManualBlockAction(
  organizationId: string,
  _prev: ActionResult<CreateManualBlockResult>,
  formData: FormData,
): Promise<ActionResult<CreateManualBlockResult>> {
  const inventoryItemId = String(formData.get('inventoryItemId') ?? '');
  const locationId = String(formData.get('locationId') ?? '');
  const startAt = String(formData.get('startAt') ?? '');
  const endAt = String(formData.get('endAt') ?? '');
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '').trim();
  const fieldErrors: Record<string, string> = {};

  if (!isValidUuid(inventoryItemId)) fieldErrors.inventoryItemId = 'Exemplaire invalide.';
  if (!isValidUuid(locationId)) fieldErrors.locationId = 'Établissement invalide.';
  if (startAt.trim().length === 0) fieldErrors.startAt = 'La date de début est requise.';
  if (endAt.trim().length === 0) fieldErrors.endAt = 'La date de fin est requise.';
  if (idempotencyKey.length === 0) {
    fieldErrors.idempotencyKey = "La clé d'idempotence est requise.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors,
    };
  }

  return runAction(async () => {
    const {
      db,
      user,
      organizationId: authorizedOrgId,
    } = await requireCatalogManagerOf(organizationId);
    const result = await createManualBlock(db, {
      organizationId: authorizedOrgId,
      inventoryItemId,
      locationId,
      startAt,
      endAt,
      idempotencyKey,
      actorUserId: user.id,
    });

    revalidatePath(`/dashboard/${authorizedOrgId}/fleet`);
    revalidatePath(`/dashboard/${authorizedOrgId}/inventory/${inventoryItemId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    return result;
  });
}

export async function releaseManualBlockAction(
  organizationId: string,
  _prev: ActionResult<InventoryBlockRecord>,
  formData: FormData,
): Promise<ActionResult<InventoryBlockRecord>> {
  const blockId = String(formData.get('blockId') ?? '');
  if (!isValidUuid(blockId)) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Blocage invalide.',
      fieldErrors: { blockId: 'Blocage invalide.' },
    };
  }

  return runAction(async () => {
    const { db, organizationId: authorizedOrgId } = await requireCatalogManagerOf(organizationId);
    const result = await releaseManualBlock(db, authorizedOrgId, blockId);

    revalidatePath(`/dashboard/${authorizedOrgId}/fleet`);
    revalidatePath(`/dashboard/${authorizedOrgId}/inventory/${result.inventoryItemId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bikes`);
    return result;
  });
}

export async function createRecurringManualBlockSeriesAction(
  organizationId: string,
  _prev: ActionResult<RecurringManualBlockSeriesMutationResult>,
  formData: FormData,
): Promise<ActionResult<RecurringManualBlockSeriesMutationResult>> {
  const inventoryItemId = String(formData.get('inventoryItemId') ?? '');
  const locationId = String(formData.get('locationId') ?? '');
  const startDate = String(formData.get('startDate') ?? '');
  const endDate = String(formData.get('endDate') ?? '');
  const startTime = String(formData.get('startTime') ?? '');
  const endTime = String(formData.get('endTime') ?? '');
  const timeZone = String(formData.get('timeZone') ?? '');
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '').trim();
  const fieldErrors: Record<string, string> = {};

  if (!isValidUuid(inventoryItemId)) fieldErrors.inventoryItemId = 'Exemplaire invalide.';
  if (!isValidUuid(locationId)) fieldErrors.locationId = 'Établissement invalide.';
  if (startDate.trim().length === 0) fieldErrors.startDate = 'La date de début est requise.';
  if (endDate.trim().length === 0) fieldErrors.endDate = 'La date de fin est requise.';
  if (startTime.trim().length === 0) fieldErrors.startTime = "L'heure de début est requise.";
  if (endTime.trim().length === 0) fieldErrors.endTime = "L'heure de fin est requise.";
  if (timeZone.trim().length === 0)
    fieldErrors.timeZone = 'Le fuseau de l’établissement est requis.';
  if (idempotencyKey.length === 0) fieldErrors.idempotencyKey = "La clé d'idempotence est requise.";

  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors,
    };
  }

  return runAction(async () => {
    const {
      db,
      user,
      organizationId: authorizedOrgId,
    } = await requireCatalogManagerOf(organizationId);
    const result = await createRecurringManualBlockSeries(db, {
      organizationId: authorizedOrgId,
      inventoryItemId,
      locationId,
      frequency: 'WEEKLY',
      startDate,
      endDate,
      startTime,
      endTime,
      timeZone,
      idempotencyKey,
      actorUserId: user.id,
    } satisfies CreateRecurringManualBlockSeriesInput);
    revalidateRecurringManualBlockPaths(authorizedOrgId, inventoryItemId);
    return result;
  });
}

export async function updateRecurringManualBlockSeriesAction(
  organizationId: string,
  _prev: ActionResult<RecurringManualBlockSeriesMutationResult>,
  formData: FormData,
): Promise<ActionResult<RecurringManualBlockSeriesMutationResult>> {
  const seriesId = String(formData.get('seriesId') ?? '');
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '').trim();
  const input = {
    startDate: optionalFormValue(formData, 'startDate'),
    endDate: optionalFormValue(formData, 'endDate'),
    startTime: optionalFormValue(formData, 'startTime'),
    endTime: optionalFormValue(formData, 'endTime'),
  };
  const fieldErrors: Record<string, string> = {};
  if (!isValidUuid(seriesId)) fieldErrors.seriesId = 'Série invalide.';
  if (!Object.values(input).some((value) => value !== undefined)) {
    fieldErrors.schedule = 'Au moins un élément du calendrier doit être modifié.';
  }
  if (idempotencyKey.length === 0) fieldErrors.idempotencyKey = "La clé d'idempotence est requise.";
  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors,
    };
  }

  return runAction(async () => {
    const {
      db,
      user,
      organizationId: authorizedOrgId,
    } = await requireCatalogManagerOf(organizationId);
    const updateInput: UpdateRecurringManualBlockSeriesInput = {
      organizationId: authorizedOrgId,
      seriesId,
      idempotencyKey,
      actorUserId: user.id,
    };
    if (input.startDate !== undefined) updateInput.startDate = input.startDate;
    if (input.endDate !== undefined) updateInput.endDate = input.endDate;
    if (input.startTime !== undefined) updateInput.startTime = input.startTime;
    if (input.endTime !== undefined) updateInput.endTime = input.endTime;
    const result = await updateRecurringManualBlockSeries(db, updateInput);
    revalidateRecurringManualBlockPaths(authorizedOrgId);
    return result;
  });
}

export async function suspendRecurringManualBlockSeriesAction(
  organizationId: string,
  _prev: ActionResult<RecurringManualBlockSeriesMutationResult>,
  formData: FormData,
): Promise<ActionResult<RecurringManualBlockSeriesMutationResult>> {
  return runRecurringSeriesLifecycleAction(
    organizationId,
    formData,
    suspendRecurringManualBlockSeries,
  );
}

export async function resumeRecurringManualBlockSeriesAction(
  organizationId: string,
  _prev: ActionResult<RecurringManualBlockSeriesMutationResult>,
  formData: FormData,
): Promise<ActionResult<RecurringManualBlockSeriesMutationResult>> {
  return runRecurringSeriesLifecycleAction(
    organizationId,
    formData,
    resumeRecurringManualBlockSeries,
  );
}

export async function deleteRecurringManualBlockSeriesAction(
  organizationId: string,
  _prev: ActionResult<RecurringManualBlockSeriesMutationResult>,
  formData: FormData,
): Promise<ActionResult<RecurringManualBlockSeriesMutationResult>> {
  return runRecurringSeriesLifecycleAction(
    organizationId,
    formData,
    deleteRecurringManualBlockSeries,
  );
}

export async function releaseRecurringManualBlockOccurrenceAction(
  organizationId: string,
  _prev: ActionResult<ReleaseRecurringManualBlockOccurrenceResult>,
  formData: FormData,
): Promise<ActionResult<ReleaseRecurringManualBlockOccurrenceResult>> {
  const seriesId = String(formData.get('seriesId') ?? '');
  const occurrenceId = String(formData.get('occurrenceId') ?? '');
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '').trim();
  const fieldErrors: Record<string, string> = {};
  if (!isValidUuid(seriesId)) fieldErrors.seriesId = 'Série invalide.';
  if (!isValidUuid(occurrenceId)) fieldErrors.occurrenceId = 'Occurrence invalide.';
  if (idempotencyKey.length === 0) fieldErrors.idempotencyKey = "La clé d'idempotence est requise.";
  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors,
    };
  }

  return runAction(async () => {
    const {
      db,
      user,
      organizationId: authorizedOrgId,
    } = await requireCatalogManagerOf(organizationId);
    const result = await releaseRecurringManualBlockOccurrence(db, {
      organizationId: authorizedOrgId,
      seriesId,
      occurrenceId,
      idempotencyKey,
      actorUserId: user.id,
    });
    revalidateRecurringManualBlockPaths(authorizedOrgId);
    return result;
  });
}

function optionalFormValue(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  if (value === null) return undefined;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

async function runRecurringSeriesLifecycleAction(
  organizationId: string,
  formData: FormData,
  operation: (
    db: Parameters<typeof createRecurringManualBlockSeries>[0],
    input: {
      organizationId: string;
      seriesId: string;
      idempotencyKey: string;
      actorUserId: string;
    },
  ) => Promise<RecurringManualBlockSeriesMutationResult>,
): Promise<ActionResult<RecurringManualBlockSeriesMutationResult>> {
  const seriesId = String(formData.get('seriesId') ?? '');
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '').trim();
  const fieldErrors: Record<string, string> = {};
  if (!isValidUuid(seriesId)) fieldErrors.seriesId = 'Série invalide.';
  if (idempotencyKey.length === 0) fieldErrors.idempotencyKey = "La clé d'idempotence est requise.";
  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors,
    };
  }
  return runAction(async () => {
    const {
      db,
      user,
      organizationId: authorizedOrgId,
    } = await requireCatalogManagerOf(organizationId);
    const result = await operation(db, {
      organizationId: authorizedOrgId,
      seriesId,
      idempotencyKey,
      actorUserId: user.id,
    });
    revalidateRecurringManualBlockPaths(authorizedOrgId);
    return result;
  });
}

function revalidateRecurringManualBlockPaths(
  organizationId: string,
  inventoryItemId?: string,
): void {
  revalidatePath(`/dashboard/${organizationId}`);
  revalidatePath(`/dashboard/${organizationId}/fleet`);
  revalidatePath(`/dashboard/${organizationId}/bookings/planning`);
  if (inventoryItemId) revalidatePath(`/dashboard/${organizationId}/inventory/${inventoryItemId}`);
}
