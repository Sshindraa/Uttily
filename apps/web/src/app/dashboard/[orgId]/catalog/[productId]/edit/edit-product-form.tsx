'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { updateProductAction } from '@/app/actions/products';
import type { ActionResult } from '@uttily/contracts';
import type { CategoryRecord, ProductRecord } from '@uttily/core';

type FormState = ActionResult<ProductRecord> | { ok: true; data: null };

const initialState: FormState = { ok: true, data: null };

function SubmitButton(): React.ReactElement {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? '…' : 'Enregistrer'}
    </button>
  );
}

export function EditProductForm({
  orgId,
  categories,
  product,
  inactiveCategory,
}: {
  orgId: string;
  categories: CategoryRecord[];
  product: ProductRecord;
  inactiveCategory: { id: string; name: string } | null;
}): React.ReactElement {
  const updateAction = updateProductAction.bind(null, orgId);
  const [state, formAction] = useActionState<FormState, FormData>(
    (prev: FormState, formData: FormData) =>
      updateAction(prev as ActionResult<ProductRecord>, formData),
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
      <input type="hidden" name="productId" value={product.id} />

      <label htmlFor="name">Nom</label>
      <input
        id="name"
        name="name"
        type="text"
        defaultValue={product.name ?? ''}
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
        defaultValue={product.categoryId ?? ''}
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
        {inactiveCategory && (
          <option value={inactiveCategory.id} disabled>
            {inactiveCategory.name} (inactive)
          </option>
        )}
      </select>
      {inactiveCategory && (
        <p role="note">
          La catégorie actuelle de ce produit est inactive. Choisissez une catégorie active.
        </p>
      )}
      {fieldErrors.categoryId && (
        <p id="categoryId-error" role="alert" aria-live="polite">
          {fieldErrors.categoryId}
        </p>
      )}

      <label htmlFor="description">Description</label>
      <textarea
        id="description"
        name="description"
        defaultValue={product.description ?? ''}
        aria-describedby="description-error"
      />
      {fieldErrors.description && (
        <p id="description-error" role="alert" aria-live="polite">
          {fieldErrors.description}
        </p>
      )}

      <label htmlFor="slug">Slug (optionnel)</label>
      <input
        id="slug"
        name="slug"
        type="text"
        defaultValue={product.slug ?? ''}
        aria-describedby="slug-error"
      />
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
