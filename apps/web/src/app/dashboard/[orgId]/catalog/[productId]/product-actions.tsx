'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  publishProductAction,
  archiveProductAction,
  restoreArchivedProductAction,
} from '@/app/actions/products';
import type { ActionResult } from '@uttily/contracts';
import type { ProductRecord, PublicationStatus } from '@uttily/core';

type FormState = ActionResult<ProductRecord> | { ok: true; data: null };

const initialState: FormState = { ok: true, data: null };

function SubmitButton({
  label,
  disabled,
}: {
  label: string;
  disabled?: boolean;
}): React.ReactElement {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending || disabled}>
      {pending ? '…' : label}
    </button>
  );
}

export function ProductActions({
  orgId,
  productId,
  status,
  ready,
}: {
  orgId: string;
  productId: string;
  status: PublicationStatus;
  ready?: boolean;
}): React.ReactElement | null {
  const publishAction = publishProductAction.bind(null, orgId);
  const [publishState, publishFormAction] = useActionState<FormState, FormData>(
    (prev: FormState, formData: FormData) =>
      publishAction(prev as ActionResult<ProductRecord>, formData),
    initialState,
  );
  const archiveAction = archiveProductAction.bind(null, orgId);
  const [archiveState, archiveFormAction] = useActionState<FormState, FormData>(
    (prev: FormState, formData: FormData) =>
      archiveAction(prev as ActionResult<ProductRecord>, formData),
    initialState,
  );
  const restoreAction = restoreArchivedProductAction.bind(null, orgId);
  const [restoreState, restoreFormAction] = useActionState<FormState, FormData>(
    (prev: FormState, formData: FormData) =>
      restoreAction(prev as ActionResult<ProductRecord>, formData),
    initialState,
  );

  const publishDisabled = ready === false;

  return (
    <div>
      {status === 'DRAFT' && (
        <form action={publishFormAction}>
          <input type="hidden" name="productId" value={productId} />
          {!publishState.ok && (
            <p role="alert" aria-live="polite">
              {publishState.message}
            </p>
          )}
          <SubmitButton label="Publier" disabled={publishDisabled} />
          {publishDisabled && (
            <p role="note">Complète les prérequis de publication avant de publier.</p>
          )}
        </form>
      )}

      {status === 'PUBLISHED' && (
        <form action={archiveFormAction}>
          <input type="hidden" name="productId" value={productId} />
          {!archiveState.ok && (
            <p role="alert" aria-live="polite">
              {archiveState.message}
            </p>
          )}
          <SubmitButton label="Archiver" />
        </form>
      )}

      {status === 'ARCHIVED' && (
        <form action={restoreFormAction}>
          <input type="hidden" name="productId" value={productId} />
          {!restoreState.ok && (
            <p role="alert" aria-live="polite">
              {restoreState.message}
            </p>
          )}
          <SubmitButton label="Restaurer" />
        </form>
      )}
    </div>
  );
}
