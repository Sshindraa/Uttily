'use client';

import React from 'react';
import styles from './floating-view-toggle.module.css';

export interface FloatingViewToggleProps {
  currentView: 'list' | 'map';
  onToggle: (view: 'list' | 'map') => void;
  locale: 'fr' | 'en';
}

export function FloatingViewToggle({
  currentView,
  onToggle,
  locale,
}: FloatingViewToggleProps): React.ReactElement {
  const fr = locale === 'fr';

  return (
    <div className={styles.toggleContainer}>
      <button
        type="button"
        className={styles.toggleButton}
        onClick={() => onToggle(currentView === 'list' ? 'map' : 'list')}
      >
        {currentView === 'list' ? (
          <>
            <span>{fr ? 'Afficher la carte' : 'Show map'}</span>
            <span aria-hidden="true" className={styles.icon}>
              🗺️
            </span>
          </>
        ) : (
          <>
            <span>{fr ? 'Afficher la liste' : 'Show list'}</span>
            <span aria-hidden="true" className={styles.icon}>
              📋
            </span>
          </>
        )}
      </button>
    </div>
  );
}
