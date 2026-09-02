'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  getSubstitutionCandidatesAction,
  substituteBookingItemAction,
} from '@/app/actions/fulfillment';
import type { SubstitutionCandidateOption } from '@uttily/core';
import { Button } from '@uttily/ui';
import { FlowDrawer } from './flow-drawer';

interface SubstitutionFlowProps {
  orgId: string;
  bookingId: string;
  bookingItemId: string;
  currentSku: string;
}

export function SubstitutionFlow({
  orgId,
  bookingId,
  bookingItemId,
  currentSku,
}: SubstitutionFlowProps): React.ReactElement {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [candidates, setCandidates] = useState<SubstitutionCandidateOption[]>([]);
  const [selectedSku, setSelectedSku] = useState('');
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  async function openFlow(): Promise<void> {
    idempotencyKey.current = crypto.randomUUID();
    setCandidates([]);
    setSelectedSku('');
    setError(null);
    setIsOpen(true);
    setLoadingCandidates(true);
    try {
      const result = await getSubstitutionCandidatesAction(orgId, bookingId, bookingItemId);
      if (!result.ok) {
        setError(result.message || 'Les exemplaires disponibles ne sont pas accessibles.');
        return;
      }
      setCandidates(result.data);
      setSelectedSku(result.data[0]?.internalSku ?? '');
    } catch {
      setError('Impossible de charger les exemplaires disponibles.');
    } finally {
      setLoadingCandidates(false);
    }
  }

  function closeFlow(): void {
    if (!loading && !loadingCandidates) setIsOpen(false);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selectedSku) {
      setError('Sélectionnez un exemplaire de remplacement.');
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('bookingId', bookingId);
      formData.append('bookingItemId', bookingItemId);
      formData.append('replacementSku', selectedSku);
      formData.append('idempotencyKey', idempotencyKey.current ?? crypto.randomUUID());
      const result = await substituteBookingItemAction(
        orgId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );
      if (!result.ok) {
        setError(result.message || 'La substitution n’a pas pu être effectuée.');
        return;
      }
      setIsOpen(false);
      router.refresh();
    } catch {
      setError('Impossible de substituer l’équipement pour le moment.');
    } finally {
      setLoading(false);
    }
  }

  if (!isOpen) {
    return (
      <Button type="button" onClick={() => void openFlow()} variant="secondary">
        Remplacer {currentSku}
      </Button>
    );
  }

  return (
    <FlowDrawer
      open={isOpen}
      title={`Remplacer l’équipement · ${currentSku}`}
      closeDisabled={loading || loadingCandidates}
      onClose={closeFlow}
    >
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
      >
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

        {loadingCandidates ? (
          <p>Recherche des exemplaires équivalents disponibles…</p>
        ) : candidates.length === 0 ? (
          <p role="status">Aucun exemplaire équivalent n’est disponible sur ce créneau.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <label
              htmlFor={`substitution-candidate-${bookingItemId}`}
              style={{
                color: 'var(--ut-color-ink)',
                fontSize: '0.875rem',
                fontWeight: 'var(--ut-weight-semibold)',
              }}
            >
              Nouvel exemplaire disponible
            </label>
            <select
              id={`substitution-candidate-${bookingItemId}`}
              value={selectedSku}
              onChange={(event) => setSelectedSku(event.target.value)}
              disabled={loading}
              required
              style={{
                background: 'var(--ut-color-surface)',
                border: 'var(--ut-border-thin)',
                borderRadius: 'var(--ut-radius-md)',
                color: 'var(--ut-color-ink)',
                minHeight: '44px',
                padding: '0.6rem 0.75rem',
                width: '100%',
              }}
            >
              {candidates.map((candidate) => (
                <option key={candidate.internalSku} value={candidate.internalSku}>
                  {candidate.internalSku}
                  {candidate.serialNumber ? ` · N° ${candidate.serialNumber}` : ''} ·{' '}
                  {candidate.condition}
                </option>
              ))}
            </select>
          </div>
        )}

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.75rem',
            justifyContent: 'flex-end',
          }}
        >
          <Button
            type="button"
            onClick={closeFlow}
            disabled={loading || loadingCandidates}
            variant="secondary"
          >
            Annuler
          </Button>
          <Button
            type="submit"
            disabled={loading || loadingCandidates || candidates.length === 0}
            variant="primary"
          >
            {loading ? 'Substitution…' : 'Confirmer la substitution'}
          </Button>
        </div>
      </form>
    </FlowDrawer>
  );
}
