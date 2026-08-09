'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { createDamageReportAction } from '@/app/actions/fulfillment';
import type { ActionResult } from '@uttily/contracts';
import type { DamageReportResult } from '@uttily/core';

type FormState = ActionResult<DamageReportResult> | { ok: true; data: null };
const initialState: FormState = { ok: true, data: null };

const MAX_DESCRIPTION_LENGTH = 5000;

function SubmitButton(): React.ReactElement {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      style={{
        padding: '0.75rem 1rem',
        fontSize: '1rem',
        fontWeight: 600,
        color: '#fff',
        background: '#dc2626',
        border: 'none',
        borderRadius: 8,
        cursor: pending ? 'not-allowed' : 'pointer',
      }}
    >
      {pending ? 'Enregistrement…' : 'Déclarer le dommage'}
    </button>
  );
}

export interface DamageReportFormProps {
  orgId: string;
  bookingId: string;
  bookingItemId: string;
  idempotencyKey: string;
}

export function DamageReportForm({
  orgId,
  bookingId,
  bookingItemId,
  idempotencyKey,
}: DamageReportFormProps): React.ReactElement {
  const boundAction = createDamageReportAction.bind(null, orgId);
  const [state, formAction] = useActionState<FormState, FormData>(
    (prev: FormState, formData: FormData) =>
      boundAction(prev as ActionResult<DamageReportResult>, formData),
    initialState,
  );

  const router = useRouter();
  const refreshed = useRef(false);

  useEffect(() => {
    if (state.ok && state.data && !refreshed.current) {
      refreshed.current = true;
      router.refresh();
    }
  }, [state, router]);

  const fieldErrors = !state.ok ? (state.fieldErrors ?? {}) : {};
  const formId = `damage-report-${bookingItemId}`;

  // aria-describedby conditionnel : on ne référence l'ID d'erreur que si elle existe.
  const descriptionHelpId = `${formId}-description-help`;
  const descriptionErrorId = `${formId}-description-error`;
  const descriptionDescribedBy = fieldErrors.description
    ? `${descriptionHelpId} ${descriptionErrorId}`
    : descriptionHelpId;

  return (
    <form action={formAction} id={formId} aria-labelledby={`${formId}-heading`}>
      <p id={`${formId}-heading`} style={{ fontWeight: 600 }}>
        Déclaration de dommage
      </p>

      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="bookingItemId" value={bookingItemId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <div style={{ marginBottom: '0.75rem' }}>
        <label htmlFor={`${formId}-description`}>Description du dommage</label>
        <textarea
          id={`${formId}-description`}
          name="description"
          required
          maxLength={MAX_DESCRIPTION_LENGTH}
          aria-describedby={descriptionDescribedBy}
          style={{
            display: 'block',
            width: '100%',
            padding: '0.5rem',
            border: '1px solid #d1d5db',
            borderRadius: 6,
            minHeight: 100,
            boxSizing: 'border-box',
          }}
        />
        <p id={`${formId}-description-help`} style={{ fontSize: '0.875rem', color: '#6b7280' }}>
          Description obligatoire. Maximum {MAX_DESCRIPTION_LENGTH} caractères.
        </p>
        {fieldErrors.description && (
          <p
            id={`${formId}-description-error`}
            role="alert"
            aria-live="polite"
            style={{ color: '#dc2626', fontSize: '0.875rem' }}
          >
            {fieldErrors.description}
          </p>
        )}
      </div>

      <div aria-live="polite" role="status">
        {state.ok && state.data && (
          <p style={{ color: '#16a34a' }}>Déclaration enregistrée avec succès.</p>
        )}
        {!state.ok && state.code !== 'VALIDATION' && (
          <p role="alert" style={{ color: '#dc2626' }}>
            {state.message}
          </p>
        )}
      </div>

      <SubmitButton />
    </form>
  );
}
