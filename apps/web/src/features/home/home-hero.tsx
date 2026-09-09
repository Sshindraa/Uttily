import Image from 'next/image';
import { HomeSearch } from './home-search';
import styles from './home-hero.module.css';

export function HomeHero({ locale }: { locale: 'fr' | 'en' }): React.ReactElement {
  const fr = locale === 'fr';

  const heading = (
    <div className={styles.intro}>
      <h1 id="home-heading" className={styles.heading}>
        <span className={styles.titleSolid}>
          {fr ? 'Louez votre équipement,' : 'Rent your equipment,'}
        </span>{' '}
        <span className={styles.titleMuted}>{fr ? 'là où vous partez.' : 'where you go.'}</span>
      </h1>
    </div>
  );

  return (
    <section className={styles.hero} aria-labelledby="home-heading">
      <div className={styles.visual}>
        <Image
          src="/images/home/mountain-lake-road.png"
          alt={
            fr
              ? 'Cycliste sur une route côtière et surfeur dans les vagues face aux montagnes enneigées'
              : 'Cyclist on a coastal road and surfer riding waves facing snow-capped peaks'
          }
          fill
          priority
          quality={90}
          sizes="100vw"
          className={styles.photo}
        />
        <div className={styles.shade} />
      </div>
      <div className={styles.heroContent}>
        <div className={styles.searchPosition}>
          <HomeSearch key={locale} locale={locale} middleSlot={heading} smartAssistantAfterSearch />
          <ul
            className={styles.trustSignals}
            aria-label={fr ? 'Engagements Uttily' : 'Uttily commitments'}
          >
            <li>
              <span aria-hidden="true">✓</span>
              {fr ? 'Paiement sécurisé' : 'Secure payment'}
            </li>
            <li>
              <span aria-hidden="true">✓</span>
              {fr ? 'Loueurs professionnels' : 'Professional rental operators'}
            </li>
            <li>
              <span aria-hidden="true">✓</span>
              {fr ? 'Retrait sur place' : 'Pickup on site'}
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
