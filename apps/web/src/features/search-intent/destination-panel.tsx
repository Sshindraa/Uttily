'use client';

import { useEffect, useState } from 'react';
import type { PublicSearchDestinationOption } from '@uttily/core';
import { Button, Icon } from '@uttily/ui';
import { rankDestinationSuggestions } from '@/lib/destination-suggestions';
import { SuggestionPicker } from './suggestion-picker';
import type { SearchLocale } from './search-state';
import styles from './search-intent.module.css';

const RECENT_KEY = 'uttily:recent-destinations:v1';

export function DestinationPanel({
  destinations,
  locale,
  onChoose,
}: {
  destinations: PublicSearchDestinationOption[];
  locale: SearchLocale;
  onChoose: (id: string) => void;
}): React.ReactElement {
  const fr = locale === 'fr';
  const [query, setQuery] = useState('');
  const [recentIds, setRecentIds] = useState<string[]>([]);
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(RECENT_KEY);
      const parsed: unknown = stored && stored.length < 512 ? JSON.parse(stored) : [];
      if (Array.isArray(parsed))
        setRecentIds(
          [
            ...new Set(
              parsed.filter(
                (id): id is string =>
                  typeof id === 'string' && destinations.some((d) => d.publicId === id),
              ),
            ),
          ].slice(0, 4),
        );
    } catch {
      /* Storage is optional; public suggestions remain available. */
    }
  }, [destinations]);
  function choose(id: string): void {
    const next = [id, ...recentIds.filter((recent) => recent !== id)].slice(0, 4);
    try {
      sessionStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* Private browsing/storage disabled. */
    }
    onChoose(id);
  }
  const suggestions = rankDestinationSuggestions(destinations, query);
  return (
    <>
      <SuggestionPicker
        label={fr ? 'Rechercher une destination' : 'Find a destination'}
        placeholder={fr ? 'Une ville, une destination…' : 'A city, a destination…'}
        query={query}
        onQuery={setQuery}
        options={suggestions.map((d) => ({
          id: d.publicId,
          label: d.label,
          detail: `${d.placeType === 'CITY' ? (fr ? 'Ville' : 'City') : fr ? 'Destination' : 'Destination'} · ${d.countryCode}`,
        }))}
        onChoose={choose}
        kind="pin"
        emptyMessage={
          fr
            ? 'Cette destination n’est pas encore proposée. Choisissez une destination disponible.'
            : 'This destination is not available yet. Choose an available destination.'
        }
      />
      {!query && recentIds.length > 0 ? (
        <div className={styles.recents}>
          <p className={styles.sectionLabel}>
            {fr ? 'Vos destinations récentes' : 'Your recent destinations'}
          </p>
          <div className={styles.chips}>
            {recentIds.map((id) => {
              const destination = destinations.find((d) => d.publicId === id);
              return destination ? (
                <Button
                  type="button"
                  variant="quiet"
                  key={id}
                  className={styles.chip}
                  onClick={() => choose(id)}
                >
                  <Icon name="pin" size={16} />
                  {destination.label}
                </Button>
              ) : null;
            })}
          </div>
        </div>
      ) : null}
      {!query ? (
        <p className={styles.hint}>
          {fr
            ? 'Les destinations proposées sont ouvertes à la recherche. Les disponibilités dépendent de vos dates.'
            : 'These destinations are open for search. Availability depends on your dates.'}
        </p>
      ) : null}
    </>
  );
}
