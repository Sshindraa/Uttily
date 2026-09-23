'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import type { PublicSearchFilterOptions } from '@uttily/core';
import { getBikeSubtypeLabel, type BikeSubtype } from '@uttily/contracts';
import { Button, Icon, LinkButton } from '@uttily/ui';
import { loadHomeSearchOptions } from '@/app/actions/home-search-options';
import type { PublicSearchFormValues } from '@/lib/public-search';
import { getPublicCategoryLabel } from '@/lib/public-search-labels';
import type { IntentProposal } from '@uttily/intelligence';
import { DestinationPanel } from './destination-panel';
import { EquipmentPanel } from './equipment-panel';
import { DatesPanel } from './dates-panel';
import { PeoplePanel } from './people-panel';
import { SmartSearchAssistant } from './smart-search-assistant';
import {
  buildSearchQuery,
  dateSummary,
  initialSelection,
  resolveDestinationPublicId,
  shiftDate,
  type SearchField,
  type SearchLocale,
  type SearchSelection,
} from './search-state';
import styles from './search-intent.module.css';

export function SearchIntentBar({
  locale,
  initialValues,
  initialOptions,
  stickyOnScroll = false,
  fieldErrors = {},
  middleSlot,
  smartAssistantAfterSearch = false,
}: {
  locale: SearchLocale;
  initialValues?: PublicSearchFormValues;
  initialOptions?: PublicSearchFilterOptions;
  stickyOnScroll?: boolean;
  fieldErrors?: Record<string, string>;
  middleSlot?: React.ReactNode;
  smartAssistantAfterSearch?: boolean;
}): React.ReactElement {
  const fr = locale === 'fr';
  const router = useRouter();
  const panelId = useId();
  const [selection, setSelection] = useState(() => initialSelection(initialValues));
  const [field, setField] = useState<SearchField | null>(null);
  const [options, setOptions] = useState<PublicSearchFilterOptions | null>(initialOptions ?? null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(Object.values(fieldErrors)[0] ?? null);
  const [pinned, setPinned] = useState(false);
  const [panelSpace, setPanelSpace] = useState(600);
  const [barHeight, setBarHeight] = useState(0);
  const [searchLift, setSearchLift] = useState(0);
  const anchor = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLFormElement>(null);
  const panel = useRef<HTMLElement>(null);
  const shouldLoad = field !== null && options === null;

  useLayoutEffect(() => {
    const updateLift = () => {
      const element = anchor.current;
      if (
        !element ||
        !stickyOnScroll ||
        !middleSlot ||
        pinned ||
        !field ||
        window.innerWidth <= 768
      ) {
        setSearchLift(0);
        return;
      }
      // Recover the resting position even when resizing during the transition.
      const currentTop = Number.parseFloat(window.getComputedStyle(element).top) || 0;
      const restingTop = element.getBoundingClientRect().top - currentTop;
      const headerBottom = document.querySelector('header')?.getBoundingClientRect().bottom ?? 80;
      const targetTop = Math.max(104, headerBottom + 24);
      setSearchLift(Math.max(0, restingTop - targetTop));
    };
    updateLift();
    window.addEventListener('resize', updateLift);
    return () => window.removeEventListener('resize', updateLift);
  }, [field, pinned, stickyOnScroll, middleSlot]);

  useEffect(() => {
    if (!shouldLoad) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    loadHomeSearchOptions(locale)
      .then((result) => {
        if (cancelled) return;
        setOptions(result);
        setFailed(!result);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [shouldLoad, locale, retry]);

  useEffect(() => {
    const element = bar.current;
    if (!element) return;

    const update = () => {
      const nextHeight = element.getBoundingClientRect().height;
      setBarHeight((previous) => (Math.abs(previous - nextHeight) > 0.5 ? nextHeight : previous));
    };

    update();
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let frame: number | null = null;
    const motionUntil = performance.now() + 500;
    const update = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (stickyOnScroll && anchor.current) {
          const isPinned = anchor.current.getBoundingClientRect().top <= 12;
          setPinned((prev) => (prev !== isPinned ? isPinned : prev));
        }
        if (field && bar.current) {
          const space = Math.max(
            220,
            window.innerHeight - bar.current.getBoundingClientRect().bottom - 28,
          );
          setPanelSpace((prev) => (Math.abs(prev - space) > 8 ? space : prev));
        }
        // Re-measure the space throughout the lift, not just at its starting position.
        if (field && performance.now() < motionUntil) update();
      });
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [stickyOnScroll, field, searchLift]);

  useEffect(() => {
    if (!field) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !shell.current?.contains(event.target)) setField(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [field]);

  useEffect(() => {
    if (!field) return;
    const id = requestAnimationFrame(() => {
      const target =
        (field !== 'dates'
          ? panel.current?.querySelector<HTMLElement>('input:not([type="hidden"])')
          : null) ?? panel.current?.querySelector<HTMLElement>('button:not([disabled])');
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [field, options]);

  function closePanel(restoreFocus = true): void {
    if (restoreFocus && field)
      bar.current?.querySelector<HTMLButtonElement>(`[data-field="${field}"]`)?.focus();
    setField(null);
  }
  function change(patch: Partial<SearchSelection>): void {
    setSelection((previous) => ({ ...previous, ...patch }));
    setError(null);
  }

  function changeEquipment(categoryId: string, bikeSubtype?: BikeSubtype): void {
    setSelection((previous) => {
      const next = { ...previous, categoryId };
      if (bikeSubtype) next.bikeSubtype = bikeSubtype;
      else delete next.bikeSubtype;
      return next;
    });
    setError(null);
  }

  async function handleApplyAiProposal(proposal: IntentProposal): Promise<void> {
    const availableOptions = options ?? (await loadHomeSearchOptions(locale));
    if (!options && availableOptions) setOptions(availableOptions);

    const destPublicId = resolveDestinationPublicId(
      availableOptions?.destinations ?? [],
      proposal.destinationPublicId?.value,
      proposal.destination.value,
    );

    let categoryId = proposal.requirements[0]?.categoryId ?? '';
    const firstReq = proposal.requirements[0];
    if (
      categoryId &&
      availableOptions &&
      !availableOptions.categories.some((categoryOption) => categoryOption.id === categoryId)
    ) {
      categoryId = '';
    }
    if (!categoryId && firstReq?.categorySlug && availableOptions) {
      const catMatch = availableOptions.categories.find(
        (c) => c.slug.toLowerCase() === firstReq.categorySlug.toLowerCase(),
      );
      if (catMatch) categoryId = catMatch.id;
    }

    const dates = proposal.dates.value;
    const startDate = dates?.startDate || '';
    let endDate = dates?.endDateExclusive
      ? shiftDate(dates.endDateExclusive, -1)
      : dates?.startDate || '';
    if (startDate && endDate && endDate < startDate) {
      endDate = startDate;
    }
    const withTimes = dates?.mode === 'TIME_RANGE';
    const startTime = dates?.startAt ? dates.startAt.slice(11, 16) : '';
    const endTime = dates?.endAt ? dates.endAt.slice(11, 16) : '';

    setSelection((prev) => ({
      ...prev,
      destinationPublicId:
        proposal.destination.value === null ? '' : destPublicId || prev.destinationPublicId,
      categoryId: proposal.requirements.length === 0 ? '' : categoryId || prev.categoryId,
      startDate: proposal.dates.value === null ? '' : startDate || prev.startDate,
      endDate: proposal.dates.value === null ? '' : endDate || prev.endDate,
      withTimes: proposal.dates.value === null ? false : startDate ? withTimes : prev.withTimes,
      startTime: proposal.dates.value === null ? '' : startDate ? startTime : prev.startTime,
      endTime: proposal.dates.value === null ? '' : startDate ? endTime : prev.endTime,
      people: proposal.peopleCount.value != null ? proposal.peopleCount.value : prev.people,
      requirements: proposal.requirements.length > 0 ? proposal.requirements : prev.requirements,
    }));
    setError(null);
  }

  const destination = options?.destinations.find(
    (d) => d.publicId === selection.destinationPublicId,
  );
  const category = options?.categories.find((c) => c.id === selection.categoryId);
  const fields: Array<{ key: SearchField; label: string; value: string; selected: boolean }> = [
    {
      key: 'destination',
      label: 'Destination',
      value: destination?.label ?? (fr ? 'Où allez-vous ?' : 'Where are you going?'),
      selected: !!destination,
    },
    {
      key: 'equipment',
      label: fr ? 'Équipement' : 'Equipment',
      value: category
        ? selection.bikeSubtype
          ? getBikeSubtypeLabel(locale, selection.bikeSubtype)
          : getPublicCategoryLabel(locale, category)
        : fr
          ? 'Ski, vélo, surf, paddle…'
          : 'Ski, bike, surf, paddleboard…',
      selected: !!category || !!selection.bikeSubtype,
    },
    {
      key: 'dates',
      label: fr ? 'Quand ?' : 'When?',
      value: dateSummary(selection, locale),
      selected: !!selection.startDate,
    },
    {
      key: 'people',
      label: fr ? 'Personnes' : 'People',
      value: fr
        ? `${selection.people} personne${selection.people > 1 ? 's' : ''}`
        : `${selection.people} ${selection.people === 1 ? 'person' : 'people'}`,
      selected: true,
    },
  ];
  const titles: Record<SearchField, string> = {
    destination: fr ? 'Où allez-vous ?' : 'Where are you going?',
    equipment: fr ? 'De quoi avez-vous envie ?' : 'What are you looking for?',
    dates: fr ? 'Quand souhaitez-vous louer ?' : 'When would you like to rent?',
    people: fr ? 'Vous serez combien ?' : 'How many people?',
  };
  const needsOptions = field === 'destination' || field === 'equipment';
  const smartAssistant = (
    <SmartSearchAssistant
      locale={locale}
      onApplyProposal={handleApplyAiProposal}
      onConfirmSearch={() => {
        if (!options) {
          setField('destination');
          setError(fr ? 'Choisissez votre destination.' : 'Choose your destination.');
          return;
        }
        const result = buildSearchQuery(selection, options, locale);
        if (!result.ok) {
          setError(result.message);
          setField(result.field);
          return;
        }
        router.push(`/${locale}/search?${result.query}`);
      }}
    />
  );
  return (
    <div
      ref={anchor}
      className={[styles.anchor, pinned ? styles.anchorPinned : ''].filter(Boolean).join(' ')}
      data-panel-open={field ? '' : undefined}
      data-pinned={pinned ? 'true' : undefined}
      style={
        {
          '--search-bar-height': `${barHeight}px`,
          '--search-lift': `${searchLift}px`,
        } as CSSProperties
      }
    >
      {middleSlot}
      {!smartAssistantAfterSearch ? smartAssistant : null}

      <div
        ref={shell}
        className={[styles.shell, pinned ? styles.pinned : ''].join(' ')}
        data-pinned={pinned ? 'true' : undefined}
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            !event.currentTarget.contains(event.relatedTarget)
          )
            setField(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && field) {
            event.preventDefault();
            closePanel();
          }
        }}
      >
        <form
          ref={bar}
          className={styles.bar}
          action={`/${locale}/search`}
          method="get"
          aria-label={fr ? 'Rechercher un équipement' : 'Search for equipment'}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!options) {
              setField('destination');
              setError(fr ? 'Choisissez votre destination.' : 'Choose your destination.');
              return;
            }
            const result = buildSearchQuery(selection, options, locale);
            if (!result.ok) {
              setError(result.message);
              setField(result.field);
              return;
            }
            setField(null);
            router.push(`/${locale}/search?${result.query}`);
          }}
        >
          {fields.map((item) => (
            <Button
              type="button"
              variant="quiet"
              key={item.key}
              data-field={item.key}
              className={[styles.field, field === item.key ? styles.activeField : ''].join(' ')}
              aria-haspopup="dialog"
              aria-expanded={field === item.key}
              aria-controls={field === item.key ? panelId : undefined}
              onClick={() => {
                setField((previous) => (previous === item.key ? null : item.key));
                setError(null);
              }}
            >
              <span className={styles.fieldLabel}>{item.label}</span>
              <span
                className={[styles.fieldValue, item.selected ? styles.selectedValue : ''].join(' ')}
                title={item.value}
              >
                {item.value}
              </span>
            </Button>
          ))}
          <Button type="submit" className={styles.submit} aria-label={fr ? 'Rechercher' : 'Search'}>
            <Icon name="search" size={23} />
          </Button>
        </form>
        {field ? (
          <section
            ref={panel}
            id={panelId}
            role="dialog"
            aria-labelledby={`${panelId}-title`}
            className={styles.panel}
            data-field={field}
            style={{ '--search-panel-space': `${panelSpace}px` } as CSSProperties}
          >
            <div className={styles.panelHeader}>
              <h2 id={`${panelId}-title`}>{titles[field]}</h2>
              <Button
                type="button"
                variant="quiet"
                className={styles.close}
                aria-label={fr ? 'Fermer' : 'Close'}
                onClick={() => closePanel()}
              >
                <Icon name="x" size={20} />
              </Button>
            </div>
            {error ? (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            ) : null}
            {needsOptions && loading ? (
              <p role="status" className={styles.hint}>
                {fr ? 'Chargement des choix disponibles…' : 'Loading available choices…'}
              </p>
            ) : null}
            {needsOptions && failed ? (
              <div className={styles.unavailable}>
                <p role="alert">
                  {fr
                    ? 'Les choix sont momentanément indisponibles.'
                    : 'Choices are temporarily unavailable.'}
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  {fr ? 'Réessayer' : 'Try again'}
                </Button>
                <LinkButton href={`/${locale}/search`} variant="quiet">
                  {fr ? 'Accéder à la recherche' : 'Go to search'}
                </LinkButton>
              </div>
            ) : null}
            {field === 'destination' && options ? (
              options.destinations.length ? (
                <DestinationPanel
                  key={field}
                  destinations={options.destinations}
                  locale={locale}
                  onChoose={(id) => {
                    change({ destinationPublicId: id });
                    if (!selection.categoryId && !selection.startDate) setField('equipment');
                    else closePanel();
                  }}
                />
              ) : (
                <p className={styles.hint}>
                  {fr
                    ? 'Aucune destination n’est ouverte pour le moment.'
                    : 'No destinations are open yet.'}
                </p>
              )
            ) : null}
            {field === 'equipment' && options ? (
              <EquipmentPanel
                key={field}
                categories={options.categories}
                locale={locale}
                onChoose={(id) => {
                  changeEquipment(id);
                  if (!selection.startDate) setField('dates');
                  else closePanel();
                }}
                onChooseBikeSubtype={(subtype: BikeSubtype) => {
                  const bikeCategory = options.categories.find(
                    (categoryOption) => categoryOption.slug === 'bike',
                  );
                  if (!bikeCategory) return;
                  changeEquipment(bikeCategory.id, subtype);
                  if (!selection.startDate) setField('dates');
                  else closePanel();
                }}
              />
            ) : null}
            {field === 'dates' ? (
              <DatesPanel
                selection={selection}
                locale={locale}
                onChange={change}
                onDone={() => closePanel()}
              />
            ) : null}
            {field === 'people' ? (
              <PeoplePanel
                count={selection.people}
                locale={locale}
                onChange={(people) => change({ people })}
                onDone={() => closePanel()}
              />
            ) : null}
          </section>
        ) : error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </div>
      {smartAssistantAfterSearch ? (
        <div className={styles.assistantAfterSearch}>{smartAssistant}</div>
      ) : null}
      <noscript>
        <a className={styles.fallback} href={`/${locale}/search`}>
          {fr ? 'Accéder à la recherche' : 'Go to search'}
        </a>
      </noscript>
    </div>
  );
}
