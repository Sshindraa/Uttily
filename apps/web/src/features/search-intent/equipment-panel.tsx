'use client';

import { useState } from 'react';
import type { PublicSearchCategoryOption } from '@uttily/core';
import { Button, Icon } from '@uttily/ui';
import { getPublicCategoryLabel } from '@/lib/public-search-labels';
import {
  categoryBreadcrumb,
  equipmentFamilies,
  rankEquipmentSuggestions,
} from './equipment-suggestions';
import { SuggestionPicker } from './suggestion-picker';
import type { SearchLocale } from './search-state';
import styles from './search-intent.module.css';

function FamilyIllustration({ slug }: { slug: string }): React.ReactElement {
  if (/bike|velo|vtt|vtc/.test(slug)) return <Icon name="bike" size={32} />;
  if (/paddle|kayak|surf/.test(slug))
    return (
      <svg
        aria-hidden="true"
        width="32"
        height="32"
        viewBox="0 0 32 32"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 25q4-4 8 0t8 0t8 0M12 21 23 4M20 7l4 3 4-6-4-2z" />
        <ellipse cx="13" cy="16" rx="4" ry="10" transform="rotate(30 13 16)" />
      </svg>
    );
  if (/camp/.test(slug))
    return (
      <svg
        aria-hidden="true"
        width="32"
        height="32"
        viewBox="0 0 32 32"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m3 26 13-21 13 21H3Zm8 0 5-10 5 10M13 3l3 3 3-3" />
      </svg>
    );
  return <Icon name="search" size={28} />;
}

export function EquipmentPanel({
  categories,
  locale,
  onChoose,
}: {
  categories: PublicSearchCategoryOption[];
  locale: SearchLocale;
  onChoose: (id: string) => void;
}): React.ReactElement {
  const fr = locale === 'fr';
  const [query, setQuery] = useState('');
  const [branchId, setBranchId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const branch = categories.find((c) => c.id === branchId);
  const families = branch
    ? categories.filter((c) => c.parentId === branch.id)
    : equipmentFamilies(categories);
  const visible = showAll ? families : families.slice(0, 8);
  const matches = rankEquipmentSuggestions(categories, query, locale);
  return (
    <>
      <SuggestionPicker
        label={fr ? 'Rechercher un équipement' : 'Find equipment'}
        placeholder={fr ? 'Kayak, VTT, paddle…' : 'Kayak, mountain bike, paddleboard…'}
        query={query}
        onQuery={setQuery}
        options={matches.map((c) => ({
          id: c.id,
          label: getPublicCategoryLabel(locale, c),
          detail: categoryBreadcrumb(c, categories, locale),
        }))}
        onChoose={onChoose}
        emptyMessage={
          fr
            ? 'Aucune catégorie ne correspond à cette demande précise. Vous pouvez explorer les familles ci-dessous.'
            : 'No category matches this specific request. You can explore the families below.'
        }
      />
      {!query || matches.length === 0 ? (
        <>
          <div className={styles.familyHeading}>
            {branch ? (
              <Button
                type="button"
                variant="quiet"
                className={styles.back}
                onClick={() => {
                  setBranchId(null);
                  setShowAll(false);
                }}
              >
                ← {fr ? 'Toutes les familles' : 'All families'}
              </Button>
            ) : (
              <p className={styles.sectionLabel}>
                {fr ? 'Explorer les équipements' : 'Explore equipment'}
              </p>
            )}
            {branch ? (
              <Button
                type="button"
                variant="quiet"
                className={styles.chip}
                onClick={() => onChoose(branch.id)}
              >
                {fr ? 'Tout voir : ' : 'View all: '}
                {getPublicCategoryLabel(locale, branch)}
              </Button>
            ) : null}
          </div>
          <div className={styles.families}>
            {visible.map((category) => (
              <Button
                key={category.id}
                type="button"
                variant="quiet"
                className={styles.family}
                onClick={() => {
                  if (categories.some((c) => c.parentId === category.id)) {
                    setBranchId(category.id);
                    setShowAll(false);
                    setQuery('');
                  } else onChoose(category.id);
                }}
              >
                <span className={styles.familyIllustration}>
                  <FamilyIllustration slug={category.slug} />
                </span>
                <span>{getPublicCategoryLabel(locale, category)}</span>
              </Button>
            ))}
          </div>
          {!showAll && families.length > 8 ? (
            <Button
              type="button"
              variant="quiet"
              className={styles.back}
              onClick={() => setShowAll(true)}
            >
              {fr ? 'Voir les autres familles' : 'Show other families'}
            </Button>
          ) : null}
        </>
      ) : null}
      <div className={styles.panelFooter}>
        <Button type="button" variant="quiet" onClick={() => onChoose('')}>
          {fr ? 'Tous les équipements' : 'All equipment'}
        </Button>
      </div>
    </>
  );
}
