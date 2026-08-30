'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { UnifiedBikeInventoryItem } from '@uttily/core';
import {
  createInventoryItemAction,
  updateInventoryItemAction,
  retireInventoryItemAction,
} from '@/app/actions/inventory';
import { buildInventorySku } from '@/lib/inventory-sku';
import styles from './components.module.css';

interface InventoryActionsProps {
  organizationId: string;
  variantId: string;
  locations: Array<{ id: string; name: string }>;
  items: UnifiedBikeInventoryItem[];
}

export function InventoryActions({
  organizationId,
  variantId,
  locations,
  items,
}: InventoryActionsProps): React.ReactElement {
  const router = useRouter();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [sku, setSku] = useState(() => buildSuggestedInventorySku());
  const [serialNumber, setSerialNumber] = useState('');
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAddItem(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const formData = new FormData();
      formData.set('productVariantId', variantId);
      formData.set('internalSku', sku);
      if (serialNumber) formData.set('serialNumber', serialNumber);
      formData.set('currentLocationId', locationId);
      formData.set('status', 'ACTIVE');
      formData.set('condition', 'NEW');

      const res = await createInventoryItemAction(
        organizationId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );

      if (!res.ok) {
        throw new Error(res.message || 'Erreur lors de l’ajout de l’exemplaire.');
      }

      setIsAddOpen(false);
      setSku(buildSuggestedInventorySku());
      setSerialNumber('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue.');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleChangeStatus(
    itemId: string,
    newStatus: 'ACTIVE' | 'MAINTENANCE' | 'RETIRED',
  ): Promise<void> {
    setError(null);
    setIsLoading(true);
    try {
      if (newStatus === 'RETIRED') {
        const formData = new FormData();
        formData.set('itemId', itemId);
        const res = await retireInventoryItemAction(
          organizationId,
          { ok: false, code: 'UNKNOWN', message: '' },
          formData,
        );
        if (!res.ok) throw new Error(res.message || 'Erreur lors du retrait de l’exemplaire.');
      } else {
        const formData = new FormData();
        formData.set('itemId', itemId);
        formData.set('status', newStatus);
        const res = await updateInventoryItemAction(
          organizationId,
          { ok: false, code: 'UNKNOWN', message: '' },
          formData,
        );
        if (!res.ok) throw new Error(res.message || 'Erreur lors de la mise à jour du statut.');
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue.');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          type="button"
          onClick={() => {
            setSku(buildSuggestedInventorySku());
            setIsAddOpen(true);
          }}
          className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
        >
          ➕ Ajouter un exemplaire
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: '10px',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#b91c1c',
            borderRadius: '8px',
            fontSize: '0.85rem',
          }}
        >
          {error}
        </div>
      )}

      {/* Tableau des exemplaires physiques */}
      {items.length > 0 ? (
        <table className={styles.itemsTable}>
          <thead>
            <tr>
              <th>Référence exemplaire</th>
              <th>N° Série</th>
              <th>Statut</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td style={{ fontWeight: 700 }}>{item.sku || '—'}</td>
                <td style={{ color: '#64748b' }}>{item.serialNumber || '—'}</td>
                <td>
                  {item.status === 'ACTIVE' && (
                    <span className={`${styles.fleetCountBadge} ${styles.fleetBadgeActive}`}>
                      🟢 En service
                    </span>
                  )}
                  {item.status === 'MAINTENANCE' && (
                    <span className={`${styles.fleetCountBadge} ${styles.fleetBadgeMaintenance}`}>
                      🟠 Maintenance
                    </span>
                  )}
                  {item.status === 'RETIRED' && (
                    <span className={`${styles.fleetCountBadge} ${styles.fleetBadgeRetired}`}>
                      ⚫ Retiré
                    </span>
                  )}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {item.status === 'ACTIVE' && (
                      <button
                        type="button"
                        onClick={() => handleChangeStatus(item.id, 'MAINTENANCE')}
                        disabled={isLoading}
                        className={styles.actionBtn}
                        style={{ fontSize: '0.78rem', padding: '4px 8px' }}
                      >
                        Passer en maintenance
                      </button>
                    )}
                    {item.status === 'MAINTENANCE' && (
                      <button
                        type="button"
                        onClick={() => handleChangeStatus(item.id, 'ACTIVE')}
                        disabled={isLoading}
                        className={styles.actionBtn}
                        style={{ fontSize: '0.78rem', padding: '4px 8px', color: '#059669' }}
                      >
                        Remettre en service
                      </button>
                    )}
                    {item.status !== 'RETIRED' && (
                      <button
                        type="button"
                        onClick={() => handleChangeStatus(item.id, 'RETIRED')}
                        disabled={isLoading}
                        className={styles.actionBtn}
                        style={{ fontSize: '0.78rem', padding: '4px 8px', color: '#dc2626' }}
                      >
                        Retirer
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div
          style={{
            padding: '16px',
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: '12px',
            textAlign: 'center',
          }}
        >
          <p style={{ margin: 0, fontSize: '0.9rem', color: '#64748b' }}>
            Aucun exemplaire enregistré. Cliquez sur « Ajouter un exemplaire » pour renseigner vos
            premiers équipements en boutique.
          </p>
        </div>
      )}

      {/* Drawer / Modal d'ajout */}
      {isAddOpen && (
        <div className={styles.drawerOverlay} onClick={() => !isLoading && setIsAddOpen(false)}>
          <div
            className={styles.drawerContent}
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-bike-drawer-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.drawerHeader}>
              <h3 id="add-bike-drawer-title" className={styles.drawerTitle}>
                🧰 Ajouter un exemplaire à la flotte
              </h3>
              <button
                type="button"
                onClick={() => !isLoading && setIsAddOpen(false)}
                className={styles.closeBtn}
                disabled={isLoading}
                aria-label="Fermer"
              >
                ✕
              </button>
            </div>

            <form
              onSubmit={handleAddItem}
              style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
            >
              <div className={styles.formGroup}>
                <label htmlFor="bike-sku" className={styles.formLabel}>
                  Référence exemplaire (ex : EQP-001) :
                </label>
                <input
                  id="bike-sku"
                  type="text"
                  value={sku}
                  onChange={(e) => setSku(e.target.value)}
                  className={styles.inputField}
                  required
                  disabled={isLoading}
                />
              </div>

              <div className={styles.formGroup}>
                <label htmlFor="bike-serial" className={styles.formLabel}>
                  Numéro de série du cadre (optionnel) :
                </label>
                <input
                  id="bike-serial"
                  type="text"
                  value={serialNumber}
                  onChange={(e) => setSerialNumber(e.target.value)}
                  className={styles.inputField}
                  placeholder="ex: SN-2026-98124"
                  disabled={isLoading}
                />
              </div>

              <div className={styles.formGroup}>
                <label htmlFor="bike-location" className={styles.formLabel}>
                  Boutique / Point de retrait :
                </label>
                <select
                  id="bike-location"
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  className={styles.inputField}
                  required
                  disabled={isLoading}
                >
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className={styles.drawerFooter}>
                <button
                  type="button"
                  onClick={() => setIsAddOpen(false)}
                  disabled={isLoading}
                  className={styles.actionBtn}
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={isLoading}
                  className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
                >
                  {isLoading ? 'Ajout en cours…' : 'Ajouter l’exemplaire à la flotte'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function buildSuggestedInventorySku(): string {
  return buildInventorySku('EQP', 1, globalThis.crypto.randomUUID());
}
