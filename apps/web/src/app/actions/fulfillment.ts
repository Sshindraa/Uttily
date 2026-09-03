'use server';

import { revalidatePath } from 'next/cache';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import { runAction } from '@/lib/action-mapper';
import { isValidUuid, isOneOf } from '@/lib/validation';
import {
  prepareBooking,
  pickupBooking,
  returnBooking,
  closeBooking,
  createConditionReport,
  createDamageReport,
  CONDITION_REPORT_PHASES,
  INVENTORY_CONDITIONS,
  type FulfillmentTransitionResult,
  RETURN_MAINTENANCE_DEFAULT_DURATION_MINUTES,
  RETURN_MAINTENANCE_MIN_DURATION_MINUTES,
  RETURN_MAINTENANCE_MAX_DURATION_MINUTES,
  type ConditionReportResult,
  type DamageReportResult,
  type ConditionReportPhase,
  type InventoryCondition,
  recordBookingNoShow,
  substituteBookingItem,
  listSubstitutionCandidates,
  type RecordBookingNoShowResult,
  type SubstituteBookingItemResult,
  type SubstitutionCandidateOption,
  declareBookingUnreturnedLost,
  type DeclareBookingUnreturnedLostResult,
  FulfillmentError,
} from '@uttily/core';
import type { ActionResult } from '@uttily/contracts';
import type { ParsedFailure } from './parsers';

const MAX_NOTES_LENGTH = 5000;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_NO_SHOW_REASON_LENGTH = 500;
const MAX_UNRETURNED_LOST_REASON_LENGTH = 500;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

function parseTransitionForm(
  formData: FormData,
): ParsedFailure | { bookingId: string; idempotencyKey: string } {
  const fieldErrors: Record<string, string> = {};
  const bookingId = String(formData.get('bookingId') ?? '');
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '').trim();

  if (!isValidUuid(bookingId)) fieldErrors.bookingId = 'Réservation invalide.';
  if (idempotencyKey.length < 1) {
    fieldErrors.idempotencyKey = "La clé d'idempotence est requise.";
  }
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    fieldErrors.idempotencyKey = `La clé ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.`;
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  return { bookingId, idempotencyKey };
}

function parseReturnTransitionForm(formData: FormData):
  | ParsedFailure
  | {
      bookingId: string;
      idempotencyKey: string;
      maintenance?: {
        bookingItemId: string;
        durationMinutes: number;
        sourceDamageReportId?: string;
      };
    } {
  const parsed = parseTransitionForm(formData);
  if ('fieldErrors' in parsed) return parsed;

  const fieldErrors: Record<string, string> = {};
  const maintenanceEnabledRaw = String(formData.get('maintenanceEnabled') ?? '').toLowerCase();
  const maintenanceEnabled = ['true', 'on', '1'].includes(maintenanceEnabledRaw);

  if (!maintenanceEnabled) return parsed;

  const bookingItemId = String(formData.get('maintenanceBookingItemId') ?? '').trim();
  const durationRaw = String(formData.get('maintenanceDurationMinutes') ?? '').trim();
  const sourceDamageReportIdRaw = String(formData.get('sourceDamageReportId') ?? '').trim();

  if (!isValidUuid(bookingItemId)) {
    fieldErrors.maintenanceBookingItemId = 'Exemplaire de retour invalide.';
  }

  let durationMinutes: number | undefined;
  if (durationRaw.length > 0) {
    const parsedDuration = Number(durationRaw);
    if (
      !Number.isSafeInteger(parsedDuration) ||
      parsedDuration < RETURN_MAINTENANCE_MIN_DURATION_MINUTES ||
      parsedDuration > RETURN_MAINTENANCE_MAX_DURATION_MINUTES
    ) {
      fieldErrors.maintenanceDurationMinutes = `La durée doit être comprise entre ${RETURN_MAINTENANCE_MIN_DURATION_MINUTES} et ${RETURN_MAINTENANCE_MAX_DURATION_MINUTES} minutes.`;
    } else {
      durationMinutes = parsedDuration;
    }
  } else {
    durationMinutes = RETURN_MAINTENANCE_DEFAULT_DURATION_MINUTES;
  }

  let sourceDamageReportId: string | undefined;
  if (sourceDamageReportIdRaw.length > 0) {
    if (!isValidUuid(sourceDamageReportIdRaw)) {
      fieldErrors.sourceDamageReportId = 'Rapport de dommage invalide.';
    } else {
      sourceDamageReportId = sourceDamageReportIdRaw;
    }
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  const normalizedDurationMinutes = durationMinutes ?? RETURN_MAINTENANCE_DEFAULT_DURATION_MINUTES;
  return {
    ...parsed,
    maintenance: {
      bookingItemId,
      durationMinutes: normalizedDurationMinutes,
      ...(sourceDamageReportId ? { sourceDamageReportId } : {}),
    },
  };
}

function parseConditionReportForm(formData: FormData):
  | ParsedFailure
  | {
      bookingId: string;
      bookingItemId: string;
      phase: ConditionReportPhase;
      condition: InventoryCondition;
      notes: string | null;
      idempotencyKey: string;
    } {
  const fieldErrors: Record<string, string> = {};
  const bookingId = String(formData.get('bookingId') ?? '');
  const bookingItemId = String(formData.get('bookingItemId') ?? '');
  const phaseRaw = String(formData.get('phase') ?? '').trim();
  const conditionRaw = String(formData.get('condition') ?? '').trim();
  const notesRaw = String(formData.get('notes') ?? '').trim();
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '').trim();

  if (!isValidUuid(bookingId)) fieldErrors.bookingId = 'Réservation invalide.';
  if (!isValidUuid(bookingItemId))
    fieldErrors.bookingItemId = 'Exemplaire de réservation invalide.';

  let phase: ConditionReportPhase;
  if (isOneOf(phaseRaw, CONDITION_REPORT_PHASES)) {
    phase = phaseRaw;
  } else {
    fieldErrors.phase = 'Phase invalide.';
  }
  // Après le early return sur fieldErrors, phase est nécessairement assigné.
  // L'assertion d'assignation définitive rassure le contrôle de flux TypeScript.
  const phaseValue: ConditionReportPhase = phase!;

  let condition: InventoryCondition;
  if (isOneOf(conditionRaw, INVENTORY_CONDITIONS)) {
    condition = conditionRaw;
  } else {
    fieldErrors.condition = 'État invalide.';
  }
  const conditionValue: InventoryCondition = condition!;

  if (idempotencyKey.length < 1) fieldErrors.idempotencyKey = "La clé d'idempotence est requise.";
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH)
    fieldErrors.idempotencyKey = `La clé ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.`;
  const notes = notesRaw.length === 0 ? null : notesRaw;
  if (notes !== null && notes.length > MAX_NOTES_LENGTH)
    fieldErrors.notes = `Les notes ne doivent pas dépasser ${MAX_NOTES_LENGTH} caractères.`;

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  return {
    bookingId,
    bookingItemId,
    phase: phaseValue,
    condition: conditionValue,
    notes,
    idempotencyKey,
  };
}

function parseDamageReportForm(formData: FormData):
  | ParsedFailure
  | {
      bookingId: string;
      bookingItemId: string;
      description: string;
      idempotencyKey: string;
      blocksInventory: boolean;
    } {
  const fieldErrors: Record<string, string> = {};
  const bookingId = String(formData.get('bookingId') ?? '');
  const bookingItemId = String(formData.get('bookingItemId') ?? '');
  const description = String(formData.get('description') ?? '').trim();
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '').trim();
  const blocksInventoryRaw = formData.get('blocksInventory');
  const blocksInventory =
    blocksInventoryRaw === 'true' || blocksInventoryRaw === 'on' || blocksInventoryRaw === '1';

  if (!isValidUuid(bookingId)) fieldErrors.bookingId = 'Réservation invalide.';
  if (!isValidUuid(bookingItemId))
    fieldErrors.bookingItemId = 'Exemplaire de réservation invalide.';
  if (description.length < 1) fieldErrors.description = 'La description est requise.';
  if (description.length > MAX_DESCRIPTION_LENGTH)
    fieldErrors.description = `La description ne doit pas dépasser ${MAX_DESCRIPTION_LENGTH} caractères.`;
  if (idempotencyKey.length < 1) fieldErrors.idempotencyKey = "La clé d'idempotence est requise.";
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH)
    fieldErrors.idempotencyKey = `La clé ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.`;

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  return { bookingId, bookingItemId, description, idempotencyKey, blocksInventory };
}

function parseNoShowForm(
  formData: FormData,
): ParsedFailure | { bookingId: string; idempotencyKey: string; reason: string | null } {
  const fieldErrors: Record<string, string> = {};
  const bookingId = String(formData.get('bookingId') ?? '');
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '').trim();
  const reasonRaw = formData.get('reason');
  const reason = reasonRaw === null ? '' : String(reasonRaw).trim();

  if (!isValidUuid(bookingId)) fieldErrors.bookingId = 'Réservation invalide.';
  if (idempotencyKey.length < 1) fieldErrors.idempotencyKey = "La clé d'idempotence est requise.";
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    fieldErrors.idempotencyKey = `La clé ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.`;
  }
  if (reason.length > MAX_NO_SHOW_REASON_LENGTH) {
    fieldErrors.reason = `Le motif ne doit pas dépasser ${MAX_NO_SHOW_REASON_LENGTH} caractères.`;
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  return { bookingId, idempotencyKey, reason: reason.length > 0 ? reason : null };
}

function parseUnreturnedLostForm(
  formData: FormData,
): ParsedFailure | { bookingId: string; idempotencyKey: string; reason: string | null } {
  const fieldErrors: Record<string, string> = {};
  const bookingId = String(formData.get('bookingId') ?? '');
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '').trim();
  const reasonRaw = formData.get('reason');
  const reason = reasonRaw === null ? '' : String(reasonRaw).trim();

  if (!isValidUuid(bookingId)) fieldErrors.bookingId = 'Réservation invalide.';
  if (idempotencyKey.length < 1) fieldErrors.idempotencyKey = "La clé d'idempotence est requise.";
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    fieldErrors.idempotencyKey = `La clé ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.`;
  }
  if (reason.length > MAX_UNRETURNED_LOST_REASON_LENGTH) {
    fieldErrors.reason = `Les circonstances ne doivent pas dépasser ${MAX_UNRETURNED_LOST_REASON_LENGTH} caractères.`;
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  return { bookingId, idempotencyKey, reason: reason.length > 0 ? reason : null };
}

function parseSubstitutionForm(formData: FormData):
  | ParsedFailure
  | {
      bookingId: string;
      bookingItemId: string;
      replacementInventoryItemId?: string;
      replacementSku?: string;
      idempotencyKey: string;
    } {
  const fieldErrors: Record<string, string> = {};
  const bookingId = String(formData.get('bookingId') ?? '');
  const bookingItemId = String(formData.get('bookingItemId') ?? '');
  const replacementInventoryItemIdRaw = String(
    formData.get('replacementInventoryItemId') ?? '',
  ).trim();
  const replacementSkuRaw = String(formData.get('replacementSku') ?? '').trim();
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '').trim();

  if (!isValidUuid(bookingId)) fieldErrors.bookingId = 'Réservation invalide.';
  if (!isValidUuid(bookingItemId))
    fieldErrors.bookingItemId = 'Exemplaire de réservation invalide.';
  if (replacementInventoryItemIdRaw.length > 0) {
    if (!isValidUuid(replacementInventoryItemIdRaw)) {
      fieldErrors.replacementInventoryItemId = 'Exemplaire de remplacement invalide.';
    }
  } else if (replacementSkuRaw.length === 0) {
    fieldErrors.replacementSku = 'Sélectionnez un exemplaire de remplacement.';
  } else if (replacementSkuRaw.length > 200) {
    fieldErrors.replacementSku = 'Le SKU ne doit pas dépasser 200 caractères.';
  }
  if (idempotencyKey.length < 1) fieldErrors.idempotencyKey = "La clé d'idempotence est requise.";
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    fieldErrors.idempotencyKey = `La clé ne doit pas dépasser ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères.`;
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  return {
    bookingId,
    bookingItemId,
    ...(replacementInventoryItemIdRaw.length > 0
      ? { replacementInventoryItemId: replacementInventoryItemIdRaw }
      : { replacementSku: replacementSkuRaw }),
    idempotencyKey,
  };
}

export async function prepareBookingAction(
  organizationId: string,
  _prev: ActionResult<FulfillmentTransitionResult>,
  formData: FormData,
): Promise<ActionResult<FulfillmentTransitionResult>> {
  const parsed = parseTransitionForm(formData);
  if ('fieldErrors' in parsed) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors: parsed.fieldErrors,
    };
  }
  return runAction(async () => {
    const {
      db,
      user,
      organizationId: authorizedOrgId,
    } = await requireFulfillmentOperatorOf(organizationId);
    const result = await prepareBooking(db, {
      organizationId: authorizedOrgId,
      bookingId: parsed.bookingId,
      actorUserId: user.id,
      idempotencyKey: parsed.idempotencyKey,
    });
    revalidatePath(`/dashboard/${authorizedOrgId}/operations`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings`);
    revalidatePath(`/dashboard/${authorizedOrgId}/operations/${parsed.bookingId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings/${parsed.bookingId}`);
    return result;
  });
}

export async function pickupBookingAction(
  organizationId: string,
  _prev: ActionResult<FulfillmentTransitionResult>,
  formData: FormData,
): Promise<ActionResult<FulfillmentTransitionResult>> {
  const parsed = parseTransitionForm(formData);
  if ('fieldErrors' in parsed) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors: parsed.fieldErrors,
    };
  }
  return runAction(async () => {
    const {
      db,
      user,
      organizationId: authorizedOrgId,
    } = await requireFulfillmentOperatorOf(organizationId);
    const result = await pickupBooking(db, {
      organizationId: authorizedOrgId,
      bookingId: parsed.bookingId,
      actorUserId: user.id,
      idempotencyKey: parsed.idempotencyKey,
    });
    revalidatePath(`/dashboard/${authorizedOrgId}/operations`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings`);
    revalidatePath(`/dashboard/${authorizedOrgId}/operations/${parsed.bookingId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings/${parsed.bookingId}`);
    return result;
  });
}

export async function returnBookingAction(
  organizationId: string,
  _prev: ActionResult<FulfillmentTransitionResult>,
  formData: FormData,
): Promise<ActionResult<FulfillmentTransitionResult>> {
  const parsed = parseReturnTransitionForm(formData);
  if ('fieldErrors' in parsed) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors: parsed.fieldErrors,
    };
  }
  return runAction(async () => {
    const {
      db,
      user,
      organizationId: authorizedOrgId,
    } = await requireFulfillmentOperatorOf(organizationId);
    const result = await returnBooking(db, {
      organizationId: authorizedOrgId,
      bookingId: parsed.bookingId,
      actorUserId: user.id,
      idempotencyKey: parsed.idempotencyKey,
      ...(parsed.maintenance ? { maintenance: parsed.maintenance } : {}),
    });
    revalidatePath(`/dashboard/${authorizedOrgId}/operations`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings`);
    revalidatePath(`/dashboard/${authorizedOrgId}/operations/${parsed.bookingId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings/${parsed.bookingId}`);
    return result;
  });
}

export async function closeBookingAction(
  organizationId: string,
  _prev: ActionResult<FulfillmentTransitionResult>,
  formData: FormData,
): Promise<ActionResult<FulfillmentTransitionResult>> {
  const parsed = parseTransitionForm(formData);
  if ('fieldErrors' in parsed) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors: parsed.fieldErrors,
    };
  }
  return runAction(async () => {
    const {
      db,
      user,
      organizationId: authorizedOrgId,
    } = await requireFulfillmentOperatorOf(organizationId);
    const result = await closeBooking(db, {
      organizationId: authorizedOrgId,
      bookingId: parsed.bookingId,
      actorUserId: user.id,
      idempotencyKey: parsed.idempotencyKey,
    });
    revalidatePath(`/dashboard/${authorizedOrgId}/operations`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings`);
    revalidatePath(`/dashboard/${authorizedOrgId}/operations/${parsed.bookingId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings/${parsed.bookingId}`);
    return result;
  });
}

export async function recordBookingNoShowAction(
  organizationId: string,
  _prev: ActionResult<RecordBookingNoShowResult>,
  formData: FormData,
): Promise<ActionResult<RecordBookingNoShowResult>> {
  const parsed = parseNoShowForm(formData);
  if ('fieldErrors' in parsed) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors: parsed.fieldErrors,
    };
  }
  return runAction(async () => {
    const {
      db,
      user,
      organizationId: authorizedOrgId,
    } = await requireFulfillmentOperatorOf(organizationId);
    const result = await recordBookingNoShow(db, {
      organizationId: authorizedOrgId,
      bookingId: parsed.bookingId,
      actorUserId: user.id,
      idempotencyKey: parsed.idempotencyKey,
      reason: parsed.reason,
    });
    revalidatePath(`/dashboard/${authorizedOrgId}/operations`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings`);
    revalidatePath(`/dashboard/${authorizedOrgId}/operations/${parsed.bookingId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings/${parsed.bookingId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings/planning`);
    revalidatePath(`/dashboard/${authorizedOrgId}/planning`);
    revalidatePath(`/dashboard/${authorizedOrgId}/fleet`);
    return result;
  });
}

export async function declareBookingUnreturnedLostAction(
  organizationId: string,
  _prev: ActionResult<DeclareBookingUnreturnedLostResult>,
  formData: FormData,
): Promise<ActionResult<DeclareBookingUnreturnedLostResult>> {
  const parsed = parseUnreturnedLostForm(formData);
  if ('fieldErrors' in parsed) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors: parsed.fieldErrors,
    };
  }
  return runAction(async () => {
    const {
      db,
      user,
      organizationId: authorizedOrgId,
    } = await requireFulfillmentOperatorOf(organizationId);
    const result = await declareBookingUnreturnedLost(db, {
      organizationId: authorizedOrgId,
      bookingId: parsed.bookingId,
      actorUserId: user.id,
      idempotencyKey: parsed.idempotencyKey,
      reason: parsed.reason,
    });
    revalidatePath(`/dashboard/${authorizedOrgId}/operations`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings`);
    revalidatePath(`/dashboard/${authorizedOrgId}/operations/${parsed.bookingId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings/${parsed.bookingId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings/planning`);
    revalidatePath(`/dashboard/${authorizedOrgId}/planning`);
    revalidatePath(`/dashboard/${authorizedOrgId}/fleet`);
    return result;
  });
}

export async function getSubstitutionCandidatesAction(
  organizationId: string,
  bookingId: string,
  bookingItemId: string,
): Promise<ActionResult<SubstitutionCandidateOption[]>> {
  if (!isValidUuid(bookingId) || !isValidUuid(bookingItemId)) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Réservation ou exemplaire invalide.',
    };
  }
  return runAction(async () => {
    const { db, organizationId: authorizedOrgId } =
      await requireFulfillmentOperatorOf(organizationId);
    const candidates = await listSubstitutionCandidates(
      db,
      authorizedOrgId,
      bookingId,
      bookingItemId,
    );
    return candidates.map(({ internalSku, serialNumber, condition }) => ({
      internalSku,
      serialNumber,
      condition,
    }));
  });
}

export async function substituteBookingItemAction(
  organizationId: string,
  _prev: ActionResult<SubstituteBookingItemResult>,
  formData: FormData,
): Promise<ActionResult<SubstituteBookingItemResult>> {
  const parsed = parseSubstitutionForm(formData);
  if ('fieldErrors' in parsed) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors: parsed.fieldErrors,
    };
  }
  return runAction(async () => {
    const {
      db,
      user,
      organizationId: authorizedOrgId,
    } = await requireFulfillmentOperatorOf(organizationId);
    let replacementInventoryItemId = parsed.replacementInventoryItemId;
    if (!replacementInventoryItemId && parsed.replacementSku) {
      const candidates = await listSubstitutionCandidates(
        db,
        authorizedOrgId,
        parsed.bookingId,
        parsed.bookingItemId,
      );
      const candidate = candidates.find((option) => option.internalSku === parsed.replacementSku);
      if (!candidate) {
        throw new FulfillmentError(
          'CONCURRENT_MODIFICATION',
          "L'exemplaire de remplacement est devenu indisponible.",
        );
      }
      replacementInventoryItemId = candidate.id;
    }
    if (!replacementInventoryItemId) {
      throw new FulfillmentError('VALIDATION', 'Exemplaire de remplacement requis.');
    }
    const result = await substituteBookingItem(db, {
      organizationId: authorizedOrgId,
      bookingId: parsed.bookingId,
      bookingItemId: parsed.bookingItemId,
      replacementInventoryItemId,
      actorUserId: user.id,
      idempotencyKey: parsed.idempotencyKey,
    });
    revalidatePath(`/dashboard/${authorizedOrgId}/operations`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings`);
    revalidatePath(`/dashboard/${authorizedOrgId}/operations/${parsed.bookingId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings/${parsed.bookingId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings/planning`);
    revalidatePath(`/dashboard/${authorizedOrgId}/planning`);
    revalidatePath(`/dashboard/${authorizedOrgId}/fleet`);
    return result;
  });
}

export async function createConditionReportAction(
  organizationId: string,
  _prev: ActionResult<ConditionReportResult>,
  formData: FormData,
): Promise<ActionResult<ConditionReportResult>> {
  const parsed = parseConditionReportForm(formData);
  if ('fieldErrors' in parsed) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors: parsed.fieldErrors,
    };
  }
  return runAction(async () => {
    const {
      db,
      user,
      organizationId: authorizedOrgId,
    } = await requireFulfillmentOperatorOf(organizationId);
    const result = await createConditionReport(db, {
      organizationId: authorizedOrgId,
      bookingId: parsed.bookingId,
      bookingItemId: parsed.bookingItemId,
      actorUserId: user.id,
      idempotencyKey: parsed.idempotencyKey,
      phase: parsed.phase,
      condition: parsed.condition,
      notes: parsed.notes,
    });
    revalidatePath(`/dashboard/${authorizedOrgId}/operations`);
    revalidatePath(`/dashboard/${authorizedOrgId}/operations/${parsed.bookingId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings/${parsed.bookingId}`);
    return result;
  });
}

export async function createDamageReportAction(
  organizationId: string,
  _prev: ActionResult<DamageReportResult>,
  formData: FormData,
): Promise<ActionResult<DamageReportResult>> {
  const parsed = parseDamageReportForm(formData);
  if ('fieldErrors' in parsed) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez corriger les erreurs.',
      fieldErrors: parsed.fieldErrors,
    };
  }
  return runAction(async () => {
    const {
      db,
      user,
      organizationId: authorizedOrgId,
    } = await requireFulfillmentOperatorOf(organizationId);
    const result = await createDamageReport(db, {
      organizationId: authorizedOrgId,
      bookingId: parsed.bookingId,
      bookingItemId: parsed.bookingItemId,
      actorUserId: user.id,
      idempotencyKey: parsed.idempotencyKey,
      description: parsed.description,
      blocksInventory: parsed.blocksInventory,
    });
    revalidatePath(`/dashboard/${authorizedOrgId}/operations`);
    revalidatePath(`/dashboard/${authorizedOrgId}/operations/${parsed.bookingId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings`);
    revalidatePath(`/dashboard/${authorizedOrgId}/bookings/${parsed.bookingId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/fleet`);
    return result;
  });
}
