'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, PageHeader } from '@uttily/ui';
import type { CounterAvailableItem } from '@uttily/core';
import {
  createCounterBookingAction,
  getCounterAvailableItemsAction,
} from '@/app/actions/counter-bookings';
import styles from './counter-booking.module.css';

interface CounterLocation {
  id: string;
  name: string;
  timeZone: string;
}

export interface CounterBookingViewProps {
  organizationId: string;
  locations: CounterLocation[];
  initialLocationId: string;
  initialItems: CounterAvailableItem[];
  defaultStartIso: string;
  defaultEndIso: string;
}

type ChannelType = 'WALK_IN' | 'PHONE';
type PaymentMethodType =
  'ON_SITE_CARD' | 'ON_SITE_CASH' | 'ON_SITE_CHECK' | 'ON_SITE_HOLIDAY_VOUCHER' | 'PAY_LATER';

type PresetType = '2h' | '4h' | 'day' | 'weekend' | 'custom';

function conditionBadgeTone(condition: 'NEW' | 'GOOD' | 'FAIR'): 'success' | 'info' | 'warning' {
  switch (condition) {
    case 'NEW':
      return 'success';
    case 'GOOD':
      return 'info';
    case 'FAIR':
      return 'warning';
  }
}

function conditionLabel(condition: 'NEW' | 'GOOD' | 'FAIR'): string {
  switch (condition) {
    case 'NEW':
      return 'Neuf';
    case 'GOOD':
      return 'Très bon état';
    case 'FAIR':
      return 'Bon état';
  }
}

export function CounterBookingView({
  organizationId,
  locations,
  initialLocationId,
  initialItems,
  defaultStartIso,
  defaultEndIso,
}: CounterBookingViewProps): React.ReactElement {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Contexte
  const [locationId, setLocationId] = useState(initialLocationId);
  const [channel, setChannel] = useState<ChannelType>('WALK_IN');
  const [activePreset, setActivePreset] = useState<PresetType>('2h');

  // Période
  const [startIso, setStartIso] = useState(defaultStartIso);
  const [endIso, setEndIso] = useState(defaultEndIso);

  // Équipements
  const [items, setItems] = useState<CounterAvailableItem[]>(initialItems);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [isFetchingItems, setIsFetchingItems] = useState(false);

  // Client
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');

  // Paiement
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodType>('ON_SITE_CARD');
  const [paymentRef, setPaymentRef] = useState('');
  const [notes, setNotes] = useState('');

  // Feedback
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectedLocation = locations.find((l) => l.id === locationId) ?? locations[0];

  // Rafraîchir les disponibilités
  async function refreshAvailability(newStart: string, newEnd: string, targetLocId = locationId) {
    setIsFetchingItems(true);
    setErrorMessage(null);
    try {
      const res = await getCounterAvailableItemsAction({
        organizationId,
        locationId: targetLocId,
        startAtIso: newStart,
        endAtIso: newEnd,
      });

      if (res.ok) {
        setItems(res.data.items);
        // Filtrer les items sélectionnés qui ne sont plus disponibles
        const availableIds = new Set(res.data.items.map((i) => i.id));
        setSelectedItemIds((prev) => prev.filter((id) => availableIds.has(id)));
      } else {
        setErrorMessage(res.message);
      }
    } catch {
      setErrorMessage('Erreur lors de la recherche des équipements disponibles.');
    } finally {
      setIsFetchingItems(false);
    }
  }

  // Gestion des presets rapides
  function applyPreset(preset: PresetType) {
    setActivePreset(preset);
    const now = new Date();
    // Arrondir aux 15 prochaines minutes
    now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15, 0, 0);

    let start = new Date(now);
    let end = new Date(now);

    switch (preset) {
      case '2h':
        end = new Date(start.getTime() + 2 * 3600_000);
        break;
      case '4h':
        end = new Date(start.getTime() + 4 * 3600_000);
        break;
      case 'day':
        start.setHours(9, 0, 0, 0);
        end = new Date(start);
        end.setHours(18, 0, 0, 0);
        break;
      case 'weekend':
        start = new Date(now);
        end = new Date(start.getTime() + 48 * 3600_000);
        break;
      case 'custom':
        return;
    }

    const newStartIso = start.toISOString();
    const newEndIso = end.toISOString();
    setStartIso(newStartIso);
    setEndIso(newEndIso);
    void refreshAvailability(newStartIso, newEndIso);
  }

  // Filtrer les équipements pour affichage
  const categories = Array.from(new Set(items.map((i) => i.categoryName)));
  const filteredItems = items.filter((item) => {
    const matchesCategory = categoryFilter === 'ALL' || item.categoryName === categoryFilter;
    const q = searchQuery.toLowerCase().trim();
    const matchesSearch =
      !q ||
      item.productName.toLowerCase().includes(q) ||
      item.internalSku.toLowerCase().includes(q) ||
      (item.serialNumber && item.serialNumber.toLowerCase().includes(q));
    return matchesCategory && matchesSearch;
  });

  // Toggle équipement
  function toggleItem(id: string) {
    setSelectedItemIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id],
    );
  }

  // Format local pour les inputs datetime-local (YYYY-MM-DDTHH:mm)
  function toDateTimeLocal(iso: string): string {
    const d = new Date(iso);
    const offset = d.getTimezoneOffset() * 60000;
    const local = new Date(d.getTime() - offset);
    return local.toISOString().slice(0, 16);
  }

  function fromDateTimeLocal(localStr: string): string {
    return new Date(localStr).toISOString();
  }

  // Soumission de la réservation comptoir
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);

    if (selectedItemIds.length === 0) {
      setErrorMessage('Veuillez sélectionner au moins un équipement disponible.');
      return;
    }

    if (!customerName.trim() || !customerEmail.trim()) {
      setErrorMessage('Le nom et l’adresse email du client sont requis.');
      return;
    }

    startTransition(async () => {
      const idempotencyKey = crypto.randomUUID();
      const res = await createCounterBookingAction({
        organizationId,
        locationId,
        channel,
        customerName: customerName.trim(),
        customerEmail: customerEmail.trim(),
        customerPhone: customerPhone.trim() || undefined,
        startAtIso: startIso,
        endAtIso: endIso,
        itemIds: selectedItemIds,
        paymentMethod,
        paymentReference: paymentRef.trim() || undefined,
        notes: notes.trim() || undefined,
        idempotencyKey,
      });

      if (res.ok) {
        router.push(
          `/dashboard/${organizationId}/bookings?locationId=${encodeURIComponent(locationId)}&createdBooking=${encodeURIComponent(res.data.bookingReference)}`,
        );
      } else {
        setErrorMessage(res.message);
      }
    });
  }

  return (
    <div className={styles.container}>
      <PageHeader
        eyebrow="Opérations · Comptoir"
        title="Nouvelle location comptoir"
        description="Créez une réservation immédiate pour un client au comptoir ou par téléphone avec allocation instantanée du matériel."
      />

      {errorMessage && <div className={styles.errorBanner}>⚠️ {errorMessage}</div>}

      <form onSubmit={handleSubmit} className={styles.layoutGrid}>
        {/* Colonne Gauche : Paramètres & Matériel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Établissement et Canal */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>📍 Établissement & Canal</span>
              <div className={styles.channelToggle}>
                <button
                  type="button"
                  className={`${styles.channelButton} ${channel === 'WALK_IN' ? styles.channelButtonActive : ''}`}
                  onClick={() => setChannel('WALK_IN')}
                >
                  🚶 Comptoir (Walk-in)
                </button>
                <button
                  type="button"
                  className={`${styles.channelButton} ${channel === 'PHONE' ? styles.channelButtonActive : ''}`}
                  onClick={() => setChannel('PHONE')}
                >
                  📞 Téléphone
                </button>
              </div>
            </div>

            <div className={styles.formField}>
              <label className={styles.label} htmlFor="locationSelect">
                Point de retrait
              </label>
              <select
                id="locationSelect"
                className={styles.select}
                value={locationId}
                onChange={(e) => {
                  const newLoc = e.target.value;
                  setLocationId(newLoc);
                  void refreshAvailability(startIso, endIso, newLoc);
                }}
              >
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name} · {loc.timeZone}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Créneaux & Durée */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>⏱️ Créneau & Durée</span>
              <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
                Fuseau : {selectedLocation?.timeZone}
              </span>
            </div>

            {/* Presets rapides */}
            <div className={styles.presetsGrid}>
              <button
                type="button"
                className={`${styles.presetButton} ${activePreset === '2h' ? styles.presetButtonActive : ''}`}
                onClick={() => applyPreset('2h')}
              >
                ⏱️ 2 Heures
              </button>
              <button
                type="button"
                className={`${styles.presetButton} ${activePreset === '4h' ? styles.presetButtonActive : ''}`}
                onClick={() => applyPreset('4h')}
              >
                ⛅ Demi-journée (4h)
              </button>
              <button
                type="button"
                className={`${styles.presetButton} ${activePreset === 'day' ? styles.presetButtonActive : ''}`}
                onClick={() => applyPreset('day')}
              >
                ☀️ Journée complète
              </button>
              <button
                type="button"
                className={`${styles.presetButton} ${activePreset === 'weekend' ? styles.presetButtonActive : ''}`}
                onClick={() => applyPreset('weekend')}
              >
                📅 2 Jours (Week-end)
              </button>
            </div>

            {/* Sélecteurs de date et heure */}
            <div className={styles.dateTimeGrid}>
              <div className={styles.formField}>
                <label className={styles.label} htmlFor="startInput">
                  Début de location
                </label>
                <input
                  id="startInput"
                  type="datetime-local"
                  className={styles.input}
                  value={toDateTimeLocal(startIso)}
                  onChange={(e) => {
                    setActivePreset('custom');
                    const nextStart = fromDateTimeLocal(e.target.value);
                    setStartIso(nextStart);
                    void refreshAvailability(nextStart, endIso);
                  }}
                  required
                />
              </div>

              <div className={styles.formField}>
                <label className={styles.label} htmlFor="endInput">
                  Fin de location
                </label>
                <input
                  id="endInput"
                  type="datetime-local"
                  className={styles.input}
                  value={toDateTimeLocal(endIso)}
                  onChange={(e) => {
                    setActivePreset('custom');
                    const nextEnd = fromDateTimeLocal(e.target.value);
                    setEndIso(nextEnd);
                    void refreshAvailability(startIso, nextEnd);
                  }}
                  required
                />
              </div>
            </div>
          </div>

          {/* Matériel disponible en direct */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>
                📦 Matériel disponible sur ce créneau ({items.length})
              </span>
              {isFetchingItems && (
                <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-primary, #0f766e)' }}>
                  Actualisation...
                </span>
              )}
            </div>

            {/* Filtres de recherche */}
            <div className={styles.inventoryFilterBar}>
              <input
                type="search"
                placeholder="Rechercher par modèle ou SKU..."
                className={styles.input}
                style={{ flex: 1, minWidth: '180px' }}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />

              <select
                className={styles.select}
                style={{ width: 'auto' }}
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
              >
                <option value="ALL">Toutes catégories</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            {/* Liste d'équipements */}
            <div className={styles.inventoryList}>
              {filteredItems.length === 0 ? (
                <div
                  style={{
                    padding: '2rem',
                    textAlign: 'center',
                    color: 'var(--ut-color-ink-muted)',
                  }}
                >
                  Aucun équipement disponible sur ce créneau.
                </div>
              ) : (
                filteredItems.map((item) => {
                  const isSelected = selectedItemIds.includes(item.id);
                  return (
                    <div
                      key={item.id}
                      className={`${styles.itemCard} ${isSelected ? styles.itemCardSelected : ''}`}
                      onClick={() => toggleItem(item.id)}
                    >
                      <div className={styles.itemInfo}>
                        <div className={styles.itemTitle}>{item.productName}</div>
                        <div className={styles.itemMeta}>
                          <span style={{ fontWeight: 600, color: 'var(--ut-color-ink)' }}>
                            {item.internalSku}
                          </span>
                          <span>·</span>
                          <span>{item.categoryName}</span>
                          {item.variantAttributes && (
                            <>
                              <span>·</span>
                              <span>
                                {JSON.stringify(item.variantAttributes).replace(/[{"}]/g, '')}
                              </span>
                            </>
                          )}
                          <span>·</span>
                          <Badge tone={conditionBadgeTone(item.condition)}>
                            {conditionLabel(item.condition)}
                          </Badge>
                        </div>
                      </div>

                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleItem(item.id)}
                        style={{ width: '20px', height: '20px', cursor: 'pointer' }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Colonne Droite : Fiche Client, Règlement & Validation */}
        <div className={styles.stickySummary}>
          {/* Fiche Client */}
          <div className={styles.sectionCard}>
            <span className={styles.sectionTitle}>👤 Coordonnées du client</span>

            <div className={styles.formField}>
              <label className={styles.label} htmlFor="customerName">
                Nom & Prénom *
              </label>
              <input
                id="customerName"
                type="text"
                className={styles.input}
                placeholder="Ex: Jean Dupont"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                required
              />
            </div>

            <div className={styles.formField}>
              <label className={styles.label} htmlFor="customerPhone">
                Téléphone de contact *
              </label>
              <input
                id="customerPhone"
                type="tel"
                className={styles.input}
                placeholder="Ex: 06 12 34 56 78"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
              />
            </div>

            <div className={styles.formField}>
              <label className={styles.label} htmlFor="customerEmail">
                Email *
              </label>
              <input
                id="customerEmail"
                type="email"
                className={styles.input}
                placeholder="Ex: jean.dupont@example.com"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                required
              />
            </div>
          </div>

          {/* Règlement au comptoir */}
          <div className={styles.sectionCard}>
            <span className={styles.sectionTitle}>💳 Règlement au comptoir</span>

            <div className={styles.paymentMethodsGrid}>
              <div
                className={`${styles.paymentOption} ${paymentMethod === 'ON_SITE_CARD' ? styles.paymentOptionSelected : ''}`}
                onClick={() => setPaymentMethod('ON_SITE_CARD')}
              >
                💳 Carte (TPE)
              </div>
              <div
                className={`${styles.paymentOption} ${paymentMethod === 'ON_SITE_CASH' ? styles.paymentOptionSelected : ''}`}
                onClick={() => setPaymentMethod('ON_SITE_CASH')}
              >
                💶 Espèces
              </div>
              <div
                className={`${styles.paymentOption} ${paymentMethod === 'ON_SITE_HOLIDAY_VOUCHER' ? styles.paymentOptionSelected : ''}`}
                onClick={() => setPaymentMethod('ON_SITE_HOLIDAY_VOUCHER')}
              >
                🎟️ Chèque-Vacances
              </div>
              <div
                className={`${styles.paymentOption} ${paymentMethod === 'ON_SITE_CHECK' ? styles.paymentOptionSelected : ''}`}
                onClick={() => setPaymentMethod('ON_SITE_CHECK')}
              >
                📝 Chèque
              </div>
            </div>

            <div
              className={`${styles.paymentOption} ${paymentMethod === 'PAY_LATER' ? styles.paymentOptionSelected : ''}`}
              onClick={() => setPaymentMethod('PAY_LATER')}
              style={{ marginTop: '0.25rem' }}
            >
              ⏳ Règlement ultérieur (au retour / à l’enlèvement)
            </div>

            <div className={styles.formField} style={{ marginTop: '0.5rem' }}>
              <label className={styles.label} htmlFor="paymentRef">
                Référence ticket / paiement (optionnel)
              </label>
              <input
                id="paymentRef"
                type="text"
                className={styles.input}
                placeholder="Ex: TPE-9482 ou N° Chèque"
                value={paymentRef}
                onChange={(e) => setPaymentRef(e.target.value)}
              />
            </div>

            <div className={styles.formField}>
              <label className={styles.label} htmlFor="notes">
                Notes opérationnelles (optionnel)
              </label>
              <textarea
                id="notes"
                className={styles.textarea}
                rows={2}
                placeholder="Caution déposée, casque fourni..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>

          {/* Validation & Total */}
          <div className={styles.sectionCard}>
            <div className={styles.summaryPriceBox}>
              <div className={styles.summaryPriceRow}>
                <span>Équipement(s) sélectionné(s)</span>
                <span style={{ fontWeight: 600 }}>{selectedItemIds.length}</span>
              </div>
              <div className={styles.summaryPriceRow}>
                <span>Canal</span>
                <span>{channel === 'WALK_IN' ? 'Comptoir direct' : 'Téléphone'}</span>
              </div>
              <div className={styles.summaryPriceRow}>
                <span>Paiement</span>
                <span>{paymentMethod === 'PAY_LATER' ? 'Au retour' : 'Règlement sur place'}</span>
              </div>
            </div>

            <Button
              type="submit"
              variant="primary"
              disabled={isPending || selectedItemIds.length === 0}
              style={{ minHeight: '48px', fontSize: '1rem', fontWeight: 600, width: '100%' }}
            >
              {isPending
                ? 'Création de la réservation...'
                : `Confirmer la location (${selectedItemIds.length} équipement${selectedItemIds.length > 1 ? 's' : ''})`}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
