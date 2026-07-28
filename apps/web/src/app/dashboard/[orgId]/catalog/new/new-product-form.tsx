'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { createProductAction } from '@/app/actions/products';
import type { ActionResult } from '@uttily/contracts';
import type { CategoryRecord, ProductRecord } from '@uttily/core';

type FormState = ActionResult<ProductRecord> | { ok: true; data: null };

const initialState: FormState = { ok: true, data: null };

function SubmitButton(): React.ReactElement {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? '…' : 'Créer'}
    </button>
  );
}

export function NewProductForm({
  orgId,
  categories,
}: {
  orgId: string;
  categories: CategoryRecord[];
}): React.ReactElement {
  const createAction = createProductAction.bind(null, orgId);
  const [state, formAction] = useActionState<FormState, FormData>(
    (prev: FormState, formData: FormData) =>
      createAction(prev as ActionResult<ProductRecord>, formData),
    initialState,
  );
  const router = useRouter();
  const redirected = useRef(false);

  useEffect(() => {
    if (state.ok && state.data && !redirected.current) {
      redirected.current = true;
      router.push(`/dashboard/${orgId}/catalog/${state.data.id}`);
    }
  }, [state, orgId, router]);

  const fieldErrors = !state.ok ? (state.fieldErrors ?? {}) : {};

  return (
    <form action={formAction}>
      <label htmlFor="name">Nom</label>
      <input
        id="name"
        name="name"
        type="text"
        required
        minLength={2}
        aria-describedby="name-error"
      />
      {fieldErrors.name && (
        <p id="name-error" role="alert" aria-live="polite">
          {fieldErrors.name}
        </p>
      )}

      <label htmlFor="categoryId">Catégorie</label>
      <select
        id="categoryId"
        name="categoryId"
        required
        defaultValue=""
        aria-describedby="categoryId-error"
      >
        <option value="" disabled>
          — Choisir une catégorie —
        </option>
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </select>
      {fieldErrors.categoryId && (
        <p id="categoryId-error" role="alert" aria-live="polite">
          {fieldErrors.categoryId}
        </p>
      )}

      <label htmlFor="description">Description (optionnel)</label>
      <textarea id="description" name="description" aria-describedby="description-error" />
      {fieldErrors.description && (
        <p id="description-error" role="alert" aria-live="polite">
          {fieldErrors.description}
        </p>
      )}

      <label htmlFor="slug">Slug (optionnel)</label>
      <input id="slug" name="slug" type="text" aria-describedby="slug-error" />
      {fieldErrors.slug && (
        <p id="slug-error" role="alert" aria-live="polite">
          {fieldErrors.slug}
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
