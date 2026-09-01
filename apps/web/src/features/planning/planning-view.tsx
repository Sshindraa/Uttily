'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { OperationalPlanning } from '@uttily/core';
import { formatDateTimeInTimeZone } from '@/lib/operations-helpers';
import styles from './planning.module.css';

export interface PlanningViewProps {
  orgId: string;
  planning: OperationalPlanning;
  locations: { id: string; name: string }[];
  selectedLocationId: string | null;
}

function getLocalDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addCivilDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  date.setUTCDate(date.getUTCDate() + days);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
}

function formatLocalDateKey(dateKey: string): { label: string; shortLabel: string } {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = get('weekday');
  const day = get('day');
  const month = get('month');
  const capitalizedWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return {
    label: `${capitalizedWeekday} ${day} ${month}`,
    shortLabel: `${weekday.slice(0, 3)}. ${day}`,
  };
}

export function PlanningView({
  orgId,
  planning,
  locations,
  selectedLocationId,
}: PlanningViewProps): React.ReactElement {
  const [viewMode, setViewMode] = useState<'PLANNING' | 'FLEET'>('PLANNING');

  // Construction des 7 jours de la fenêtre
  const days: { dateStr: string; label: string; shortLabel: string }[] = [];
  const firstDateKey = getLocalDateKey(planning.from, planning.locationTimeZone);

  for (let i = 0; i < 7; i++) {
    const dateStr = addCivilDays(firstDateKey, i);
    const { label, shortLabel } = formatLocalDateKey(dateStr);

    days.push({
      dateStr,
      label,
      shortLabel,
    });
  }

  // Filtrage des événements par jour
  function getDayEvents(dayDateStr: string) {
    const pickUps = planning.events.filter(
      (e) => e.type === 'PICKUP' && getLocalDateKey(e.startAt, e.locationTimeZone) === dayDateStr,
    );
    const returns = planning.events.filter(
      (e) => e.type === 'RETURN' && getLocalDateKey(e.endAt, e.locationTimeZone) === dayDateStr,
    );
    const maintenances = planning.events.filter((e) => {
      if (e.type !== 'MAINTENANCE') return false;
      const mStart = getLocalDateKey(e.startAt, e.locationTimeZone);
      const mEnd = getLocalDateKey(e.endAt, e.locationTimeZone);
      return dayDateStr >= mStart && dayDateStr <= mEnd;
    });

    return { pickUps, returns, maintenances };
  }

  // Vérification de l'état d'un exemplaire pour une journée donnée (Vue Flotte)
  function getItemDayStatus(itemId: string, dayDateStr: string) {
    const isMaintenance = planning.events.find((e) => {
      if (e.type !== 'MAINTENANCE' || e.inventoryItemId !== itemId) return false;
      const mStart = getLocalDateKey(e.startAt, e.locationTimeZone);
      const mEnd = getLocalDateKey(e.endAt, e.locationTimeZone);
      return dayDateStr >= mStart && dayDateStr <= mEnd;
    });

    if (isMaintenance) {
      return {
        status: 'MAINTENANCE' as const,
        label: '🔧 En maintenance',
        link: `/dashboard/${orgId}/fleet/maintenance/${isMaintenance.maintenanceCaseId ?? ''}`,
      };
    }

    const isRented = planning.events.find((e) => {
      if (e.type !== 'RENTAL' || e.inventoryItemId !== itemId) return false;
      const rStart = getLocalDateKey(e.startAt, e.locationTimeZone);
      const rEnd = getLocalDateKey(e.endAt, e.locationTimeZone);
      return dayDateStr >= rStart && dayDateStr <= rEnd;
    });

    if (isRented) {
      return {
        status: 'RENTED' as const,
        label: '🔵 Loué',
        link: `/dashboard/${orgId}/bookings/${isRented.bookingId ?? ''}`,
      };
    }

    return {
      status: 'AVAILABLE' as const,
      label: '🟢 Disponible',
      link: `/dashboard/${orgId}/fleet`,
    };
  }

  const router = useRouter();

  return (
    <div className={styles.container}>
      {/* En-tête & Contrôles */}
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.pageTitle}>📅 Planning Opérationnel</h1>
          <p className={styles.pageSubtitle}>
            Vue d'ensemble des départs, retours et disponibilités de votre flotte · Fuseau :{' '}
            <strong>{planning.locationTimeZone}</strong>
          </p>
        </div>

        <div className={styles.controlsRow}>
          {/* Sélecteur d'établissement */}
          {locations.length > 1 && (
            <select
              value={selectedLocationId ?? ''}
              onChange={(e) =>
                router.push(`/dashboard/${orgId}/bookings/planning?locationId=${e.target.value}`)
              }
              className={styles.locationSelect}
            >
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  📍 {loc.name}
                </option>
              ))}
            </select>
          )}

          {/* Sélecteur de vue */}
          <div className={styles.viewToggle}>
            <button
              type="button"
              className={`${styles.toggleBtn} ${viewMode === 'PLANNING' ? styles.toggleActive : ''}`}
              onClick={() => setViewMode('PLANNING')}
            >
              📋 Vue Planning
            </button>
            <button
              type="button"
              className={`${styles.toggleBtn} ${viewMode === 'FLEET' ? styles.toggleActive : ''}`}
              onClick={() => setViewMode('FLEET')}
            >
              🚲 Vue Flotte
            </button>
          </div>
        </div>
      </div>

      {/* 4 Chiffres Clés de la Semaine */}
      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <span className={`${styles.statNumber} ${styles.statGreen}`}>
            ↓ {planning.stats.totalPickups}
          </span>
          <span className={styles.statLabel}>Départs prévus cette semaine</span>
        </div>

        <div className={styles.statCard}>
          <span className={`${styles.statNumber} ${styles.statBlue}`}>
            ↑ {planning.stats.totalReturns}
          </span>
          <span className={styles.statLabel}>Retours prévus cette semaine</span>
        </div>

        <div className={styles.statCard}>
          <span className={styles.statNumber}>🔵 {planning.stats.totalRentals}</span>
          <span className={styles.statLabel}>Locations en cours / confirmées</span>
        </div>

        <div className={styles.statCard}>
          <span className={`${styles.statNumber} ${styles.statAmber}`}>
            🔧 {planning.stats.totalMaintenances}
          </span>
          <span className={styles.statLabel}>Équipements en maintenance</span>
        </div>
      </div>

      {/* Contenu selon le mode sélectionné */}
      {viewMode === 'PLANNING' ? (
        /* VUE 1 : PLANNING JOUR PAR JOUR */
        <div className={styles.daysGrid}>
          {days.map((day) => {
            const { pickUps, returns, maintenances } = getDayEvents(day.dateStr);
            const totalDayEvents = pickUps.length + returns.length + maintenances.length;

            return (
              <div key={day.dateStr} className={styles.dayColumn}>
                <div className={styles.dayHeader}>
                  <h3>{day.label}</h3>
                  <span className={styles.dayBadge}>
                    {totalDayEvents} événement{totalDayEvents > 1 ? 's' : ''}
                  </span>
                </div>

                <div className={styles.dayEvents}>
                  {totalDayEvents === 0 ? (
                    <div className={styles.emptyDay}>Aucun mouvement</div>
                  ) : (
                    <>
                      {/* Départs */}
                      {pickUps.map((p) => (
                        <Link
                          key={p.id}
                          href={`/dashboard/${orgId}/bookings/${p.bookingId}`}
                          className={`${styles.eventCard} ${styles.eventPickup}`}
                        >
                          <div className={styles.eventHeader}>
                            <span className={styles.eventTime}>
                              ↓ Départ ·{' '}
                              {formatDateTimeInTimeZone(p.startAt, p.locationTimeZone).slice(-5)}
                            </span>
                            <span className={styles.eventSku}>{p.internalSku}</span>
                          </div>
                          <div className={styles.eventTitle}>{p.productName}</div>
                          <div className={styles.eventClient}>{p.customerName ?? 'Locataire'}</div>
                        </Link>
                      ))}

                      {/* Retours */}
                      {returns.map((r) => (
                        <Link
                          key={r.id}
                          href={`/dashboard/${orgId}/bookings/${r.bookingId}`}
                          className={`${styles.eventCard} ${styles.eventReturn}`}
                        >
                          <div className={styles.eventHeader}>
                            <span className={styles.eventTime}>
                              ↑ Retour ·{' '}
                              {formatDateTimeInTimeZone(r.endAt, r.locationTimeZone).slice(-5)}
                            </span>
                            <span className={styles.eventSku}>{r.internalSku}</span>
                          </div>
                          <div className={styles.eventTitle}>{r.productName}</div>
                          <div className={styles.eventClient}>{r.customerName ?? 'Locataire'}</div>
                        </Link>
                      ))}

                      {/* Maintenances */}
                      {maintenances.map((m) => (
                        <Link
                          key={m.id}
                          href={`/dashboard/${orgId}/fleet/maintenance/${m.maintenanceCaseId}`}
                          className={`${styles.eventCard} ${styles.eventMaintenance}`}
                        >
                          <div className={styles.eventHeader}>
                            <span className={styles.eventTime}>🔧 Maintenance</span>
                            <span className={styles.eventSku}>{m.internalSku}</span>
                          </div>
                          <div className={styles.eventTitle}>{m.productName}</div>
                          <div className={styles.eventClient}>« {m.reason} »</div>
                        </Link>
                      ))}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* VUE 2 : GRILLE DE FLOTTE (MINI-GANTT) */
        <div className={styles.fleetTableWrapper}>
          <table className={styles.fleetTable}>
            <thead>
              <tr>
                <th className={styles.bikeColHeader}>Équipement / Exemplaire</th>
                {days.map((day) => (
                  <th key={day.dateStr} className={styles.dayColHeader}>
                    {day.shortLabel}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {planning.fleetItems.map((bike) => (
                <tr key={bike.id}>
                  <td className={styles.bikeCell}>
                    <span className={styles.bikeSku}>{bike.internalSku}</span>
                    <span className={styles.bikeName}>
                      {bike.productName} ({bike.variantName})
                    </span>
                  </td>

                  {days.map((day) => {
                    const { status, label, link } = getItemDayStatus(bike.id, day.dateStr);

                    return (
                      <td key={day.dateStr} className={styles.cellDay}>
                        <Link
                          href={link}
                          className={`${styles.fleetCellBadge} ${
                            status === 'MAINTENANCE'
                              ? styles.cellMaint
                              : status === 'RENTED'
                                ? styles.cellRented
                                : styles.cellAvail
                          }`}
                        >
                          {label}
                        </Link>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
