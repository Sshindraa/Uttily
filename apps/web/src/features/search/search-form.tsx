'use client';

import { useState } from 'react';
import type { PublicSearchCategoryOption, PublicSearchDestinationOption } from '@uttily/core';
import type { PublicSearchFormValues, PublicUiLocale } from '@/lib/public-search';
import { getPublicCategoryLabel } from '@/lib/public-search-labels';
import { DestinationCombobox } from './destination-combobox';
import styles from './search.module.css';

interface SearchFormProps {
  locale: PublicUiLocale;
  destinations: PublicSearchDestinationOption[];
  categories: PublicSearchCategoryOption[];
  values: PublicSearchFormValues;
  fieldErrors?: Record<string, string>;
}

export function SearchForm({
  locale,
  destinations,
  categories,
  values,
  fieldErrors = {},
}: SearchFormProps): React.ReactElement {
  const [intent, setIntent] = useState(values.intent);
  const fr = locale === 'fr';

  return (
    <form action={`/${locale}/search`} method="get" className={styles.form}>
      {values.peopleCount ? (
        <input type="hidden" name="peopleCount" value={values.peopleCount} />
      ) : null}
      <div className={styles.fieldWide}>
        <label htmlFor="destinationQuery">{fr ? 'Destination' : 'Destination'}</label>
        <DestinationCombobox
          destinations={destinations}
          defaultPublicId={values.destinationPublicId}
          locale={locale}
          error={fieldErrors.destinationPublicId}
        />
        {fieldErrors.destinationPublicId ? (
          <span id="destination-error" className={styles.fieldError}>
            {fieldErrors.destinationPublicId}
          </span>
        ) : null}
      </div>

      <div>
        <label htmlFor="intent">{fr ? 'Type de durée' : 'Rental period'}</label>
        <select
          id="intent"
          name="intent"
          value={intent}
          onChange={(event) =>
            setIntent(event.target.value === 'TIME_RANGE' ? 'TIME_RANGE' : 'DAY_RANGE')
          }
        >
          <option value="DAY_RANGE">{fr ? 'Plusieurs jours' : 'Multiple days'}</option>
          <option value="TIME_RANGE">{fr ? 'Date et heures' : 'Date and times'}</option>
        </select>
      </div>

      {intent === 'DAY_RANGE' ? (
        <>
          <div>
            <label htmlFor="startDate">{fr ? 'Premier jour' : 'First day'}</label>
            <input
              id="startDate"
              name="startDate"
              type="date"
              defaultValue={values.startDate}
              aria-describedby={fieldErrors.startDate ? 'start-date-error' : undefined}
              required
            />
            {fieldErrors.startDate ? (
              <span id="start-date-error" className={styles.fieldError}>
                {fieldErrors.startDate}
              </span>
            ) : null}
          </div>
          <div>
            <label htmlFor="endDateExclusive">{fr ? 'Restitution' : 'Return date'}</label>
            <input
              id="endDateExclusive"
              name="endDateExclusive"
              type="date"
              defaultValue={values.endDateExclusive}
              min={values.startDate || undefined}
              aria-describedby={fieldErrors.endDateExclusive ? 'end-date-error' : undefined}
              required
            />
            {fieldErrors.endDateExclusive ? (
              <span id="end-date-error" className={styles.fieldError}>
                {fieldErrors.endDateExclusive}
              </span>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <div>
            <label htmlFor="startAt">{fr ? 'Début' : 'Start'}</label>
            <input
              id="startAt"
              name="startAt"
              type="datetime-local"
              defaultValue={values.startAt}
              aria-describedby={fieldErrors.startAt ? 'start-time-error' : undefined}
              required
            />
            {fieldErrors.startAt ? (
              <span id="start-time-error" className={styles.fieldError}>
                {fieldErrors.startAt}
              </span>
            ) : null}
          </div>
          <div>
            <label htmlFor="endAt">{fr ? 'Fin' : 'End'}</label>
            <input
              id="endAt"
              name="endAt"
              type="datetime-local"
              defaultValue={values.endAt}
              min={values.startAt || undefined}
              aria-describedby={fieldErrors.endAt ? 'end-time-error' : undefined}
              required
            />
            {fieldErrors.endAt ? (
              <span id="end-time-error" className={styles.fieldError}>
                {fieldErrors.endAt}
              </span>
            ) : null}
          </div>
        </>
      )}

      <div>
        <label htmlFor="categoryId">{fr ? 'Catégorie' : 'Category'}</label>
        <select id="categoryId" name="categoryId" defaultValue={values.categoryId}>
          <option value="">{fr ? 'Toutes les catégories' : 'All categories'}</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {getPublicCategoryLabel(locale, category)}
            </option>
          ))}
        </select>
      </div>

      <button type="submit" disabled={destinations.length === 0}>
        {fr ? 'Voir les équipements' : 'Find equipment'}
      </button>
    </form>
  );
}
