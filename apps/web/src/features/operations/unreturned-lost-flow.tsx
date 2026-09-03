'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { declareBookingUnreturnedLostAction } from '@/app/actions/fulfillment';
import { Button } from '@uttily/ui';
import { FlowDrawer } from './flow-drawer';

interface UnreturnedLostFlowProps {
  orgId: string;
  bookingId: string;
}

/** Déclaration terrain d'une non-restitution depuis le bucket OVERDUE. */
export function UnreturnedLostFlow({
  orgId,
  bookingId,
}: UnreturnedLostFlowProps): React.ReactElement {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  function openFlow(): void {
    idempotencyKey.current = crypto.randomUUID();
    setReason('');
    setConfirmed(false);
    setError(null);
    setIsOpen(true);
  }

  function closeFlow(): void {
    if (!loading) setIsOpen(false);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!confirmed) {
      setError('Confirmez la déclaration avant de poursuivre.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('bookingId', bookingId);
      formData.append('reason', reason.trim());
      formData.append('idempotencyKey', idempotencyKey.current ?? crypto.randomUUID());
      const result = await declareBookingUnreturnedLostAction(
        orgId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );
      if (!result.ok) {
        setError(result.message || 'La déclaration de non-restitution a échoué.');
        return;
      }
      setIsOpen(false);
      router.refresh();
    } catch {
      setError('Impossible de déclarer la non-restitution pour le moment. Veuillez réessayer.');
    } finally {
      setLoading(false);
    }
  }

  if (!isOpen) {
    return (
      <Button type="button" onClick={openFlow} variant="secondary" style={{ minHeight: '44px' }}>
        🚨 Déclarer non-restitution
      </Button>
    );
  }

  return (
    <FlowDrawer
      open={isOpen}
      title="🚨 Déclarer une non-restitution"
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
          Cette action clôture le dossier, marque tous ses exemplaires comme perdus et libère les
          blocages résiduels. Les montants, taxes et snapshots financiers déjà confirmés restent
          inchangés ; l’alerte est transmise au traitement caution/assurance.
        </div>

        {error && (
          <div
            role="alert"
            style={{
              background: 'var(--ut-color-danger-soft)',
              borderRadius: 'var(--ut-radius-md)',
              color: 'var(--ut-color-danger)',
              fontSize: '0.875rem',
              padding: '0.75rem',
            }}
          >
            {error}
          </div>
        )}

        <label
          htmlFor={`unreturned-lost-confirm-${bookingId}`}
          style={{
            alignItems: 'flex-start',
            display: 'flex',
            gap: '0.6rem',
            fontSize: '0.9rem',
          }}
        >
          <input
            id={`unreturned-lost-confirm-${bookingId}`}
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            disabled={loading}
            style={{ marginTop: '0.2rem', minHeight: '18px', minWidth: '18px' }}
          />
          <span>
            Je confirme que l’échéance est dépassée et que le matériel n’a pas été restitué.
          </span>
        </label>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          <label
            htmlFor={`unreturned-lost-reason-${bookingId}`}
            style={{
              color: 'var(--ut-color-ink)',
              fontSize: '0.875rem',
              fontWeight: 'var(--ut-weight-semibold)',
            }}
          >
            Circonstances (facultatif)
          </label>
          <textarea
            id={`unreturned-lost-reason-${bookingId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={loading}
            maxLength={500}
            rows={4}
            placeholder="Ex. Client injoignable malgré les relances du 13/02"
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
          <Button type="submit" disabled={loading || !confirmed} variant="primary">
            {loading ? 'Clôture…' : 'Confirmer la non-restitution'}
          </Button>
        </div>
      </form>
    </FlowDrawer>
  );
}
