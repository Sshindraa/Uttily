'use client';

import { useId, useMemo, useRef, useState } from 'react';
import type { PublicSearchDestinationOption } from '@uttily/core';
import { destinationDisplayLabel, rankDestinationSuggestions } from '@/lib/destination-suggestions';
import styles from './search.module.css';

interface DestinationComboboxProps {
  destinations: PublicSearchDestinationOption[];
  defaultPublicId: string;
  locale: 'fr' | 'en';
  error?: string | undefined;
}

export function DestinationCombobox({
  destinations,
  defaultPublicId,
  locale,
  error,
}: DestinationComboboxProps): React.ReactElement {
  const selectedByDefault = destinations.find(
    (destination) => destination.publicId === defaultPublicId,
  );
  const [query, setQuery] = useState(
    selectedByDefault ? destinationDisplayLabel(selectedByDefault) : '',
  );
  const [selectedPublicId, setSelectedPublicId] = useState(selectedByDefault?.publicId ?? '');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestions = useMemo(
    () => rankDestinationSuggestions(destinations, query),
    [destinations, query],
  );
  const fr = locale === 'fr';

  function choose(destination: PublicSearchDestinationOption): void {
    setQuery(destinationDisplayLabel(destination));
    setSelectedPublicId(destination.publicId);
    inputRef.current?.setCustomValidity('');
    setOpen(false);
    setActiveIndex(0);
  }

  return (
    <div className={styles.combobox}>
      <input type="hidden" name="destinationPublicId" value={selectedPublicId} />
      <input
        ref={inputRef}
        id="destinationQuery"
        type="search"
        role="combobox"
        value={query}
        placeholder={fr ? 'Ex. Lyon' : 'E.g. Lyon'}
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={open && suggestions.length > 0}
        aria-controls={listboxId}
        aria-activedescendant={
          open && suggestions[activeIndex]
            ? `${listboxId}-${suggestions[activeIndex].publicId}`
            : undefined
        }
        aria-describedby={error ? 'destination-error' : 'destination-help'}
        required
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setSelectedPublicId('');
          setActiveIndex(0);
          setOpen(true);
          event.currentTarget.setCustomValidity(
            fr ? 'Choisissez une destination proposée.' : 'Choose a suggested destination.',
          );
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            if (suggestions.length > 0) {
              setActiveIndex((index) => Math.min(index + 1, suggestions.length - 1));
            }
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          } else if (event.key === 'Enter' && open && suggestions[activeIndex]) {
            event.preventDefault();
            choose(suggestions[activeIndex]);
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      <span id="destination-help" className={styles.srOnly}>
        {fr
          ? 'Saisissez une ville puis choisissez une suggestion.'
          : 'Enter a city, then choose a suggestion.'}
      </span>
      {open && suggestions.length > 0 ? (
        <ul id={listboxId} role="listbox" className={styles.suggestionList}>
          {suggestions.map((destination, index) => (
            <li
              key={destination.publicId}
              id={`${listboxId}-${destination.publicId}`}
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? styles.suggestionActive : undefined}
            >
              <button
                type="button"
                className={styles.suggestionButton}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(destination)}
              >
                <span>{destination.label}</span>
                <small>
                  {destination.placeType === 'CITY'
                    ? fr
                      ? 'Ville'
                      : 'City'
                    : fr
                      ? 'Lieu'
                      : 'Place'}{' '}
                  · {destination.countryCode}
                </small>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
