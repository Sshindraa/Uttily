import Image from 'next/image';
import { HomeSearch } from './home-search';
import styles from './home-hero.module.css';

export function HomeHero({ locale }: { locale: 'fr' | 'en' }): React.ReactElement {
  const fr = locale === 'fr';
  return (
    <section className={styles.hero} aria-labelledby="home-heading">
      <div className={styles.visual}>
        <Image
          src="/images/home/mountain-lake-road.jpg"
          alt={
            fr
              ? 'Cycliste sur une route côtière et surfeur dans les vagues face aux montagnes enneigées'
              : 'Cyclist on a coastal road and surfer riding waves facing snow-capped peaks'
          }
          fill
          priority
          unoptimized
          sizes="100vw"
          className={styles.photo}
        />
        <div className={styles.shade} />
      </div>
      <div className={styles.heroContent}>
        <div className={styles.caption}>
          <div className={styles.copy}>
            <h1 id="home-heading" className={styles.heading}>
              <span className={styles.titleLine1}>
                {fr ? 'Votre équipement' : 'Your equipment'}
              </span>
              <span className={styles.titleLine2}>
                <span className={styles.titleSolid}>{fr ? 'vous' : 'is'}</span>{' '}
                <span className={styles.titleMuted}>{fr ? 'attend.' : 'waiting.'}</span>
              </span>
            </h1>
            <p className={styles.description}>
              <span className={styles.descSolid}>{fr ? 'Réservez en ligne.' : 'Book online.'}</span>{' '}
              <span className={styles.descMuted}>
                {fr ? 'Récupérez votre matériel sur place.' : 'Collect your equipment on site.'}
              </span>
            </p>
          </div>
        </div>
        <div className={styles.searchPosition}>
          <HomeSearch key={locale} locale={locale} />
        </div>
      </div>
    </section>
  );
}
