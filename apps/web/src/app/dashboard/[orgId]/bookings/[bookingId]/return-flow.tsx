'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createConditionReportAction,
  createDamageReportAction,
  returnBookingAction,
} from '@/app/actions/fulfillment';
import { Button } from '@uttily/ui';

interface ReturnFlowProps {
  orgId: string;
  bookingId: string;
  items: {
    bookingItemId: string;
    internalSku: string;
    serialNumber: string | null;
    currentCondition: string;
  }[];
}

export function ReturnFlow({ orgId, bookingId, items }: ReturnFlowProps): React.ReactElement {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [condition, setCondition] = useState<'GOOD' | 'FAIR' | 'POOR' | 'BROKEN'>('GOOD');
  const [notes, setNotes] = useState('');
  const [hasDamage, setHasDamage] = useState(false);
  const [damageDescription, setDamageDescription] = useState('');
  const [requiresMaintenance, setRequiresMaintenance] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstItem = items[0];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // 1. Enregistrer le rapport d'état au retour
      if (firstItem) {
        const conditionFormData = new FormData();
        conditionFormData.append('bookingId', bookingId);
        conditionFormData.append('bookingItemId', firstItem.bookingItemId);
        conditionFormData.append('phase', 'RETURN');
        conditionFormData.append('condition', condition);
        conditionFormData.append('notes', notes);
        conditionFormData.append('idempotencyKey', crypto.randomUUID());

        const conditionResult = await createConditionReportAction(
          orgId,
          { ok: false, code: 'UNKNOWN', message: '' },
          conditionFormData,
        );

        if (!conditionResult.ok) {
          setError(
            conditionResult.message || "Erreur lors de l'enregistrement de l'état de retour",
          );
          setLoading(false);
          return;
        }

        // 2. Si un dommage est signalé
        if (hasDamage && damageDescription.trim().length > 0) {
          const damageFormData = new FormData();
          damageFormData.append('bookingId', bookingId);
          damageFormData.append('bookingItemId', firstItem.bookingItemId);
          damageFormData.append('description', damageDescription.trim());
          damageFormData.append('idempotencyKey', crypto.randomUUID());
          if (requiresMaintenance) {
            damageFormData.append('blocksInventory', 'true');
          }

          const damageResult = await createDamageReportAction(
            orgId,
            { ok: false, code: 'UNKNOWN', message: '' },
            damageFormData,
          );

          if (!damageResult.ok) {
            setError(damageResult.message || "Erreur lors de l'enregistrement du dommage");
            setLoading(false);
            return;
          }
        }
      }

      // 3. Transitionner vers RETURNED
      const transitionFormData = new FormData();
      transitionFormData.append('bookingId', bookingId);
      transitionFormData.append('idempotencyKey', crypto.randomUUID());

      const returnResult = await returnBookingAction(
        orgId,
        { ok: false, code: 'UNKNOWN', message: '' },
        transitionFormData,
      );

      if (!returnResult.ok) {
        setError(returnResult.message || 'Erreur lors de la clôture du retour');
        setLoading(false);
        return;
      }

      setIsOpen(false);
      router.refresh();
    } catch {
      setError('Impossible d’enregistrer le retour du vélo pour le moment. Veuillez réessayer.');
    } finally {
      setLoading(false);
    }
  }

  if (!isOpen) {
    return (
      <Button
        type="button"
        onClick={() => setIsOpen(true)}
        variant="secondary"
        style={{ minHeight: '44px' }}
      >
        🔵 Effectuer le retour du vélo →
      </Button>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="return-flow-title"
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
          maxWidth: '34rem',
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
            id="return-flow-title"
            style={{
              fontSize: '1.15rem',
              fontWeight: 700,
              margin: 0,
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            🔵 Réception &amp; Retour du vélo
          </h3>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            disabled={loading}
            aria-label="Fermer"
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
              htmlFor="return-condition"
              style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--ut-color-ink)' }}
            >
              État du vélo au retour :
            </label>
            <select
              id="return-condition"
              value={condition}
              onChange={(e) => {
                const val = e.target.value as 'GOOD' | 'FAIR' | 'POOR' | 'BROKEN';
                setCondition(val);
                if (val === 'BROKEN' || val === 'POOR') {
                  setHasDamage(true);
                  setRequiresMaintenance(true);
                }
              }}
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
              <option value="GOOD">Très bon état / Conforme</option>
              <option value="FAIR">Bon état (usure normale)</option>
              <option value="POOR">À contrôler (bruit / réglage nécessaire)</option>
              <option value="BROKEN">Endommagé / Cassé</option>
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <label
              htmlFor="return-notes"
              style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--ut-color-ink)' }}
            >
              Notes de retour (facultatif) :
            </label>
            <input
              id="return-notes"
              type="text"
              placeholder="Ex : Propre, accessoires récupérés"
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

          {/* Déclaration de dommage / incident */}
          <div
            style={{
              background: 'var(--ut-color-surface-soft)',
              padding: '1rem',
              borderRadius: 'var(--ut-radius-md)',
              border: 'var(--ut-border-thin)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                cursor: 'pointer',
                fontSize: '0.875rem',
                fontWeight: 600,
              }}
            >
              <input
                type="checkbox"
                checked={hasDamage}
                onChange={(e) => {
                  setHasDamage(e.target.checked);
                  if (e.target.checked && !damageDescription) {
                    setDamageDescription('Signalé lors du retour locataire.');
                  }
                }}
                disabled={loading}
              />
              <span>⚠️ Signaler une anomalie ou un dommage constaté</span>
            </label>

            {hasDamage && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.75rem',
                  paddingTop: '0.5rem',
                  borderTop: 'var(--ut-border-thin)',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  <label
                    htmlFor="damage-desc"
                    style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--ut-color-ink)' }}
                  >
                    Description du problème constaté :
                  </label>
                  <textarea
                    id="damage-desc"
                    rows={2}
                    placeholder="Ex : Rayure profonde, frein arrière désaligné..."
                    value={damageDescription}
                    onChange={(e) => setDamageDescription(e.target.value)}
                    disabled={loading}
                    style={{
                      width: '100%',
                      padding: '0.5rem 0.75rem',
                      borderRadius: 'var(--ut-radius-md)',
                      border: 'var(--ut-border-thin)',
                      fontSize: '0.875rem',
                      background: 'var(--ut-color-surface)',
                      color: 'var(--ut-color-ink)',
                    }}
                  />
                </div>

                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    cursor: 'pointer',
                    fontSize: '0.85rem',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={requiresMaintenance}
                    onChange={(e) => setRequiresMaintenance(e.target.checked)}
                    disabled={loading}
                  />
                  <span>Retirer temporairement ce vélo de la location (envoyer en atelier)</span>
                </label>
              </div>
            )}
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
              {loading ? 'Validation en cours…' : '✓ Valider le retour'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
