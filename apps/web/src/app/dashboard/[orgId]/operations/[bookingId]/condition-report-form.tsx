'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { createConditionReportAction } from '@/app/actions/fulfillment';
import type { ActionResult } from '@uttily/contracts';
import type { ConditionReportResult, ConditionReportPhase, InventoryCondition } from '@uttily/core';

type FormState = ActionResult<ConditionReportResult> | { ok: true; data: null };
const initialState: FormState = { ok: true, data: null };

const MAX_NOTES_LENGTH = 5000;

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
        background: '#2563eb',
        border: 'none',
        borderRadius: 8,
        cursor: pending ? 'not-allowed' : 'pointer',
      }}
    >
      {pending ? 'Enregistrement…' : 'Enregistrer le rapport'}
    </button>
  );
}

export interface ConditionReportFormProps {
  orgId: string;
  bookingId: string;
  bookingItemId: string;
  phase: ConditionReportPhase;
  idempotencyKey: string;
  conditions: readonly InventoryCondition[];
}

export function ConditionReportForm({
  orgId,
  bookingId,
  bookingItemId,
  phase,
  idempotencyKey,
  conditions,
}: ConditionReportFormProps): React.ReactElement {
  const boundAction = createConditionReportAction.bind(null, orgId);
  const [state, formAction] = useActionState<FormState, FormData>(
    (prev: FormState, formData: FormData) =>
      boundAction(prev as ActionResult<ConditionReportResult>, formData),
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
  const formId = `condition-report-${phase}-${bookingItemId}`;

  // aria-describedby conditionnel : on ne référence l'ID d'erreur que si elle existe.
  const conditionErrorId = `${formId}-condition-error`;
  const conditionDescribedBy = fieldErrors.condition ? conditionErrorId : undefined;
  const notesHelpId = `${formId}-notes-help`;
  const notesErrorId = `${formId}-notes-error`;
  const notesDescribedBy = fieldErrors.notes ? `${notesHelpId} ${notesErrorId}` : notesHelpId;

  return (
    <form action={formAction} id={formId} aria-labelledby={`${formId}-heading`}>
      <p id={`${formId}-heading`} style={{ fontWeight: 600 }}>
        Rapport de {phase === 'PICKUP' ? 'retrait' : 'retour'}
      </p>

      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="bookingItemId" value={bookingItemId} />
      <input type="hidden" name="phase" value={phase} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <div style={{ marginBottom: '0.75rem' }}>
        <label htmlFor={`${formId}-condition`}>État de l'exemplaire</label>
        <select
          id={`${formId}-condition`}
          name="condition"
          required
          defaultValue=""
          aria-describedby={conditionDescribedBy}
          style={{
            display: 'block',
            width: '100%',
            padding: '0.5rem',
            border: '1px solid #d1d5db',
            borderRadius: 6,
            boxSizing: 'border-box',
          }}
        >
          <option value="" disabled>
            — Choisir un état —
          </option>
          {conditions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {fieldErrors.condition && (
          <p
            id={`${formId}-condition-error`}
            role="alert"
            aria-live="polite"
            style={{ color: '#dc2626', fontSize: '0.875rem' }}
          >
            {fieldErrors.condition}
          </p>
        )}
      </div>

      <div style={{ marginBottom: '0.75rem' }}>
        <label htmlFor={`${formId}-notes`}>Notes (optionnel)</label>
        <textarea
          id={`${formId}-notes`}
          name="notes"
          maxLength={MAX_NOTES_LENGTH}
          aria-describedby={notesDescribedBy}
          style={{
            display: 'block',
            width: '100%',
            padding: '0.5rem',
            border: '1px solid #d1d5db',
            borderRadius: 6,
            minHeight: 80,
            boxSizing: 'border-box',
          }}
        />
        <p id={`${formId}-notes-help`} style={{ fontSize: '0.875rem', color: '#6b7280' }}>
          Maximum {MAX_NOTES_LENGTH} caractères.
        </p>
        {fieldErrors.notes && (
          <p
            id={`${formId}-notes-error`}
            role="alert"
            aria-live="polite"
            style={{ color: '#dc2626', fontSize: '0.875rem' }}
          >
            {fieldErrors.notes}
          </p>
        )}
      </div>

      <div aria-live="polite" role="status">
        {state.ok && state.data && (
          <p style={{ color: '#16a34a' }}>Rapport enregistré avec succès.</p>
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
