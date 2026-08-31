'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import {
  prepareBookingAction,
  pickupBookingAction,
  returnBookingAction,
  closeBookingAction,
} from '@/app/actions/fulfillment';
import type { ActionResult } from '@uttily/contracts';
import type { FulfillmentTransitionResult } from '@uttily/core';

type FormState = ActionResult<FulfillmentTransitionResult> | { ok: true; data: null };
const initialState: FormState = { ok: true, data: null };

function SubmitButton({ label }: { label: string }): React.ReactElement {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      style={{
        padding: '0.75rem 1rem',
        fontSize: '1rem',
        fontWeight: 600,
        color: 'var(--ut-color-surface)',
        background: 'var(--ut-color-primary)',
        border: 'none',
        borderRadius: 8,
        cursor: pending ? 'not-allowed' : 'pointer',
      }}
    >
      {pending ? 'Traitement en cours…' : label}
    </button>
  );
}

export interface TransitionActionProps {
  orgId: string;
  bookingId: string;
  actionKind: 'prepare' | 'pickup' | 'return' | 'close';
  label: string;
  idempotencyKey: string;
}

export function TransitionAction({
  orgId,
  bookingId,
  actionKind,
  label,
  idempotencyKey,
}: TransitionActionProps): React.ReactElement {
  // Sélectionne l'action bindée selon le kind.
  const action =
    actionKind === 'prepare'
      ? prepareBookingAction
      : actionKind === 'pickup'
        ? pickupBookingAction
        : actionKind === 'return'
          ? returnBookingAction
          : closeBookingAction;
  const boundAction = action.bind(null, orgId);

  const [state, formAction] = useActionState<FormState, FormData>(
    (prev: FormState, formData: FormData) =>
      boundAction(prev as ActionResult<FulfillmentTransitionResult>, formData),
    initialState,
  );

  const router = useRouter();
  const refreshed = useRef(false);

  // Après succès : router.refresh pour mettre à jour le statut affiché.
  useEffect(() => {
    if (state.ok && state.data && !refreshed.current) {
      refreshed.current = true;
      router.refresh();
    }
  }, [state, router]);

  return (
    <form action={formAction}>
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <div aria-live="polite" role="status">
        {state.ok && state.data && (
          <p style={{ color: 'var(--ut-color-success)' }}>
            {state.data.kind === 'APPLIED'
              ? 'Transition effectuée avec succès.'
              : 'Aucun changement nécessaire (déjà dans cet état).'}
          </p>
        )}
        {!state.ok && (
          <p role="alert" style={{ color: 'var(--ut-color-danger)' }}>
            {state.message}
          </p>
        )}
      </div>

      <SubmitButton label={label} />
    </form>
  );
}
