'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { createInventoryItemAction } from '@/app/actions/inventory';
import type { ActionResult } from '@uttily/contracts';
import type { ActiveVariantOption, InventoryItemRecord, LocationRecord } from '@uttily/core';

type FormState = ActionResult<InventoryItemRecord> | { ok: true; data: null };

const initialState: FormState = { ok: true, data: null };

function SubmitButton(): React.ReactElement {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? '…' : 'Créer'}
    </button>
  );
}

export function NewInventoryForm({
  orgId,
  variants,
  locations,
}: {
  orgId: string;
  variants: ActiveVariantOption[];
  locations: LocationRecord[];
}): React.ReactElement {
  const createAction = createInventoryItemAction.bind(null, orgId);
  const [state, formAction] = useActionState<FormState, FormData>(
    (prev: FormState, formData: FormData) =>
      createAction(prev as ActionResult<InventoryItemRecord>, formData),
    initialState,
  );
  const router = useRouter();
  const redirected = useRef(false);

  useEffect(() => {
    if (state.ok && state.data && !redirected.current) {
      redirected.current = true;
      router.push(`/dashboard/${orgId}/inventory/${state.data.id}`);
    }
  }, [state, orgId, router]);

  const fieldErrors = !state.ok ? (state.fieldErrors ?? {}) : {};

  return (
    <form action={formAction}>
      <label htmlFor="productVariantId">Variante</label>
      <select
        id="productVariantId"
        name="productVariantId"
        required
        defaultValue=""
        aria-describedby="productVariantId-error"
      >
        <option value="" disabled>
          — Choisir une variante —
        </option>
        {variants.map((variant) => (
          <option key={variant.id} value={variant.id}>
            {variant.productName} / {variant.name}
          </option>
        ))}
      </select>
      {fieldErrors.productVariantId && (
        <p id="productVariantId-error" role="alert" aria-live="polite">
          {fieldErrors.productVariantId}
        </p>
      )}

      <label htmlFor="internalSku">SKU interne</label>
      <input
        id="internalSku"
        name="internalSku"
        type="text"
        required
        aria-describedby="internalSku-error"
      />
      {fieldErrors.internalSku && (
        <p id="internalSku-error" role="alert" aria-live="polite">
          {fieldErrors.internalSku}
        </p>
      )}

      <label htmlFor="serialNumber">Numéro de série (optionnel)</label>
      <input
        id="serialNumber"
        name="serialNumber"
        type="text"
        aria-describedby="serialNumber-error"
      />
      {fieldErrors.serialNumber && (
        <p id="serialNumber-error" role="alert" aria-live="polite">
          {fieldErrors.serialNumber}
        </p>
      )}

      <label htmlFor="condition">État</label>
      <select id="condition" name="condition" defaultValue="NEW" aria-describedby="condition-error">
        <option value="NEW">Neuf</option>
        <option value="GOOD">Bon</option>
        <option value="FAIR">Correct</option>
        <option value="POOR">Médiocre</option>
        <option value="BROKEN">Cassé</option>
      </select>
      {fieldErrors.condition && (
        <p id="condition-error" role="alert" aria-live="polite">
          {fieldErrors.condition}
        </p>
      )}

      <label htmlFor="currentLocationId">Établissement</label>
      <select
        id="currentLocationId"
        name="currentLocationId"
        required
        defaultValue=""
        aria-describedby="currentLocationId-error"
      >
        <option value="" disabled>
          — Choisir un établissement —
        </option>
        {locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.name}
          </option>
        ))}
      </select>
      {fieldErrors.currentLocationId && (
        <p id="currentLocationId-error" role="alert" aria-live="polite">
          {fieldErrors.currentLocationId}
        </p>
      )}

      <label htmlFor="notes">Notes (optionnel)</label>
      <textarea id="notes" name="notes" aria-describedby="notes-error" />
      {fieldErrors.notes && (
        <p id="notes-error" role="alert" aria-live="polite">
          {fieldErrors.notes}
        </p>
      )}

      {!state.ok && state.code !== 'VALIDATION' && (
        <p role="alert" aria-live="polite">
          {state.message}
        </p>
      )}

      <SubmitButton />
    </form>
  );
}
