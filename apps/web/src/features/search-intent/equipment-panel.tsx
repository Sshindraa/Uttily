'use client';

import Image from 'next/image';
import { useState } from 'react';
import type { PublicSearchCategoryOption } from '@uttily/core';
import {
  BIKE_SUBTYPE_DEFINITIONS,
  getBikeSubtypeLabel,
  isBikeSubtype,
  type BikeSubtype,
} from '@uttily/contracts';
import { Button, Icon } from '@uttily/ui';
import { getPublicCategoryLabel } from '@/lib/public-search-labels';
import {
  categoryBreadcrumb,
  equipmentFamilies,
  filterEquipmentFamilies,
  BIKE_SUBTYPE_SUGGESTION_PREFIX,
  rankBikeSubtypeSuggestions,
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
  if (/snowshoe|raquette/.test(slug))
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
        <ellipse cx="10" cy="16" rx="5" ry="11" transform="rotate(25 10 16)" />
        <ellipse cx="22" cy="16" rx="5" ry="11" transform="rotate(25 22 16)" />
        <path d="M6 10h8M5 16h9M7 22h7M18 10h8M17 16h9M19 22h7" />
      </svg>
    );
  if (/sled|luge/.test(slug))
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
        <path d="M5 18h22l-3 6H8l-3-6Z" />
        <path d="M9 18v-7h14v7M5 26h22M9 26c0 2 2 3 5 3M23 26c0 2-2 3-5 3" />
      </svg>
    );
  if (/pedalboat|pedalo/.test(slug))
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
        <path d="M4 19h24l-3 5H7l-3-5Z" />
        <path d="M8 19v-8h16v8M12 11V8h8v3M10 24v3M22 24v3" />
      </svg>
    );
  if (/bodyboard/.test(slug))
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
        <path d="M16 3C10.5 3 6 8.4 6 15c0 6.6 4.5 14 10 14s10-7.4 10-14C26 8.4 21.5 3 16 3Z" />
        <path d="M11.5 9.5c1.3 1.1 2.8 1.6 4.5 1.6s3.2-.5 4.5-1.6M9.5 15.5c1.7 1.1 3.9 1.7 6.5 1.7s4.8-.6 6.5-1.7M10.5 21.5c1.5.8 3.4 1.2 5.5 1.2s4-.4 5.5-1.2" />
      </svg>
    );
  if (/wingfoil/.test(slug))
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
        <path d="M5 25c6-2 13 2 22-1" />
        <path d="M16 24l1-11" />
        <path d="M17 13c-2-5 .5-9 5-10 3 0 6 1 8 3-4 1-8 3-13 7Z" />
        <path d="M19 14c3 0 5 1 7 3" />
      </svg>
    );
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

function FamilyVisual({ category }: { category: PublicSearchCategoryOption }): React.ReactElement {
  const customIllustration =
    category.slug === 'ski'
      ? '/images/search-filters/ski.svg'
      : category.slug === 'snowboard'
        ? '/images/search-filters/snowboard.svg'
        : category.slug === 'snowshoes'
          ? '/images/search-filters/snowshoes.svg'
          : category.slug === 'sled'
            ? '/images/search-filters/sled.svg'
            : category.slug === 'surf'
              ? '/images/search-filters/surf.svg'
              : category.slug === 'paddleboard'
                ? '/images/search-filters/paddleboard.svg'
                : category.slug === 'pedalboat'
                  ? '/images/search-filters/pedalboat.svg'
                  : category.slug === 'canoe'
                    ? '/images/search-filters/canoe.svg'
                    : category.slug === 'kayak'
                      ? '/images/search-filters/kayak.svg'
                      : category.slug === 'bodyboard'
                        ? '/images/search-filters/bodyboard.svg'
                        : category.slug === 'wingfoil'
                          ? '/images/search-filters/wingfoil.svg'
                          : null;

  return (
    <span className={styles.familyIllustration}>
      {customIllustration ? (
        <Image src={customIllustration} alt="" width={56} height={40} unoptimized />
      ) : (
        <FamilyIllustration slug={category.slug} />
      )}
    </span>
  );
}

function BikeSubtypeVisual({ subtype }: { subtype: BikeSubtype }): React.ReactElement {
  const illustration =
    subtype === 'mtb'
      ? '/images/search-filters/vtt.svg'
      : subtype === 'city'
        ? '/images/search-filters/city-bike.svg'
        : subtype === 'road'
          ? '/images/search-filters/road-bike.svg'
          : '/images/search-filters/cargo-bike.svg';

  return (
    <span className={styles.familyIllustration}>
      <Image src={illustration} alt="" width={56} height={40} unoptimized />
    </span>
  );
}

type EquipmentPanelOption =
  | { kind: 'bike-subtype'; subtype: BikeSubtype }
  | { kind: 'category'; category: PublicSearchCategoryOption };

export function EquipmentPanel({
  categories,
  locale,
  onChoose,
  onChooseBikeSubtype,
}: {
  categories: PublicSearchCategoryOption[];
  locale: SearchLocale;
  onChoose: (id: string) => void;
  onChooseBikeSubtype?: (subtype: BikeSubtype) => void;
}): React.ReactElement {
  const fr = locale === 'fr';
  const [query, setQuery] = useState('');
  const [branchId, setBranchId] = useState<string | null>(null);
  const [terrain, setTerrain] = useState<EquipmentTerrain>('all');
  const [showAll, setShowAll] = useState(false);
  const branch = categories.find((c) => c.id === branchId);
  const bikeFamily = categories.find((c) => c.slug === 'bike');
  const families = branch
    ? categories.filter((c) => c.parentId === branch.id)
    : equipmentFamilies(categories);
  const filteredFamilies = filterEquipmentFamilies(families, terrain);
  const visible =
    terrain === 'all' && !showAll && !branch ? filteredFamilies.slice(0, 8) : filteredFamilies;
  const matches = rankEquipmentSuggestions(categories, query, locale);
  const bikeSubtypeMatches =
    bikeFamily && (terrain === 'all' || terrain === 'land')
      ? rankBikeSubtypeSuggestions(query, locale)
      : [];
  const panelOptions: EquipmentPanelOption[] =
    terrain === 'land' && !branch && bikeFamily
      ? visible.flatMap((category): EquipmentPanelOption[] =>
          category.id === bikeFamily.id
            ? BIKE_SUBTYPE_DEFINITIONS.map((definition) => ({
                kind: 'bike-subtype' as const,
                subtype: definition.slug,
              }))
            : [{ kind: 'category' as const, category }],
        )
      : visible.map((category) => ({ kind: 'category' as const, category }));
  const suggestionOptions = [
    ...matches.map((category) => ({
      id: category.id,
      label: getPublicCategoryLabel(locale, category),
      detail: categoryBreadcrumb(category, categories, locale),
    })),
    ...bikeSubtypeMatches.map((match) => ({
      id: match.id,
      label: getBikeSubtypeLabel(locale, match.subtype),
      detail: getPublicCategoryLabel(locale, bikeFamily!),
    })),
  ];
  const terrainFilters: Array<{ key: EquipmentTerrain; fr: string; en: string }> = [
    { key: 'all', fr: 'Tous', en: 'All' },
    { key: 'land', fr: 'Sur terre', en: 'On land' },
    { key: 'water', fr: 'Sur l’eau', en: 'On water' },
    { key: 'snow', fr: 'Sur la neige', en: 'On snow' },
  ];
  const placeholder =
    terrain === 'water'
      ? fr
        ? 'Kayak, paddle, surf, wingfoil…'
        : 'Kayak, paddleboard, surf, wingfoil…'
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

  function handleSuggestionChoose(id: string): void {
    if (id.startsWith(BIKE_SUBTYPE_SUGGESTION_PREFIX)) {
      const rawSubtype = id.slice(BIKE_SUBTYPE_SUGGESTION_PREFIX.length);
      if (isBikeSubtype(rawSubtype) && bikeFamily) {
        onChooseBikeSubtype?.(rawSubtype);
        if (!onChooseBikeSubtype) onChoose(bikeFamily.id);
        return;
      }
    }
    onChoose(id);
  }

  function handleBikeSubtypeChoose(subtype: BikeSubtype): void {
    if (onChooseBikeSubtype) onChooseBikeSubtype(subtype);
    else if (bikeFamily) onChoose(bikeFamily.id);
  }
  return (
    <>
      <SuggestionPicker
        label={fr ? 'Rechercher un équipement' : 'Find equipment'}
        placeholder={placeholder}
        hideLabel
        query={query}
        onQuery={setQuery}
        options={suggestionOptions}
        onChoose={handleSuggestionChoose}
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
      {!query || suggestionOptions.length === 0 ? (
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
            {panelOptions.map((option) =>
              option.kind === 'bike-subtype' ? (
                <Button
                  key={`bike-${option.subtype}`}
                  type="button"
                  variant="quiet"
                  className={styles.family}
                  onClick={() => handleBikeSubtypeChoose(option.subtype)}
                >
                  <BikeSubtypeVisual subtype={option.subtype} />
                  <span>{getBikeSubtypeLabel(locale, option.subtype)}</span>
                </Button>
              ) : (
                <Button
                  key={option.category.id}
                  type="button"
                  variant="quiet"
                  className={styles.family}
                  onClick={() => {
                    if (categories.some((c) => c.parentId === option.category.id)) {
                      setBranchId(option.category.id);
                      setShowAll(false);
                      setQuery('');
                    } else onChoose(option.category.id);
                  }}
                >
                  <FamilyVisual category={option.category} />
                  <span>{getPublicCategoryLabel(locale, option.category)}</span>
                </Button>
              ),
            )}
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
