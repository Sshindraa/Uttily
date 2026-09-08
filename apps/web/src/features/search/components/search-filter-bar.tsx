'use client';

import React from 'react';
import Link from 'next/link';
import type { PublicSearchCategoryOption } from '@uttily/core';
import type { PublicUiLocale } from '@/lib/public-search';
import { getCategoryPresentation } from '@/features/equipment/category-presentation';
import styles from './search-filter-bar.module.css';

export interface SearchFilterBarProps {
  categories: PublicSearchCategoryOption[];
  selectedCategoryId: string;
  locale: PublicUiLocale;
  currentSearchParams: string;
}

export function SearchFilterBar({
  categories,
  selectedCategoryId,
  locale,
  currentSearchParams,
}: SearchFilterBarProps): React.ReactElement {
  const fr = locale === 'fr';

  const buildCategoryUrl = (categoryId: string | null): string => {
    const params = new URLSearchParams(currentSearchParams);
    params.delete('cursor');
    if (categoryId) {
      params.set('categoryId', categoryId);
    } else {
      params.delete('categoryId');
    }
    const query = params.toString();
    return `/${locale}/search${query ? `?${query}` : ''}`;
  };

  return (
    <nav
      className={styles.filterBarContainer}
      aria-label={fr ? 'Filtrer par catégorie' : 'Filter by category'}
    >
      <div className={styles.scrollWrapper}>
        <Link
          href={buildCategoryUrl(null)}
          scroll={false}
          className={`${styles.chip} ${!selectedCategoryId ? styles.chipActive : ''}`}
          aria-current={!selectedCategoryId ? 'true' : undefined}
        >
          <span className={styles.chipIcon} aria-hidden="true">
            ✨
          </span>
          <span className={styles.chipLabel}>
            {fr ? 'Tous les équipements' : 'All equipment'}
          </span>
        </Link>

        {categories.map((category) => {
          const isSelected = selectedCategoryId === category.id;
          const presentation = getCategoryPresentation(category.slug);
          const icon = presentation.icon || '🚲';

          return (
            <Link
              key={category.id}
              href={buildCategoryUrl(category.id)}
              scroll={false}
              className={`${styles.chip} ${isSelected ? styles.chipActive : ''}`}
              aria-current={isSelected ? 'true' : undefined}
            >
              <span className={styles.chipIcon} aria-hidden="true">
                {icon}
              </span>
              <span className={styles.chipLabel}>{category.name}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
