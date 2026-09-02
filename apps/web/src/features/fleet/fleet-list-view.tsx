'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { InventorySummary } from '@uttily/core';
import {
  getInventoryConditionPresentation,
  getInventoryStatusPresentation,
} from '@/lib/status-presentation';
import { getCategoryPresentation } from '@/features/equipment/category-presentation';
import { transferInventoryItemsBatchAction } from '@/app/actions/inventory';
import { PageHeader, Card, Badge, LinkButton } from '@uttily/ui';
import { OpenMaintenanceModal } from './open-maintenance-modal';
import styles from './fleet.module.css';

function createIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

export interface FleetLocationOption {
  id: string;
  name: string;
}

export interface FleetListViewProps {
  organizationId: string;
  items: InventorySummary[];
  locations?: FleetLocationOption[];
  canManage: boolean;
}

export function FleetListView({
  organizationId,
  items,
  locations = [],
  canManage,
}: FleetListViewProps): React.ReactElement {
  const router = useRouter();
  const availableCount = items.filter(
    (i) => i.status === 'ACTIVE' && i.condition !== 'BROKEN',
  ).length;
  const maintenanceCount = items.filter((i) => i.condition === 'BROKEN').length;
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(() => new Set());
  const [isTransferOpen, setIsTransferOpen] = useState(false);
  const [targetLocationId, setTargetLocationId] = useState('');
  const [transferIdempotencyKey, setTransferIdempotencyKey] = useState(() =>
    createIdempotencyKey(),
  );
  const [isTransferring, setIsTransferring] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferResult, setTransferResult] = useState<string | null>(null);

  const selectableItems = items.map((i) => ({
    id: i.id,
    internalSku: i.internalSku,
    productName: `${i.productName} (${i.variantName})`,
    categorySlug: i.categorySlug,
  }));
  const selectedItems = items.filter((item) => selectedItemIds.has(item.id));
  const allItemsSelected = items.length > 0 && selectedItems.length === items.length;

  function toggleItem(itemId: string): void {
    setSelectedItemIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
    setTransferResult(null);
  }

  function toggleAllItems(): void {
    setSelectedItemIds(allItemsSelected ? new Set() : new Set(items.map((item) => item.id)));
    setTransferResult(null);
  }

  function openTransfer(): void {
    const firstDifferentLocation = locations.find(
      (location) => !selectedItems.some((item) => item.currentLocationId === location.id),
    );
    setTargetLocationId(firstDifferentLocation?.id ?? locations[0]?.id ?? '');
    setTransferIdempotencyKey(createIdempotencyKey());
    setTransferError(null);
    setTransferResult(null);
    setIsTransferOpen(true);
  }

  async function handleTransfer(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (selectedItems.length === 0) return;

    setIsTransferring(true);
    setTransferError(null);
    const formData = new FormData();
    for (const item of selectedItems) formData.append('inventoryItemId', item.id);
    formData.set('toLocationId', targetLocationId);
    formData.set('idempotencyKey', transferIdempotencyKey);

    try {
      const result = await transferInventoryItemsBatchAction(
        organizationId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );
      if (!result.ok) {
        setTransferError(result.message || 'Le transfert n’a pas pu être effectué.');
        return;
      }

      const { transferredCount, noOpCount } = result.data;
      if (transferredCount === 0) {
        setTransferResult(
          'Aucun transfert effectué : les exemplaires sont déjà dans cet établissement.',
        );
      } else if (noOpCount > 0) {
        setTransferResult(
          `${transferredCount} exemplaire(s) transféré(s) ; ${noOpCount} déjà dans cet établissement.`,
        );
      } else {
        setTransferResult(`${transferredCount} exemplaire(s) transféré(s) avec succès.`);
      }
      setSelectedItemIds(new Set());
      setIsTransferOpen(false);
      router.refresh();
    } catch (error) {
      setTransferError(
        error instanceof Error ? error.message : 'Le transfert n’a pas pu être effectué.',
      );
    } finally {
      setIsTransferring(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <PageHeader
        eyebrow="Inventaire physique"
        title="Flotte"
        description="Suivi unitaire de vos équipements en service, états et maintenance."
        actions={
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <LinkButton href={`/dashboard/${organizationId}/fleet/maintenance`} variant="secondary">
              Atelier ({maintenanceCount})
            </LinkButton>
            {canManage && items.length > 0 && (
              <OpenMaintenanceModal orgId={organizationId} items={selectableItems} />
            )}
            {canManage && (
              <LinkButton href={`/dashboard/${organizationId}/bikes`} variant="primary">
                Gérer mes équipements
              </LinkButton>
            )}
          </div>
        }
      />

      {/* Cartes de synthèse */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '1rem',
        }}
      >
        <Card
          style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}
        >
          <span
            style={{
              fontSize: '1.75rem',
              fontWeight: 'var(--ut-weight-bold)',
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            {items.length}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
            Équipements au total
          </span>
        </Card>
        <Card
          style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}
        >
          <span
            style={{
              fontSize: '1.75rem',
              fontWeight: 'var(--ut-weight-bold)',
              color: 'var(--ut-color-success)',
            }}
          >
            {availableCount}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
            Disponibles
          </span>
        </Card>
        <Card
          style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}
        >
          <span
            style={{
              fontSize: '1.75rem',
              fontWeight: 'var(--ut-weight-bold)',
              color: 'var(--ut-color-warning)',
            }}
          >
            {maintenanceCount}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
            En maintenance
          </span>
        </Card>
      </div>

      {items.length === 0 ? (
        <Card
          style={{
            textAlign: 'center',
            padding: '3.5rem 1.5rem',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '1rem',
          }}
        >
          <div style={{ fontSize: '3rem' }}>{getCategoryPresentation().icon}</div>
          <h2
            style={{
              fontSize: '1.25rem',
              fontWeight: 'var(--ut-weight-bold)',
              margin: 0,
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            Aucun équipement dans votre flotte
          </h2>
          <p style={{ color: 'var(--ut-color-ink-muted)', margin: 0, maxWidth: '28rem' }}>
            Ajoutez vos équipements depuis la rubrique Mes équipements pour les rendre disponibles à
            la location.
          </p>
          {canManage && (
            <LinkButton href={`/dashboard/${organizationId}/bikes/new`} variant="primary">
              Ajouter mon premier équipement
            </LinkButton>
          )}
        </Card>
      ) : (
        <>
          {canManage && selectedItems.length > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '1rem',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.9rem' }}>
                {selectedItems.length} exemplaire(s) sélectionné(s)
              </span>
              <button
                type="button"
                onClick={openTransfer}
                className={styles.maintenanceTriggerBtn}
                aria-haspopup="dialog"
              >
                Transférer vers un établissement
              </button>
            </div>
          )}
          {transferResult && (
            <p
              role="status"
              aria-live="polite"
              style={{ margin: 0, color: 'var(--ut-color-success)' }}
            >
              {transferResult}
            </p>
          )}
          <Card style={{ overflowX: 'auto', padding: 0 }}>
            <table className={styles.table} style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr
                  style={{
                    background: 'var(--ut-color-surface-soft)',
                    borderBottom: 'var(--ut-border-thin)',
                  }}
                >
                  {canManage && (
                    <th
                      style={{
                        padding: '0.85rem 1rem',
                        textAlign: 'left',
                        fontSize: '0.85rem',
                        color: 'var(--ut-color-ink-muted)',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={allItemsSelected}
                        onChange={toggleAllItems}
                        aria-label="Sélectionner tous les exemplaires"
                      />
                    </th>
                  )}
                  <th
                    style={{
                      padding: '0.85rem 1rem',
                      textAlign: 'left',
                      fontSize: '0.85rem',
                      color: 'var(--ut-color-ink-muted)',
                    }}
                  >
                    Référence exemplaire
                  </th>
                  <th
                    style={{
                      padding: '0.85rem 1rem',
                      textAlign: 'left',
                      fontSize: '0.85rem',
                      color: 'var(--ut-color-ink-muted)',
                    }}
                  >
                    Équipement / Version
                  </th>
                  <th
                    style={{
                      padding: '0.85rem 1rem',
                      textAlign: 'left',
                      fontSize: '0.85rem',
                      color: 'var(--ut-color-ink-muted)',
                    }}
                  >
                    N° de série
                  </th>
                  <th
                    style={{
                      padding: '0.85rem 1rem',
                      textAlign: 'left',
                      fontSize: '0.85rem',
                      color: 'var(--ut-color-ink-muted)',
                    }}
                  >
                    État
                  </th>
                  <th
                    style={{
                      padding: '0.85rem 1rem',
                      textAlign: 'left',
                      fontSize: '0.85rem',
                      color: 'var(--ut-color-ink-muted)',
                    }}
                  >
                    Statut
                  </th>
                  <th
                    style={{
                      padding: '0.85rem 1rem',
                      textAlign: 'left',
                      fontSize: '0.85rem',
                      color: 'var(--ut-color-ink-muted)',
                    }}
                  >
                    Établissement
                  </th>
                  <th
                    style={{
                      padding: '0.85rem 1rem',
                      textAlign: 'right',
                      fontSize: '0.85rem',
                      color: 'var(--ut-color-ink-muted)',
                    }}
                  ></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const isBroken = item.condition === 'BROKEN';
                  const conditionPresentation = getInventoryConditionPresentation(item.condition);
                  const statusPresentation = getInventoryStatusPresentation(item.status, isBroken);
                  const categoryPresentation = getCategoryPresentation(item.categorySlug);
                  const bikeLink = `/dashboard/${organizationId}/bikes/${item.productId}`;

                  return (
                    <tr key={item.id} style={{ borderBottom: 'var(--ut-border-thin)' }}>
                      {canManage && (
                        <td style={{ padding: '1rem' }}>
                          <input
                            type="checkbox"
                            checked={selectedItemIds.has(item.id)}
                            onChange={() => toggleItem(item.id)}
                            aria-label={`Sélectionner ${item.internalSku}`}
                          />
                        </td>
                      )}
                      <td style={{ padding: '1rem', fontWeight: 'var(--ut-weight-semibold)' }}>
                        <Link
                          href={bikeLink}
                          style={{ color: 'var(--ut-color-primary)', textDecoration: 'none' }}
                        >
                          {item.internalSku}
                        </Link>
                      </td>
                      <td style={{ padding: '1rem' }}>
                        <strong style={{ color: 'var(--ut-color-ink-strong)' }}>
                          {item.productName}
                        </strong>
                        <span
                          style={{
                            marginLeft: '0.5rem',
                            fontSize: '0.8rem',
                            background: 'var(--ut-color-surface-soft)',
                            padding: '0.2rem 0.5rem',
                            borderRadius: 'var(--ut-radius-sm)',
                          }}
                        >
                          {item.variantName}
                        </span>
                        <span
                          style={{
                            marginLeft: '0.5rem',
                            fontSize: '0.8rem',
                            color: 'var(--ut-color-ink-muted)',
                          }}
                        >
                          {categoryPresentation.icon} {categoryPresentation.singularLabel}
                        </span>
                      </td>
                      <td
                        style={{
                          padding: '1rem',
                          color: 'var(--ut-color-ink-muted)',
                          fontSize: '0.9rem',
                        }}
                      >
                        {item.serialNumber ?? '—'}
                      </td>
                      <td style={{ padding: '1rem' }}>
                        <Badge tone={isBroken ? 'danger' : 'success'}>
                          {conditionPresentation.label}
                        </Badge>
                      </td>
                      <td style={{ padding: '1rem' }}>
                        <Badge
                          tone={
                            isBroken ? 'warning' : item.status === 'ACTIVE' ? 'success' : 'neutral'
                          }
                        >
                          {statusPresentation.label}
                        </Badge>
                      </td>
                      <td
                        style={{
                          padding: '1rem',
                          color: 'var(--ut-color-ink-muted)',
                          fontSize: '0.9rem',
                        }}
                      >
                        📍 {item.locationName}
                      </td>
                      <td style={{ padding: '1rem', textAlign: 'right' }}>
                        <Link
                          href={bikeLink}
                          style={{
                            fontSize: '0.85rem',
                            color: 'var(--ut-color-primary)',
                            fontWeight: 'var(--ut-weight-semibold)',
                            textDecoration: 'none',
                          }}
                        >
                          Fiche équipement →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
          {isTransferOpen && (
            <div
              className={styles.modalOverlay}
              role="dialog"
              aria-modal="true"
              aria-labelledby="transfer-inventory-title"
              onClick={() => !isTransferring && setIsTransferOpen(false)}
            >
              <div className={styles.modalContent} onClick={(event) => event.stopPropagation()}>
                <div className={styles.modalHeader}>
                  <h3 id="transfer-inventory-title">Transférer vers un établissement</h3>
                  <button
                    type="button"
                    onClick={() => !isTransferring && setIsTransferOpen(false)}
                    className={styles.closeBtn}
                    disabled={isTransferring}
                    aria-label="Fermer"
                  >
                    ✕
                  </button>
                </div>

                <p className={styles.modalSub}>
                  Vous allez transférer {selectedItems.length} exemplaire(s). Vérifiez le résumé
                  avant de confirmer.
                </p>
                <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                  {selectedItems.slice(0, 10).map((item) => (
                    <li key={item.id}>
                      {item.internalSku} · {item.productName} ({item.variantName})
                    </li>
                  ))}
                  {selectedItems.length > 10 && <li>… et {selectedItems.length - 10} autre(s)</li>}
                </ul>

                <form onSubmit={handleTransfer} className={styles.form}>
                  {transferError && (
                    <div className={styles.formError} role="alert" aria-live="assertive">
                      {transferError}
                    </div>
                  )}
                  <div className={styles.formGroup}>
                    <label htmlFor="transfer-target-location">Établissement cible :</label>
                    <select
                      id="transfer-target-location"
                      value={targetLocationId}
                      onChange={(event) => setTargetLocationId(event.target.value)}
                      disabled={isTransferring || locations.length === 0}
                      className={styles.selectInput}
                      required
                    >
                      {locations.map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className={styles.modalSub}>
                    Le transfert ne change ni le statut, ni l’état, ni les réservations, ni la
                    disponibilité des exemplaires.
                  </p>
                  <div className={styles.modalFooter}>
                    <button
                      type="button"
                      onClick={() => setIsTransferOpen(false)}
                      disabled={isTransferring}
                      className={styles.cancelBtn}
                    >
                      Annuler
                    </button>
                    <button
                      type="submit"
                      disabled={isTransferring || locations.length === 0}
                      className={styles.submitBtn}
                    >
                      {isTransferring ? 'Transfert en cours…' : 'Confirmer le transfert'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
