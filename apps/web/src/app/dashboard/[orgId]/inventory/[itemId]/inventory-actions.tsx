'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { retireInventoryItemAction } from '@/app/actions/inventory';
import type { ActionResult } from '@uttily/contracts';
import type { InventoryItemRecord, InventoryStatus } from '@uttily/core';

type FormState = ActionResult<InventoryItemRecord> | { ok: true; data: null };

const initialState: FormState = { ok: true, data: null };

function SubmitButton({ label }: { label: string }): React.ReactElement {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? '…' : label}
    </button>
  );
}

export function InventoryActions({
  orgId,
  itemId,
  status,
}: {
  orgId: string;
  itemId: string;
  status: InventoryStatus;
}): React.ReactElement {
  const retireAction = retireInventoryItemAction.bind(null, orgId);
  const [retireState, retireFormAction] = useActionState<FormState, FormData>(
    (prev: FormState, formData: FormData) =>
      retireAction(prev as ActionResult<InventoryItemRecord>, formData),
    initialState,
  );

  return (
    <div>
      <p>
        <Link href={`/dashboard/${orgId}/inventory/${itemId}/transfer`}>Transférer</Link>
      </p>

      {status !== 'RETIRED' && (
        <form action={retireFormAction}>
          <input type="hidden" name="itemId" value={itemId} />
          {!retireState.ok && (
            <p role="alert" aria-live="polite">
              {retireState.message}
            </p>
          )}
          <SubmitButton label="Retirer" />
        </form>
      )}
    </div>
  );
}
