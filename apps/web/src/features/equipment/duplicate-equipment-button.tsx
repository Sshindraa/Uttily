'use client';

import { useRef, useState } from 'react';
import type { ActionResult } from '@uttily/contracts';
import { Button } from '@uttily/ui';
import { duplicateProductAction } from '@/app/actions/products';

type DuplicateResult = ActionResult<{ equipmentId: string }>;

const EMPTY_RESULT: DuplicateResult = {
  ok: false,
  code: 'UNKNOWN',
  message: '',
};

interface DuplicateEquipmentButtonProps {
  organizationId: string;
  productId: string;
  productName: string;
}

/**
 * CTA générique de duplication catalogue.
 * La clé est conservée pendant la durée du composant pour rendre les rejoués
 * réseau sûrs ; la destination reste le setup afin que la nouvelle offre
 * repasse toute sa checklist avant publication.
 */
export function DuplicateEquipmentButton({
  organizationId,
  productId,
  productName,
}: DuplicateEquipmentButtonProps): React.ReactElement {
  const idempotencyKeyRef = useRef<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleDuplicate = (): void => {
    if (isPending) return;
    idempotencyKeyRef.current ??= crypto.randomUUID();
    setIsPending(true);
    setErrorMessage(null);

    const formData = new FormData();
    formData.set('productId', productId);
    formData.set('idempotencyKey', idempotencyKeyRef.current);

    void duplicateProductAction(organizationId, EMPTY_RESULT, formData).then((result) => {
      setIsPending(false);
      if (result.ok) {
        window.location.assign(
          `/dashboard/${organizationId}/bikes/${result.data.equipmentId}/setup`,
        );
        return;
      }
      setErrorMessage(result.message || 'La duplication n’a pas pu être effectuée.');
    });
  };

  const errorId = `duplicate-error-${productId}`;

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={handleDuplicate}
        disabled={isPending}
        aria-label={`Dupliquer ${productName}`}
        aria-describedby={errorMessage ? errorId : undefined}
      >
        {isPending ? 'Duplication…' : 'Dupliquer'}
      </Button>
      {errorMessage && (
        <span
          id={errorId}
          role="alert"
          style={{
            color: 'var(--ut-color-danger)',
            fontSize: '0.78rem',
            marginTop: '0.4rem',
            maxWidth: '18rem',
            textAlign: 'right',
          }}
        >
          {errorMessage}
        </span>
      )}
    </span>
  );
}
