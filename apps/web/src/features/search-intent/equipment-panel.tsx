'use client';

import { useState } from 'react';
import type { PublicSearchCategoryOption } from '@uttily/core';
import { Button, Icon } from '@uttily/ui';
import { getPublicCategoryLabel } from '@/lib/public-search-labels';
import {
  categoryBreadcrumb,
  equipmentFamilies,
  filterEquipmentFamilies,
  rankEquipmentSuggestions,
  type EquipmentTerrain,
} from './equipment-suggestions';
import { SuggestionPicker } from './suggestion-picker';
import type { SearchLocale } from './search-state';
import styles from './search-intent.module.css';

function FamilyIllustration({ slug }: { slug: string }): React.ReactElement {
  if (/bike|velo|vtt|vtc/.test(slug)) return <Icon name="bike" size={32} />;
  if (/ski|snowboard/.test(slug)) {
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
        <path d="m8 4-4 20M14 4l-4 20M18 4l-4 20M24 4l-4 20" />
        <path d="M7 4h8M3 24h8M17 4h8M13 24h8" />
      </svg>
    );
  }
  if (/paddle|kayak|canoe|surf/.test(slug))
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
  const [terrain, setTerrain] = useState<EquipmentTerrain>('all');
  const [showAll, setShowAll] = useState(false);
  const branch = categories.find((c) => c.id === branchId);
  const families = branch
    ? categories.filter((c) => c.parentId === branch.id)
    : equipmentFamilies(categories);
  const filteredFamilies = filterEquipmentFamilies(families, terrain);
  const visible =
    terrain === 'all' && !showAll && !branch ? filteredFamilies.slice(0, 8) : filteredFamilies;
  const matches = rankEquipmentSuggestions(categories, query, locale);
  const terrainFilters: Array<{ key: EquipmentTerrain; fr: string; en: string }> = [
    { key: 'all', fr: 'Tous', en: 'All' },
    { key: 'land', fr: 'Sur terre', en: 'On land' },
    { key: 'water', fr: 'Sur l’eau', en: 'On water' },
    { key: 'snow', fr: 'Sur la neige', en: 'On snow' },
  ];
  const placeholder =
    terrain === 'water'
      ? fr
        ? 'Kayak, paddle, surf…'
        : 'Kayak, paddleboard, surf…'
      : terrain === 'snow'
        ? fr
          ? 'Ski, snowboard, raquettes…'
          : 'Ski, snowboard, snowshoes…'
        : terrain === 'land'
          ? fr
            ? 'VTT, vélo de route, gravel…'
            : 'Mountain bike, road bike, gravel…'
          : fr
            ? 'Rechercher un équipement…'
            : 'Search for equipment…';

  function chooseTerrain(nextTerrain: EquipmentTerrain): void {
    setTerrain(nextTerrain);
    setBranchId(null);
    setShowAll(false);
    setQuery('');
  }

  function handleSeeAll(): void {
    if (terrain !== 'all') {
      setTerrain('all');
      setBranchId(null);
      setShowAll(true);
      setQuery('');
      return;
    }
    if (!showAll && filteredFamilies.length > visible.length) {
      setShowAll(true);
      return;
    }
    onChoose('');
  }
  return (
    <>
      <SuggestionPicker
        label={fr ? 'Rechercher un équipement' : 'Find equipment'}
        placeholder={placeholder}
        hideLabel
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
      <div
        className={styles.terrainFilters}
        role="group"
        aria-label={fr ? 'Famille d’équipement' : 'Equipment family'}
      >
        {terrainFilters.map((filter) => (
          <Button
            key={filter.key}
            type="button"
            variant="quiet"
            className={[
              styles.terrainFilter,
              terrain === filter.key ? styles.terrainFilterActive : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-pressed={terrain === filter.key}
            onClick={() => chooseTerrain(filter.key)}
          >
            {fr ? filter.fr : filter.en}
          </Button>
        ))}
      </div>
      {!query || matches.length === 0 ? (
        <>
          {branch ? (
            <div className={styles.familyHeading}>
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
              <Button
                type="button"
                variant="quiet"
                className={styles.chip}
                onClick={() => onChoose(branch.id)}
              >
                {fr ? 'Tout voir : ' : 'View all: '}
                {getPublicCategoryLabel(locale, branch)}
              </Button>
            </div>
          ) : null}
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
        </>
      ) : null}
      <div className={styles.panelFooter}>
        <Button type="button" variant="quiet" onClick={handleSeeAll}>
          {fr ? 'Voir tous les équipements →' : 'View all equipment →'}
        </Button>
      </div>
    </>
  );
}
