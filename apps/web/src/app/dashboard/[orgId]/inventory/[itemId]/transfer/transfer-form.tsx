'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { transferInventoryItemAction } from '@/app/actions/inventory';
import type { ActionResult } from '@uttily/contracts';
import type { InventoryItemRecord, InventoryMovementRecord, LocationRecord } from '@uttily/core';

type TransferResult = {
  currentItem: InventoryItemRecord;
  movement: InventoryMovementRecord | null;
};

type FormState = ActionResult<TransferResult> | { ok: true; data: null };

const initialState: FormState = { ok: true, data: null };

function SubmitButton(): React.ReactElement {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? '…' : 'Transférer'}
    </button>
  );
}

export function TransferForm({
  orgId,
  itemId,
  currentLocationId,
  locations,
  idempotencyKey,
}: {
  orgId: string;
  itemId: string;
  currentLocationId: string;
  locations: LocationRecord[];
  idempotencyKey: string;
}): React.ReactElement {
  const transferAction = transferInventoryItemAction.bind(null, orgId);
  const [state, formAction] = useActionState<FormState, FormData>(
    (prev: FormState, formData: FormData) =>
      transferAction(prev as ActionResult<TransferResult>, formData),
    initialState,
  );
  const router = useRouter();
  const redirected = useRef(false);

  useEffect(() => {
    if (state.ok && state.data && !redirected.current) {
      redirected.current = true;
      router.push(`/dashboard/${orgId}/inventory/${itemId}`);
    }
  }, [state, orgId, itemId, router]);

  const fieldErrors = !state.ok ? (state.fieldErrors ?? {}) : {};

  // On exclut la location actuelle des destinations possibles.
  const possibleLocations = locations.filter((loc) => loc.id !== currentLocationId);

  return (
    <form action={formAction}>
      {/* Clé d'idempotence : générée côté serveur, stable pendant les retries.
          Le domaine détecte le rejeu via l'index unique (itemId, idempotencyKey)
          et retourne le mouvement existant au lieu d'en créer un nouveau. */}
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="itemId" value={itemId} />

      <label htmlFor="toLocationId">Établissement de destination</label>
      <select
        id="toLocationId"
        name="toLocationId"
        required
        defaultValue=""
        aria-describedby="toLocationId-error"
      >
        <option value="" disabled>
          — Choisir un établissement —
        </option>
        {possibleLocations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.name}
          </option>
        ))}
      </select>
      {fieldErrors.toLocationId && (
        <p id="toLocationId-error" role="alert" aria-live="polite">
          {fieldErrors.toLocationId}
        </p>
      )}

      <label htmlFor="reason">Raison (optionnel)</label>
      <textarea id="reason" name="reason" aria-describedby="reason-error" />
      {fieldErrors.reason && (
        <p id="reason-error" role="alert" aria-live="polite">
          {fieldErrors.reason}
        </p>
      )}

      <p aria-live="polite">
        Si le transfert échoue et que vous réessayez, la même clé sera réutilisée pour éviter un
        double transfert.
      </p>

      {!state.ok && state.code !== 'VALIDATION' && (
        <p role="alert" aria-live="polite">
          {state.message}
        </p>
      )}

      <SubmitButton />
    </form>
  );
}
