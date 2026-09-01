'use client';

import { useId, useState } from 'react';
import { Button, Icon, Input } from '@uttily/ui';
import styles from './search-intent.module.css';

export interface Suggestion {
  id: string;
  label: string;
  detail?: string;
}

export function SuggestionPicker({
  label,
  placeholder,
  query,
  onQuery,
  options,
  onChoose,
  emptyMessage,
  kind = 'search',
}: {
  label: string;
  placeholder: string;
  query: string;
  onQuery: (query: string) => void;
  options: Suggestion[];
  onChoose: (id: string) => void;
  emptyMessage: string;
  kind?: 'search' | 'pin';
}): React.ReactElement {
  const id = useId();
  const [active, setActive] = useState(0);
  const index = Math.min(active, Math.max(0, options.length - 1));
  return (
    <div>
      <label htmlFor={id} className={styles.inputLabel}>
        {label}
      </label>
      <div className={styles.inputWithIcon}>
        <Icon name="search" size={20} />
        <Input
          id={id}
          type="search"
          role="combobox"
          autoComplete="off"
          placeholder={placeholder}
          value={query}
          aria-autocomplete="list"
          aria-controls={`${id}-list`}
          aria-expanded={options.length > 0}
          aria-activedescendant={options[index] ? `${id}-option-${index}` : undefined}
          onChange={(event) => {
            onQuery(event.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setActive(
                Math.max(
                  0,
                  Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
                ),
              );
            } else if (event.key === 'Enter') {
              event.preventDefault();
              if (options[index]) onChoose(options[index].id);
            }
          }}
        />
      </div>
      <ul id={`${id}-list`} role="listbox" aria-label={label} className={styles.suggestions}>
        {options.map((option, i) => (
          <li key={option.id} role="presentation">
            <Button
              type="button"
              variant="quiet"
              role="option"
              aria-selected={i === index}
              id={`${id}-option-${i}`}
              tabIndex={-1}
              className={styles.suggestion}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChoose(option.id)}
            >
              <span className={styles.suggestionIcon}>
                <Icon name={kind} size={20} />
              </span>
              <span>
                <strong>{option.label}</strong>
                {option.detail ? <small>{option.detail}</small> : null}
              </span>
              <Icon name="arrow-right" size={16} />
            </Button>
          </li>
        ))}
      </ul>
      {options.length === 0 && query ? (
        <p role="status" className={styles.hint}>
          {emptyMessage}
        </p>
      ) : null}
    </div>
  );
}
