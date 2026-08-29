'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createConditionReportAction, pickupBookingAction } from '@/app/actions/fulfillment';
import { Button } from '@uttily/ui';

interface DepartureFlowProps {
  orgId: string;
  bookingId: string;
  items: {
    bookingItemId: string;
    internalSku: string;
    serialNumber: string | null;
    currentCondition: string;
  }[];
}

export function DepartureFlow({ orgId, bookingId, items }: DepartureFlowProps): React.ReactElement {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [condition, setCondition] = useState<'GOOD' | 'FAIR' | 'POOR'>('GOOD');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstItem = items[0];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // 1. Enregistrer le rapport d'état au départ si un vélo existe
      if (firstItem) {
        const conditionFormData = new FormData();
        conditionFormData.append('bookingId', bookingId);
        conditionFormData.append('bookingItemId', firstItem.bookingItemId);
        conditionFormData.append('phase', 'PICKUP');
        conditionFormData.append('condition', condition);
        conditionFormData.append('notes', notes);
        conditionFormData.append('idempotencyKey', crypto.randomUUID());

        const conditionResult = await createConditionReportAction(
          orgId,
          { ok: false, code: 'UNKNOWN', message: '' },
          conditionFormData,
        );

        if (!conditionResult.ok) {
          setError(conditionResult.message || "Erreur lors de l'enregistrement de l'état du vélo");
          setLoading(false);
          return;
        }
      }

      // 2. Transitionner vers ACTIVE (Vélo remis au client)
      const transitionFormData = new FormData();
      transitionFormData.append('bookingId', bookingId);
      transitionFormData.append('idempotencyKey', crypto.randomUUID());

      const pickupResult = await pickupBookingAction(
        orgId,
        { ok: false, code: 'UNKNOWN', message: '' },
        transitionFormData,
      );

      if (!pickupResult.ok) {
        setError(pickupResult.message || 'Erreur lors du départ');
        setLoading(false);
        return;
      }

      setIsOpen(false);
      router.refresh();
    } catch {
      setError('Impossible de confirmer la remise du vélo pour le moment. Veuillez réessayer.');
    } finally {
      setLoading(false);
    }
  }

  if (!isOpen) {
    return (
      <Button
        type="button"
        onClick={() => setIsOpen(true)}
        variant="primary"
        style={{ minHeight: '44px' }}
      >
        🟢 Préparer &amp; Confirmer le départ →
      </Button>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="departure-flow-title"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        zIndex: 50,
      }}
    >
      <div
        style={{
          background: 'var(--ut-color-surface)',
          borderRadius: 'var(--ut-radius-lg)',
          boxShadow: 'var(--ut-shadow-lg)',
          maxWidth: '32rem',
          width: '100%',
          padding: '1.5rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.25rem',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3
            id="departure-flow-title"
            style={{
              fontSize: '1.15rem',
              fontWeight: 700,
              margin: 0,
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            🟢 Départ · Remise du vélo
          </h3>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            disabled={loading}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: '1.25rem',
              cursor: 'pointer',
              color: 'var(--ut-color-ink-muted)',
              padding: '0.25rem',
            }}
          >
            ✕
          </button>
        </div>

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
            <span style={{ color: 'var(--ut-color-success)', fontWeight: 700 }}>✓</span>
            <span>Réservation confirmée</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: 'var(--ut-color-success)', fontWeight: 700 }}>✓</span>
            <span>
              Référence vélo : <strong>{firstItem?.internalSku ?? '—'}</strong>
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
              htmlFor="departure-condition"
              style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--ut-color-ink)' }}
            >
              État du vélo avant remise :
            </label>
            <select
              id="departure-condition"
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
              htmlFor="departure-notes"
              style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--ut-color-ink)' }}
            >
              Remarques ou accessoires fournis (facultatif) :
            </label>
            <input
              id="departure-notes"
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
              onClick={() => setIsOpen(false)}
              disabled={loading}
              variant="secondary"
              style={{ minHeight: '44px' }}
            >
              Annuler
            </Button>
            <Button
              type="submit"
              disabled={loading}
              variant="primary"
              style={{ minHeight: '44px' }}
            >
              {loading ? 'Validation en cours…' : '✓ Confirmer la remise au client'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
