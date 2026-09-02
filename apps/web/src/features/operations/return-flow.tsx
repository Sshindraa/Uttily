'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createConditionReportAction,
  createDamageReportAction,
  returnBookingAction,
} from '@/app/actions/fulfillment';
import { Button } from '@uttily/ui';
import { FlowDrawer } from './flow-drawer';

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
  const [maintenanceDurationMinutes, setMaintenanceDurationMinutes] = useState(24 * 60);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKeys = useRef<Partial<Record<'condition' | 'damage' | 'return', string>>>({});
  const completedSteps = useRef({ condition: false, damage: false });
  const damageReportId = useRef<string | null>(null);

  const firstItem = items[0];
  const maintenanceRequested = condition === 'BROKEN' || (hasDamage && requiresMaintenance);

  function getIdempotencyKey(step: 'condition' | 'damage' | 'return'): string {
    const current = idempotencyKeys.current[step];
    if (current) return current;
    const next = crypto.randomUUID();
    idempotencyKeys.current[step] = next;
    return next;
  }

  function openFlow(): void {
    idempotencyKeys.current = {};
    completedSteps.current = { condition: false, damage: false };
    damageReportId.current = null;
    setCondition('GOOD');
    setNotes('');
    setHasDamage(false);
    setDamageDescription('');
    setRequiresMaintenance(false);
    setMaintenanceDurationMinutes(24 * 60);
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
      // 1. Enregistrer le rapport d'état au retour
      if (firstItem && !completedSteps.current.condition) {
        const conditionFormData = new FormData();
        conditionFormData.append('bookingId', bookingId);
        conditionFormData.append('bookingItemId', firstItem.bookingItemId);
        conditionFormData.append('phase', 'RETURN');
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
            conditionResult.message || "Erreur lors de l'enregistrement de l'état de retour",
          );
          return;
        }
        completedSteps.current.condition = true;
      }

      // 2. Si un dommage est signalé. Cette étape reste indépendante de la
      // précédente afin qu'un retry après un échec de clôture ne la rejoue pas.
      // Le bloc de maintenance est volontairement posé par returnBooking dans
      // la transaction de restitution : créer le bloc ici entrerait en conflit
      // avec le bloc BOOKING encore actif.
      if (
        firstItem &&
        hasDamage &&
        damageDescription.trim().length > 0 &&
        !completedSteps.current.damage
      ) {
        const damageFormData = new FormData();
        damageFormData.append('bookingId', bookingId);
        damageFormData.append('bookingItemId', firstItem.bookingItemId);
        damageFormData.append('description', damageDescription.trim());
        damageFormData.append('idempotencyKey', getIdempotencyKey('damage'));

        const damageResult = await createDamageReportAction(
          orgId,
          { ok: false, code: 'UNKNOWN', message: '' },
          damageFormData,
        );

        if (!damageResult.ok) {
          setError(damageResult.message || "Erreur lors de l'enregistrement du dommage");
          return;
        }
        completedSteps.current.damage = true;
        damageReportId.current = damageResult.data.reportId;
      }

      // 3. Transitionner vers RETURNED
      const transitionFormData = new FormData();
      transitionFormData.append('bookingId', bookingId);
      transitionFormData.append('idempotencyKey', getIdempotencyKey('return'));
      if (firstItem && maintenanceRequested) {
        transitionFormData.append('maintenanceEnabled', 'true');
        transitionFormData.append('maintenanceBookingItemId', firstItem.bookingItemId);
        transitionFormData.append('maintenanceDurationMinutes', String(maintenanceDurationMinutes));
        if (damageReportId.current) {
          transitionFormData.append('sourceDamageReportId', damageReportId.current);
        }
      }

      const returnResult = await returnBookingAction(
        orgId,
        { ok: false, code: 'UNKNOWN', message: '' },
        transitionFormData,
      );

      if (!returnResult.ok) {
        setError(returnResult.message || 'Erreur lors de la clôture du retour');
        return;
      }

      setIsOpen(false);
      router.refresh();
    } catch {
      setError(
        'Impossible d’enregistrer le retour de l’équipement pour le moment. Veuillez réessayer.',
      );
    } finally {
      setLoading(false);
    }
  }

  if (!isOpen) {
    return (
      <Button type="button" onClick={openFlow} variant="secondary" style={{ minHeight: '44px' }}>
        🔵 Effectuer le retour de l’équipement →
      </Button>
    );
  }

  return (
    <FlowDrawer
      open={isOpen}
      title="🔵 Réception & Retour de l’équipement"
      closeDisabled={loading}
      onClose={closeFlow}
    >
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
            htmlFor={`return-condition-${bookingId}`}
            style={{
              fontSize: '0.875rem',
              fontWeight: 'var(--ut-weight-semibold)',
              color: 'var(--ut-color-ink)',
            }}
          >
            État de l’équipement au retour :
          </label>
          <select
            id={`return-condition-${bookingId}`}
            value={condition}
            onChange={(e) => {
              const val = e.target.value as 'GOOD' | 'FAIR' | 'POOR' | 'BROKEN';
              setCondition(val);
              if (val === 'BROKEN' || val === 'POOR') {
                setHasDamage(true);
                if (!damageDescription) {
                  setDamageDescription('Signalé lors du retour locataire.');
                }
              }
              if (val === 'BROKEN') setRequiresMaintenance(true);
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
            htmlFor={`return-notes-${bookingId}`}
            style={{
              fontSize: '0.875rem',
              fontWeight: 'var(--ut-weight-semibold)',
              color: 'var(--ut-color-ink)',
            }}
          >
            Notes de retour (facultatif) :
          </label>
          <input
            id={`return-notes-${bookingId}`}
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
              fontWeight: 'var(--ut-weight-semibold)',
            }}
          >
            <input
              type="checkbox"
              checked={hasDamage}
              onChange={(e) => {
                setHasDamage(e.target.checked);
                if (!e.target.checked) setRequiresMaintenance(false);
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
                  htmlFor={`damage-desc-${bookingId}`}
                  style={{
                    fontSize: '0.85rem',
                    fontWeight: 'var(--ut-weight-semibold)',
                    color: 'var(--ut-color-ink)',
                  }}
                >
                  Description du problème constaté :
                </label>
                <textarea
                  id={`damage-desc-${bookingId}`}
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
                  checked={maintenanceRequested}
                  onChange={(e) => setRequiresMaintenance(e.target.checked)}
                  disabled={loading || condition === 'BROKEN'}
                />
                <span>Nécessite une maintenance immédiate (retirer de la location)</span>
              </label>
            </div>
          )}

          {maintenanceRequested && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
                paddingTop: '0.5rem',
                borderTop: 'var(--ut-border-thin)',
              }}
            >
              <label
                htmlFor={`return-maintenance-duration-${bookingId}`}
                style={{
                  fontSize: '0.85rem',
                  fontWeight: 'var(--ut-weight-semibold)',
                  color: 'var(--ut-color-ink)',
                }}
              >
                Durée estimée d’indisponibilité :
              </label>
              <select
                id={`return-maintenance-duration-${bookingId}`}
                value={maintenanceDurationMinutes}
                onChange={(e) => setMaintenanceDurationMinutes(Number(e.target.value))}
                disabled={loading}
                style={{
                  width: '100%',
                  padding: '0.6rem 0.75rem',
                  borderRadius: 'var(--ut-radius-md)',
                  border: 'var(--ut-border-thin)',
                  fontSize: '0.875rem',
                  background: 'var(--ut-color-surface)',
                  color: 'var(--ut-color-ink)',
                  minHeight: '44px',
                }}
              >
                <option value={4 * 60}>4 heures</option>
                <option value={24 * 60}>24 heures</option>
                <option value={48 * 60}>48 heures</option>
                <option value={7 * 24 * 60}>7 jours</option>
              </select>
              <p
                role="status"
                style={{
                  margin: 0,
                  color: 'var(--ut-color-ink-muted)',
                  fontSize: '0.8rem',
                  lineHeight: 1.4,
                }}
              >
                {firstItem?.internalSku ?? 'Cet exemplaire'} sera marqué BROKEN et bloqué dès la
                restitution. Une réservation ferme qui chevauche cette période sera signalée à
                l’équipe pour substitution proactive.
              </p>
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
            onClick={closeFlow}
            disabled={loading}
            variant="secondary"
            style={{ minHeight: '44px' }}
          >
            Annuler
          </Button>
          <Button type="submit" disabled={loading} variant="primary" style={{ minHeight: '44px' }}>
            {loading ? 'Validation en cours…' : '✓ Valider le retour'}
          </Button>
        </div>
      </form>
    </FlowDrawer>
  );
}
