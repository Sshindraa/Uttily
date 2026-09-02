'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createConditionReportAction,
  pickupBookingAction,
  prepareBookingAction,
} from '@/app/actions/fulfillment';
import { Button } from '@uttily/ui';
import { FlowDrawer } from './flow-drawer';

interface DepartureFlowProps {
  orgId: string;
  bookingId: string;
  status?: 'CONFIRMED' | 'READY_FOR_PICKUP';
  items: {
    bookingItemId: string;
    internalSku: string;
    serialNumber: string | null;
    currentCondition: string;
  }[];
}

export function DepartureFlow({
  orgId,
  bookingId,
  status = 'READY_FOR_PICKUP',
  items,
}: DepartureFlowProps): React.ReactElement {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [condition, setCondition] = useState<'GOOD' | 'FAIR' | 'POOR'>('GOOD');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKeys = useRef<Partial<Record<'prepare' | 'condition' | 'pickup', string>>>({});
  const completedSteps = useRef({ prepare: false, condition: false });

  const firstItem = items[0];

  function getIdempotencyKey(step: 'prepare' | 'condition' | 'pickup'): string {
    const current = idempotencyKeys.current[step];
    if (current) return current;
    const next = crypto.randomUUID();
    idempotencyKeys.current[step] = next;
    return next;
  }

  function openFlow(): void {
    idempotencyKeys.current = {};
    completedSteps.current = { prepare: false, condition: false };
    setError(null);
    setIsOpen(true);
  }

  function closeFlow(): void {
    if (!loading) setIsOpen(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // CONFIRMED doit d'abord passer par la transition métier de préparation.
      // La remise reste ensuite le même flow comptoir, sans transition directe
      // interdite par la machine d'état.
      if (status === 'CONFIRMED' && !completedSteps.current.prepare) {
        const prepareFormData = new FormData();
        prepareFormData.append('bookingId', bookingId);
        prepareFormData.append('idempotencyKey', getIdempotencyKey('prepare'));

        const prepareResult = await prepareBookingAction(
          orgId,
          { ok: false, code: 'UNKNOWN', message: '' },
          prepareFormData,
        );
        if (!prepareResult.ok) {
          setError(prepareResult.message || 'Impossible de préparer la réservation.');
          return;
        }
        completedSteps.current.prepare = true;
      }

      // 1. Enregistrer le rapport d'état au départ si un exemplaire existe.
      if (firstItem && !completedSteps.current.condition) {
        const conditionFormData = new FormData();
        conditionFormData.append('bookingId', bookingId);
        conditionFormData.append('bookingItemId', firstItem.bookingItemId);
        conditionFormData.append('phase', 'PICKUP');
        conditionFormData.append('condition', condition);
        conditionFormData.append('notes', notes);
        conditionFormData.append('idempotencyKey', getIdempotencyKey('condition'));

        const conditionResult = await createConditionReportAction(
          orgId,
          { ok: false, code: 'UNKNOWN', message: '' },
          conditionFormData,
        );

        if (!conditionResult.ok) {
          setError(
            conditionResult.message || "Erreur lors de l'enregistrement de l'état de l'équipement",
          );
          return;
        }
        completedSteps.current.condition = true;
      }

      // 2. Transitionner vers ACTIVE (Équipement remis au client)
      const transitionFormData = new FormData();
      transitionFormData.append('bookingId', bookingId);
      transitionFormData.append('idempotencyKey', getIdempotencyKey('pickup'));

      const pickupResult = await pickupBookingAction(
        orgId,
        { ok: false, code: 'UNKNOWN', message: '' },
        transitionFormData,
      );

      if (!pickupResult.ok) {
        setError(pickupResult.message || 'Erreur lors du départ');
        return;
      }

      setIsOpen(false);
      router.refresh();
    } catch {
      setError(
        'Impossible de confirmer la remise de l’équipement pour le moment. Veuillez réessayer.',
      );
    } finally {
      setLoading(false);
    }
  }

  if (!isOpen) {
    return (
      <Button type="button" onClick={openFlow} variant="primary" style={{ minHeight: '44px' }}>
        🟢 Préparer &amp; Confirmer le départ →
      </Button>
    );
  }

  return (
    <FlowDrawer
      open={isOpen}
      title="🟢 Départ · Remise de l’équipement"
      closeDisabled={loading}
      onClose={closeFlow}
    >
      <div
        style={{
          background: 'var(--ut-color-surface-soft)',
          padding: '1rem',
          borderRadius: 'var(--ut-radius-md)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          border: 'var(--ut-border-thin)',
          fontSize: '0.875rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ color: 'var(--ut-color-success)', fontWeight: 'var(--ut-weight-bold)' }}>
            ✓
          </span>
          <span>Réservation confirmée</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ color: 'var(--ut-color-success)', fontWeight: 'var(--ut-weight-bold)' }}>
            ✓
          </span>
          <span>
            Référence exemplaire : <strong>{firstItem?.internalSku ?? '—'}</strong>
            {firstItem?.serialNumber ? ` (N° ${firstItem.serialNumber})` : ''}
          </span>
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
      >
        {error && (
          <div
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
            htmlFor={`departure-condition-${bookingId}`}
            style={{
              fontSize: '0.875rem',
              fontWeight: 'var(--ut-weight-semibold)',
              color: 'var(--ut-color-ink)',
            }}
          >
            État de l’équipement avant remise :
          </label>
          <select
            id={`departure-condition-${bookingId}`}
            value={condition}
            onChange={(e) => setCondition(e.target.value as 'GOOD' | 'FAIR' | 'POOR')}
            disabled={loading}
            style={{
              width: '100%',
              padding: '0.6rem 0.75rem',
              borderRadius: 'var(--ut-radius-md)',
              border: 'var(--ut-border-thin)',
              fontSize: '0.9rem',
              background: 'var(--ut-color-surface)',
              color: 'var(--ut-color-ink)',
              minHeight: '44px',
            }}
          >
            <option value="GOOD">Très bon état / Prêt à rouler</option>
            <option value="FAIR">Bon état (traces d’usure normales)</option>
            <option value="POOR">À contrôler</option>
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          <label
            htmlFor={`departure-notes-${bookingId}`}
            style={{
              fontSize: '0.875rem',
              fontWeight: 'var(--ut-weight-semibold)',
              color: 'var(--ut-color-ink)',
            }}
          >
            Remarques ou accessoires fournis (facultatif) :
          </label>
          <input
            id={`departure-notes-${bookingId}`}
            type="text"
            placeholder="Ex : Casque et antivol remis, pression des pneus OK"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={loading}
            style={{
              width: '100%',
              padding: '0.6rem 0.75rem',
              borderRadius: 'var(--ut-radius-md)',
              border: 'var(--ut-border-thin)',
              fontSize: '0.9rem',
              background: 'var(--ut-color-surface)',
              color: 'var(--ut-color-ink)',
              minHeight: '44px',
            }}
          />
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.75rem',
            marginTop: '0.5rem',
            flexWrap: 'wrap',
          }}
        >
          <Button
            type="button"
            onClick={closeFlow}
            disabled={loading}
            variant="secondary"
            style={{ minHeight: '44px' }}
          >
            Annuler
          </Button>
          <Button type="submit" disabled={loading} variant="primary" style={{ minHeight: '44px' }}>
            {loading ? 'Validation en cours…' : '✓ Confirmer la remise au client'}
          </Button>
        </div>
      </form>
    </FlowDrawer>
  );
}
