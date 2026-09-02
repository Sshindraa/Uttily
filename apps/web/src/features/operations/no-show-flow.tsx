'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { recordBookingNoShowAction } from '@/app/actions/fulfillment';
import { Button } from '@uttily/ui';
import { FlowDrawer } from './flow-drawer';

interface NoShowFlowProps {
  orgId: string;
  bookingId: string;
}

export function NoShowFlow({ orgId, bookingId }: NoShowFlowProps): React.ReactElement {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  function openFlow(): void {
    idempotencyKey.current = crypto.randomUUID();
    setReason('');
    setError(null);
    setIsOpen(true);
  }

  function closeFlow(): void {
    if (!loading) setIsOpen(false);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('bookingId', bookingId);
      formData.append('reason', reason.trim());
      formData.append('idempotencyKey', idempotencyKey.current ?? crypto.randomUUID());
      const result = await recordBookingNoShowAction(
        orgId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );
      if (!result.ok) {
        setError(result.message || 'Le no-show n’a pas pu être enregistré.');
        return;
      }
      setIsOpen(false);
      router.refresh();
    } catch {
      setError('Impossible d’enregistrer le no-show pour le moment. Veuillez réessayer.');
    } finally {
      setLoading(false);
    }
  }

  if (!isOpen) {
    return (
      <Button type="button" onClick={openFlow} variant="secondary" style={{ minHeight: '44px' }}>
        ⚠️ Signaler No-Show
      </Button>
    );
  }

  return (
    <FlowDrawer
      open={isOpen}
      title="⚠️ Signaler un No-Show"
      closeDisabled={loading}
      onClose={closeFlow}
    >
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
      >
        <div
          role="alert"
          style={{
            background: 'var(--ut-color-danger-soft)',
            border: 'var(--ut-border-thin)',
            borderRadius: 'var(--ut-radius-md)',
            color: 'var(--ut-color-danger)',
            fontSize: '0.875rem',
            padding: '0.85rem',
          }}
        >
          Confirmez que le client ne s’est pas présenté. La réservation sera annulée et son
          équipement sera immédiatement libéré, sans recalcul financier.
        </div>

        {error && (
          <div
            role="alert"
            style={{
              background: 'var(--ut-color-danger-soft)',
              color: 'var(--ut-color-danger)',
              padding: '0.75rem',
              borderRadius: 'var(--ut-radius-md)',
              fontSize: '0.875rem',
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          <label
            htmlFor={`no-show-reason-${bookingId}`}
            style={{
              color: 'var(--ut-color-ink)',
              fontSize: '0.875rem',
              fontWeight: 'var(--ut-weight-semibold)',
            }}
          >
            Motif (facultatif)
          </label>
          <textarea
            id={`no-show-reason-${bookingId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={loading}
            maxLength={500}
            rows={3}
            placeholder="Ex. Client absent après appel à 10h15"
            style={{
              background: 'var(--ut-color-surface)',
              border: 'var(--ut-border-thin)',
              borderRadius: 'var(--ut-radius-md)',
              color: 'var(--ut-color-ink)',
              fontSize: '0.9rem',
              padding: '0.6rem 0.75rem',
              width: '100%',
            }}
          />
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.75rem',
            justifyContent: 'flex-end',
          }}
        >
          <Button type="button" onClick={closeFlow} disabled={loading} variant="secondary">
            Annuler
          </Button>
          <Button type="submit" disabled={loading} variant="primary">
            {loading ? 'Enregistrement…' : 'Confirmer le No-Show'}
          </Button>
        </div>
      </form>
    </FlowDrawer>
  );
}
