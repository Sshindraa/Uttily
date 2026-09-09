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

type DateMode = 'short' | 'range';
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
  const todayValue = today();
  const firstDate =
    civilDate(selection.startDate) && selection.startDate >= todayValue
      ? selection.startDate
      : todayValue;
  const minimumMonth = `${todayValue.slice(0, 7)}-01`;
  const [month, setMonth] = useState(`${firstDate.slice(0, 7)}-01`);
  const [focusDate, setFocusDate] = useState(firstDate);
  const [dateMode, setDateMode] = useState<DateMode>(
    selection.withTimes || !selection.startDate ? 'short' : 'range',
  );
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
    if (dateMode === 'short') onChange({ startDate: day, endDate: day, withTimes: true });
    else if (!selection.startDate || selection.endDate || day < selection.startDate)
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
    if (target < todayValue) target = todayValue;
    keyboardFocus.current = true;
    setFocusDate(target);
    // Keeping the focused month first also works when the second calendar is hidden on mobile.
    if (target.slice(0, 7) !== day.slice(0, 7)) setMonth(`${target.slice(0, 7)}-01`);
    return true;
  }

  return (
    <>
      <div className={styles.datesBody}>
        <div
          className={styles.dateModeSwitch}
          role="group"
          aria-label={fr ? 'Durée de location' : 'Rental duration'}
        >
          <Button
            type="button"
            variant="quiet"
            aria-pressed={dateMode === 'short'}
            className={`${styles.dateModeButton} ${dateMode === 'short' ? styles.dateModeButtonActive : ''}`}
            onClick={() => {
              setDateMode('short');
              setError(null);
              onChange({
                withTimes: true,
                endDate: selection.startDate,
                startTime: '',
                endTime: '',
              });
            }}
          >
            {fr ? 'Moins d’un jour' : 'Less than a day'}
          </Button>
          <Button
            type="button"
            variant="quiet"
            aria-pressed={dateMode === 'range'}
            className={`${styles.dateModeButton} ${dateMode === 'range' ? styles.dateModeButtonActive : ''}`}
            onClick={() => {
              setDateMode('range');
              setError(null);
              onChange({ withTimes: false, startTime: '', endTime: '' });
            }}
          >
            {fr ? 'Un jour ou plus' : 'A day or more'}
          </Button>
        </div>

        <p className={styles.dateInstruction}>
          {dateMode === 'short'
            ? fr
              ? 'Choisissez une date, puis vos horaires.'
              : 'Choose a date, then your times.'
            : fr
              ? 'Choisissez le premier et le dernier jour de location.'
              : 'Choose the first and last rental day.'}
        </p>
        <div className={dateMode === 'short' ? styles.singleCalendar : styles.calendarArea}>
          <div className={styles.calendarNavigation}>
            <Button
              type="button"
              variant="quiet"
              aria-label={fr ? 'Mois précédent' : 'Previous month'}
              disabled={month <= minimumMonth}
              className={styles.roundControl}
              onClick={() => {
                const next = nextMonth(month, -1);
                if (next >= minimumMonth) {
                  setMonth(next);
                  setFocusDate(next < todayValue ? todayValue : next);
                }
              }}
            >
              ‹
            </Button>
            <span className={styles.srOnly}>
              {fr ? 'Choisissez votre créneau' : 'Choose your rental slot'}
            </span>
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
            {[...new Set(dateMode === 'short' ? [month] : [month, nextMonth(month, 1)])].map(
              (value, monthIndex) => {
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
                          !!selection.endDate &&
                          day > selection.startDate &&
                          day < selection.endDate;
                        const isPast = day < todayValue;
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
                            disabled={isPast}
                            aria-label={fullDate.format(civilDate(day)!)}
                            aria-pressed={selected || inRange}
                            aria-current={day === todayValue ? 'date' : undefined}
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
              },
            )}
          </div>
        </div>
        <div className={styles.dateOptions}>
          {dateMode === 'short' ? (
            <>
              <div className={styles.dateInputs}>
                <label>
                  {fr ? 'Heure de début' : 'Start time'}
                  <Input
                    type="time"
                    value={selection.startTime}
                    onInput={(event) => {
                      onChange({ startTime: event.currentTarget.value, withTimes: true });
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
                      onChange({ endTime: event.currentTarget.value, withTimes: true });
                      setError(null);
                    }}
                  />
                </label>
              </div>
            </>
          ) : null}
          <label className={styles.flexibilitySelect}>
            <span>{fr ? 'Flexibilité' : 'Flexibility'}</span>
            <select defaultValue="0" aria-label={fr ? 'Dates flexibles' : 'Flexible dates'}>
              <option value="0">{fr ? 'Dates exactes' : 'Exact dates'}</option>
              {[1, 2, 3, 7, 14].map((days) => (
                <option key={days} value={days} disabled>
                  ± {days} {fr ? (days === 1 ? 'jour' : 'jours') : days === 1 ? 'day' : 'days'} —{' '}
                  {fr ? 'bientôt' : 'coming soon'}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </div>
      <div className={`${styles.panelFooter} ${styles.datesFooter}`}>
        <div className={styles.dateRecap}>
          <span aria-live="polite">{dateSummary(selection, locale)}</span>
          <Button
            type="button"
            variant="quiet"
            onClick={() => {
              onChange({
                startDate: '',
                endDate: '',
                startTime: '',
                endTime: '',
                withTimes: dateMode === 'short',
              });
              setError(null);
            }}
          >
            {fr ? 'Effacer' : 'Clear'}
          </Button>
        </div>
        <Button
          type="button"
          className={styles.confirm}
          onClick={() => {
            const error = dateSelectionError(
              { ...selection, withTimes: dateMode === 'short' },
              locale,
            );
            if (error) setError(error);
            else onDone();
          }}
        >
          {fr ? 'Appliquer' : 'Apply'}
        </Button>
      </div>
      <span className={styles.srOnly} aria-live="polite">
        {dateSummary(selection, locale)}
      </span>
    </>
  );
}
