'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { updateVariantAction, deactivateVariantAction } from '@/app/actions/variants';
import type { ActionResult } from '@uttily/contracts';
import type { ProductVariantRecord } from '@uttily/core';

type FormState = ActionResult<ProductVariantRecord> | { ok: true; data: null };

const initialState: FormState = { ok: true, data: null };

function SubmitButton({ label }: { label: string }): React.ReactElement {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? '…' : label}
    </button>
  );
}

export function EditVariantForm({
  orgId,
  productId,
  variant,
  canDeactivate,
}: {
  orgId: string;
  productId: string;
  variant: ProductVariantRecord;
  canDeactivate: boolean;
}): React.ReactElement {
  const updateAction = updateVariantAction.bind(null, orgId);
  const [state, formAction] = useActionState<FormState, FormData>(
    (prev: FormState, formData: FormData) =>
      updateAction(prev as ActionResult<ProductVariantRecord>, formData),
    initialState,
  );
  const deactivateAction = deactivateVariantAction.bind(null, orgId);
  const [deactivateState, deactivateFormAction] = useActionState<FormState, FormData>(
    (prev: FormState, formData: FormData) =>
      deactivateAction(prev as ActionResult<ProductVariantRecord>, formData),
    initialState,
  );
  const router = useRouter();
  const redirected = useRef(false);

  useEffect(() => {
    if (state.ok && state.data && !redirected.current) {
      redirected.current = true;
      router.push(`/dashboard/${orgId}/catalog/${productId}`);
    }
  }, [state, orgId, productId, router]);

  const fieldErrors = !state.ok ? (state.fieldErrors ?? {}) : {};
  const attributesText =
    variant.attributes && Object.keys(variant.attributes).length > 0
      ? JSON.stringify(variant.attributes, null, 2)
      : '';

  return (
    <div>
      <form action={formAction}>
        <input type="hidden" name="variantId" value={variant.id} />

        <label htmlFor="name">Nom</label>
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={variant.name}
          aria-describedby="name-error"
        />
        {fieldErrors.name && (
          <p id="name-error" role="alert" aria-live="polite">
            {fieldErrors.name}
          </p>
        )}

        <label htmlFor="skuSuffix">Suffixe SKU (optionnel)</label>
        <input
          id="skuSuffix"
          name="skuSuffix"
          type="text"
          defaultValue={variant.skuSuffix ?? ''}
          aria-describedby="skuSuffix-error"
        />
        {fieldErrors.skuSuffix && (
          <p id="skuSuffix-error" role="alert" aria-live="polite">
            {fieldErrors.skuSuffix}
          </p>
        )}

        <label htmlFor="attributes">Attributs (JSON, optionnel)</label>
        <textarea
          id="attributes"
          name="attributes"
          defaultValue={attributesText}
          placeholder='{"couleur":"rouge","taille":"M"}'
          aria-describedby="attributes-error"
        />
        {fieldErrors.attributes && (
          <p id="attributes-error" role="alert" aria-live="polite">
            {fieldErrors.attributes}
          </p>
        )}

        {!state.ok && state.code !== 'VALIDATION' && (
          <p role="alert" aria-live="polite">
            {state.message}
          </p>
        )}

        <SubmitButton label="Enregistrer" />
      </form>

      {canDeactivate && (
        <form action={deactivateFormAction}>
          <input type="hidden" name="variantId" value={variant.id} />
          {!deactivateState.ok && (
            <p role="alert" aria-live="polite">
              {deactivateState.message}
            </p>
          )}
          <SubmitButton label="Désactiver" />
        </form>
      )}
    </div>
  );
}
