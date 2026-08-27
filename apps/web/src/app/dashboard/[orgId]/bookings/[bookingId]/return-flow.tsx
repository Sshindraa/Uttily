'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createConditionReportAction,
  createDamageReportAction,
  returnBookingAction,
} from '@/app/actions/fulfillment';
import styles from './booking-detail.module.css';

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

        // 2. Si un dommage est signalé (Chantier 8D Damage -> Maintenance)
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inattendue.');
    } finally {
      setLoading(false);
    }
  }

  if (!isOpen) {
    return (
      <button type="button" onClick={() => setIsOpen(true)} className={styles.secondaryActionBtn}>
        🔵 Effectuer le retour du vélo →
      </button>
    );
  }

  return (
    <div className={styles.flowModal}>
      <div className={styles.flowHeader}>
        <h3>🔵 Réception &amp; Retour du vélo</h3>
        <button
          type="button"
          onClick={() => setIsOpen(false)}
          className={styles.closeBtn}
          disabled={loading}
        >
          ✕
        </button>
      </div>

      <form onSubmit={handleSubmit} className={styles.flowForm}>
        {error && <div className={styles.formError}>{error}</div>}

        <div className={styles.formGroup}>
          <label htmlFor="return-condition">État général au retour :</label>
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
            className={styles.selectInput}
          >
            <option value="GOOD">Très bon état / Conforme</option>
            <option value="FAIR">Bon état (usure normale)</option>
            <option value="POOR">À contrôler (bruit / réglage nécessaire)</option>
            <option value="BROKEN">Endommagé / Cassé</option>
          </select>
        </div>

        <div className={styles.formGroup}>
          <label htmlFor="return-notes">Notes de retour (facultatif) :</label>
          <input
            id="return-notes"
            type="text"
            placeholder="Ex : Propre, accessoires récupérés"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={loading}
            className={styles.textInput}
          />
        </div>

        {/* Déclaration de dommage / incident */}
        <div className={styles.damageBox}>
          <label className={styles.checkboxLabel}>
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
            <div className={styles.damageSubForm}>
              <label htmlFor="damage-desc">Description du problème constaté :</label>
              <textarea
                id="damage-desc"
                rows={2}
                placeholder="Ex : Rayure profonde sur le cadre côté droit, frein arrière à purger"
                value={damageDescription}
                onChange={(e) => setDamageDescription(e.target.value)}
                disabled={loading}
                className={styles.textArea}
                required={hasDamage}
              />

              <label className={styles.maintenanceCheckboxLabel}>
                <input
                  type="checkbox"
                  checked={requiresMaintenance}
                  onChange={(e) => setRequiresMaintenance(e.target.checked)}
                  disabled={loading}
                />
                <span>
                  🔧 <strong>Retirer temporairement ce vélo de la location</strong> (Mise en
                  maintenance immédiate)
                </span>
              </label>
            </div>
          )}
        </div>

        <div className={styles.flowFooter}>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            disabled={loading}
            className={styles.cancelBtn}
          >
            Annuler
          </button>
          <button type="submit" disabled={loading} className={styles.submitBtn}>
            {loading ? 'Validation en cours…' : '✓ Terminer le retour'}
          </button>
        </div>
      </form>
    </div>
  );
}
