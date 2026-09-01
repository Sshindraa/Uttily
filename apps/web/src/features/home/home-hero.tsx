import Image from 'next/image';
import { HomeSearch } from './home-search';
import styles from './home-hero.module.css';

export function HomeHero({ locale }: { locale: 'fr' | 'en' }): React.ReactElement {
  const fr = locale === 'fr';
  return (
    <section className={styles.hero} aria-labelledby="home-heading">
      <div className={styles.visual}>
        <Image
          src="/images/home/cycling-sunset.jpg"
          alt={
            fr
              ? 'Deux personnes à vélo dans la campagne au coucher du soleil'
              : 'Two people cycling through the countryside at sunset'
          }
          fill
          priority
          sizes="100vw"
          className={styles.photo}
        />
        <div className={styles.shade} />
      </div>
      <div className={styles.heroContent}>
        <div className={styles.caption}>
          <div className={styles.copy}>
            <h1 id="home-heading">
              <span>{fr ? 'Votre équipement' : 'Your equipment'}</span>
              <span>{fr ? 'vous attend.' : 'is waiting.'}</span>
            </h1>
            <p className={styles.description}>
              {fr
                ? 'Réservez en ligne. Récupérez votre matériel sur place.'
                : 'Book online. Collect your equipment on site.'}
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
