'use server';

import { revalidatePath } from 'next/cache';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import { runAction } from '@/lib/action-mapper';
import { isValidUuid } from '@/lib/validation';
import {
  createCounterBooking,
  getCounterAvailableItems,
  type CounterAvailableItem,
  type CreateCounterBookingResult,
} from '@uttily/core';
import type { ActionResult } from '@uttily/contracts';

export interface GetCounterAvailableItemsInput {
  organizationId: string;
  locationId: string;
  startAtIso: string;
  endAtIso: string;
}

export interface GetCounterAvailableItemsOutput {
  items: CounterAvailableItem[];
  location: { id: string; name: string; timeZone: string };
  startAt: string;
  endAt: string;
}

export async function getCounterAvailableItemsAction(
  input: GetCounterAvailableItemsInput,
): Promise<ActionResult<GetCounterAvailableItemsOutput>> {
  return runAction(async () => {
    if (!isValidUuid(input.organizationId) || !isValidUuid(input.locationId)) {
      throw new Error('Identifiant invalide.');
    }
    const startAt = new Date(input.startAtIso);
    const endAt = new Date(input.endAtIso);
    if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime())) {
      throw new Error('Dates invalides.');
    }

    const { db, user } = await requireFulfillmentOperatorOf(input.organizationId);

    const result = await getCounterAvailableItems(db, {
      organizationId: input.organizationId,
      locationId: input.locationId,
      operator: user,
      startAt,
      endAt,
    });

    return {
      items: result.items,
      location: result.location,
      startAt: result.startAt.toISOString(),
      endAt: result.endAt.toISOString(),
    };
  });
}

export interface CreateCounterBookingFormInput {
  organizationId: string;
  locationId: string;
  channel: 'WALK_IN' | 'PHONE';
  customerName: string;
  customerEmail: string;
  customerPhone?: string | undefined;
  startAtIso: string;
  endAtIso: string;
  itemIds: string[];
  paymentMethod:
    'ON_SITE_CARD' | 'ON_SITE_CASH' | 'ON_SITE_CHECK' | 'ON_SITE_HOLIDAY_VOUCHER' | 'PAY_LATER';
  paymentReference?: string | undefined;
  notes?: string | undefined;
  idempotencyKey: string;
}

export async function createCounterBookingAction(
  input: CreateCounterBookingFormInput,
): Promise<ActionResult<CreateCounterBookingResult>> {
  return runAction(async () => {
    if (!isValidUuid(input.organizationId) || !isValidUuid(input.locationId)) {
      throw new Error('Identifiant invalide.');
    }

    const startAt = new Date(input.startAtIso);
    const endAt = new Date(input.endAtIso);
    if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime())) {
      throw new Error('Dates de réservation invalides.');
    }

    if (!Array.isArray(input.itemIds) || input.itemIds.length === 0) {
      throw new Error('Veuillez sélectionner au moins un équipement.');
    }

    const { db, user } = await requireFulfillmentOperatorOf(input.organizationId);

    const result = await createCounterBooking(db, {
      organizationId: input.organizationId,
      locationId: input.locationId,
      operator: user,
      channel: input.channel,
      customer: {
        fullName: input.customerName,
        email: input.customerEmail,
        phone: input.customerPhone,
      },
      startAt,
      endAt,
      items: input.itemIds.map((id) => ({ inventoryItemId: id })),
      payment: {
        method: input.paymentMethod,
        reference: input.paymentReference,
      },
      notes: input.notes,
      idempotencyKey: input.idempotencyKey,
    });

    revalidatePath(`/dashboard/${input.organizationId}/bookings`);
    revalidatePath(`/dashboard/${input.organizationId}/bookings/planning`);

    return result;
  });
}
