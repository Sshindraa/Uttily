'use client';

import { Button, Input } from '@uttily/ui';
import { MAX_SEARCH_PEOPLE } from '@/lib/search-people';
import type { SearchLocale } from './search-state';
import styles from './search-intent.module.css';

export function PeoplePanel({
  count,
  locale,
  onChange,
  onDone,
}: {
  count: number;
  locale: SearchLocale;
  onChange: (count: number) => void;
  onDone: () => void;
}): React.ReactElement {
  const fr = locale === 'fr';
  return (
    <>
      <p className={styles.hint}>
        {fr ? 'Combien serez-vous pour cette sortie ?' : 'How many people are coming?'}
      </p>
      <div className={styles.peopleCounter}>
        <Button
          type="button"
          variant="secondary"
          className={styles.roundControl}
          aria-label={fr ? 'Retirer une personne' : 'Remove one person'}
          disabled={count <= 1}
          onClick={() => onChange(count - 1)}
        >
          −
        </Button>
        <label className={styles.peopleValue}>
          <span className={styles.srOnly}>{fr ? 'Nombre de personnes' : 'Number of people'}</span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_SEARCH_PEOPLE}
            value={count}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (Number.isInteger(value) && value >= 1 && value <= MAX_SEARCH_PEOPLE)
                onChange(value);
            }}
          />
          <span aria-hidden="true">
            {fr ? (count === 1 ? 'personne' : 'personnes') : count === 1 ? 'person' : 'people'}
          </span>
        </label>
        <Button
          type="button"
          variant="secondary"
          className={styles.roundControl}
          aria-label={fr ? 'Ajouter une personne' : 'Add one person'}
          disabled={count >= MAX_SEARCH_PEOPLE}
          onClick={() => onChange(count + 1)}
        >
          +
        </Button>
      </div>
      <p className={styles.peopleNotice}>
        {fr
          ? 'Ce nombre est conservé avec votre recherche. Pour le moment, il ne calcule ni la quantité d’équipements ni un tarif de groupe : vérifiez la capacité de chaque offre.'
          : 'This number stays with your search. It does not yet calculate equipment quantities or group pricing: check each offer’s capacity.'}
      </p>
      <div className={styles.panelFooter}>
        <span />
        <Button type="button" className={styles.confirm} onClick={onDone}>
          {fr ? 'Valider' : 'Done'}
        </Button>
      </div>
    </>
  );
}
