'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@uttily/ui';
import {
  civilDate,
  dateSelectionError,
  dateSummary,
  shiftDate,
  type SearchLocale,
  type SearchSelection,
} from './search-state';
import styles from './search-intent.module.css';

function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function nextMonth(month: string, offset: number): string {
  const date = civilDate(month)!;
  date.setUTCMonth(date.getUTCMonth() + offset, 1);
  const next = date.toISOString().slice(0, 10);
  return civilDate(next) ? next : month;
}

export function DatesPanel({
  selection,
  locale,
  onChange,
  onDone,
}: {
  selection: SearchSelection;
  locale: SearchLocale;
  onChange: (patch: Partial<SearchSelection>) => void;
  onDone: () => void;
}): React.ReactElement {
  const fr = locale === 'fr';
  const firstDate = civilDate(selection.startDate) ? selection.startDate : today();
  const [month, setMonth] = useState(`${firstDate.slice(0, 7)}-01`);
  const [focusDate, setFocusDate] = useState(firstDate);
  const [error, setError] = useState<string | null>(null);
  const keyboardFocus = useRef(false);
  const calendars = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (keyboardFocus.current)
      calendars.current?.querySelector<HTMLButtonElement>(`[data-date="${focusDate}"]`)?.focus();
    keyboardFocus.current = false;
  }, [focusDate, month]);
  const weekdays = fr ? ['L', 'M', 'M', 'J', 'V', 'S', 'D'] : ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const fullDate = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  function selectDay(day: string): void {
    setError(null);
    setFocusDate(day);
    if (!selection.startDate || selection.endDate || day < selection.startDate)
      onChange({ startDate: day, endDate: '' });
    else onChange({ endDate: day });
  }
  function moveFocus(day: string, key: string): boolean {
    const date = civilDate(day)!;
    const weekday = (date.getUTCDay() + 6) % 7;
    let target = '';
    if (key === 'ArrowLeft') target = shiftDate(day, -1);
    if (key === 'ArrowRight') target = shiftDate(day, 1);
    if (key === 'ArrowUp') target = shiftDate(day, -7);
    if (key === 'ArrowDown') target = shiftDate(day, 7);
    if (key === 'Home') target = shiftDate(day, -weekday);
    if (key === 'End') target = shiftDate(day, 6 - weekday);
    if (key === 'PageUp' || key === 'PageDown')
      target = nextMonth(`${day.slice(0, 7)}-01`, key === 'PageUp' ? -1 : 1);
    if (!target || !civilDate(target)) return false;
    keyboardFocus.current = true;
    setFocusDate(target);
    // Keeping the focused month first also works when the second calendar is hidden on mobile.
    if (target.slice(0, 7) !== day.slice(0, 7)) setMonth(`${target.slice(0, 7)}-01`);
    return true;
  }

  return (
    <>
      <p className={styles.hint}>
        {fr
          ? 'Choisissez le premier et le dernier jour. Pour une seule journée, sélectionnez un jour puis validez.'
          : 'Choose the first and last day. For one day, select a day and confirm.'}
      </p>
      <div className={styles.dateInputs}>
        <label>
          {fr ? 'Début' : 'Start'}
          <Input
            type="date"
            value={selection.startDate}
            onInput={(event) => {
              const value = event.currentTarget.value;
              onChange({ startDate: value });
              setError(null);
              if (civilDate(value)) {
                setMonth(`${value.slice(0, 7)}-01`);
                setFocusDate(value);
              }
            }}
          />
        </label>
        <label>
          {fr ? 'Dernier jour' : 'Last day'}
          <Input
            type="date"
            value={selection.endDate || selection.startDate}
            min={selection.startDate || undefined}
            onInput={(event) => {
              onChange({ endDate: event.currentTarget.value });
              setError(null);
            }}
          />
        </label>
      </div>
      <div className={styles.calendarNavigation}>
        <Button
          type="button"
          variant="quiet"
          aria-label={fr ? 'Mois précédent' : 'Previous month'}
          disabled={nextMonth(month, -1) === month}
          className={styles.roundControl}
          onClick={() => {
            const next = nextMonth(month, -1);
            setMonth(next);
            setFocusDate(next);
          }}
        >
          ‹
        </Button>
        <span>{fr ? 'Vos dates, tout simplement' : 'Pick your dates'}</span>
        <Button
          type="button"
          variant="quiet"
          aria-label={fr ? 'Mois suivant' : 'Next month'}
          disabled={nextMonth(month, 1) === month}
          className={styles.roundControl}
          onClick={() => {
            const next = nextMonth(month, 1);
            setMonth(next);
            setFocusDate(next);
          }}
        >
          ›
        </Button>
      </div>
      <div ref={calendars} className={styles.calendars}>
        {[...new Set([month, nextMonth(month, 1)])].map((value, monthIndex) => {
          const date = civilDate(value)!;
          const offset = (date.getUTCDay() + 6) % 7;
          const lastDay = new Date(date);
          lastDay.setUTCMonth(date.getUTCMonth() + 1, 0);
          const count = lastDay.getUTCDate();
          return (
            <div
              key={value}
              className={monthIndex === 1 ? styles.secondCalendar : undefined}
              role="group"
              aria-label={new Intl.DateTimeFormat(locale, {
                month: 'long',
                year: 'numeric',
                timeZone: 'UTC',
              }).format(date)}
            >
              <h3 className={styles.monthTitle}>
                {new Intl.DateTimeFormat(locale, {
                  month: 'long',
                  year: 'numeric',
                  timeZone: 'UTC',
                }).format(date)}
              </h3>
              <div className={styles.calendarGrid}>
                {weekdays.map((day, i) => (
                  <span key={`week-${i}`} aria-hidden="true" className={styles.weekday}>
                    {day}
                  </span>
                ))}
                {Array.from({ length: offset }, (_, i) => (
                  <span key={`empty-${i}`} />
                ))}
                {Array.from({ length: count }, (_, i) => {
                  const day = shiftDate(value, i);
                  const selected = day === selection.startDate || day === selection.endDate;
                  const inRange =
                    !!selection.endDate && day > selection.startDate && day < selection.endDate;
                  return (
                    <Button
                      key={day}
                      type="button"
                      variant="quiet"
                      data-date={day}
                      tabIndex={day === focusDate ? 0 : -1}
                      className={[
                        styles.day,
                        selected ? styles.selectedDay : '',
                        inRange ? styles.rangeDay : '',
                      ].join(' ')}
                      aria-label={fullDate.format(civilDate(day)!)}
                      aria-pressed={selected || inRange}
                      aria-current={day === today() ? 'date' : undefined}
                      onClick={() => selectDay(day)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          selectDay(day);
                        } else if (moveFocus(day, event.key)) event.preventDefault();
                      }}
                    >
                      {i + 1}
                    </Button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <label className={styles.timeToggle}>
        <input
          type="checkbox"
          checked={selection.withTimes}
          onChange={(event) => {
            onChange({ withTimes: event.currentTarget.checked });
            setError(null);
          }}
        />
        {fr ? 'Préciser les horaires' : 'Add specific times'}
      </label>
      {selection.withTimes ? (
        <div className={styles.dateInputs}>
          <label>
            {fr ? 'Heure de début' : 'Start time'}
            <Input
              type="time"
              value={selection.startTime}
              onInput={(event) => {
                onChange({ startTime: event.currentTarget.value });
                setError(null);
              }}
            />
          </label>
          <label>
            {fr ? 'Heure de fin' : 'End time'}
            <Input
              type="time"
              value={selection.endTime}
              onInput={(event) => {
                onChange({ endTime: event.currentTarget.value });
                setError(null);
              }}
            />
          </label>
        </div>
      ) : null}
      <p className={styles.hint}>
        {fr
          ? selection.withTimes
            ? 'Horaires locaux du lieu de retrait. Le tarif et la disponibilité seront vérifiés pour cette période.'
            : 'Premier et dernier jours inclus. Le tarif et les conditions de retrait seront précisés dans les offres.'
          : selection.withTimes
            ? 'Local pickup times. Pricing and availability will be checked for this period.'
            : 'First and last days included. Offers will specify pricing and pickup conditions.'}
      </p>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      <div className={styles.panelFooter}>
        <Button
          type="button"
          variant="quiet"
          onClick={() => {
            onChange({ startDate: '', endDate: '', startTime: '', endTime: '' });
            setError(null);
          }}
        >
          {fr ? 'Effacer' : 'Clear'}
        </Button>
        <Button
          type="button"
          className={styles.confirm}
          onClick={() => {
            const error = dateSelectionError(selection, locale);
            if (error) setError(error);
            else onDone();
          }}
        >
          {fr ? 'Valider les dates' : 'Confirm dates'}
        </Button>
      </div>
      <span className={styles.srOnly} aria-live="polite">
        {dateSummary(selection, locale)}
      </span>
    </>
  );
}
