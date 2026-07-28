'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { createVariantAction } from '@/app/actions/variants';
import type { ActionResult } from '@uttily/contracts';
import type { ProductVariantRecord } from '@uttily/core';

type FormState = ActionResult<ProductVariantRecord> | { ok: true; data: null };

const initialState: FormState = { ok: true, data: null };

function SubmitButton(): React.ReactElement {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? '…' : 'Créer'}
    </button>
  );
}

export function NewVariantForm({
  orgId,
  productId,
}: {
  orgId: string;
  productId: string;
}): React.ReactElement {
  const createAction = createVariantAction.bind(null, orgId);
  const [state, formAction] = useActionState<FormState, FormData>(
    (prev: FormState, formData: FormData) =>
      createAction(prev as ActionResult<ProductVariantRecord>, formData),
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

  return (
    <form action={formAction}>
      <input type="hidden" name="productId" value={productId} />

      <label htmlFor="name">Nom</label>
      <input id="name" name="name" type="text" required aria-describedby="name-error" />
      {fieldErrors.name && (
        <p id="name-error" role="alert" aria-live="polite">
          {fieldErrors.name}
        </p>
      )}

      <label htmlFor="skuSuffix">Suffixe SKU (optionnel)</label>
      <input id="skuSuffix" name="skuSuffix" type="text" aria-describedby="skuSuffix-error" />
      {fieldErrors.skuSuffix && (
        <p id="skuSuffix-error" role="alert" aria-live="polite">
          {fieldErrors.skuSuffix}
        </p>
      )}

      <label htmlFor="attributes">Attributs (JSON, optionnel)</label>
      <textarea
        id="attributes"
        name="attributes"
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

      <SubmitButton />
    </form>
  );
}
