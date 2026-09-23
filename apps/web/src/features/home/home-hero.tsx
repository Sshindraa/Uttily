'use client';

import * as React from 'react';
import Image from 'next/image';
import { HomeSearch } from './home-search';
import styles from './home-hero.module.css';

export function HomeHero({ locale }: { locale: 'fr' | 'en' }): React.ReactElement {
  const fr = locale === 'fr';
  const parallaxRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      return;
    }

    let rafId: number | null = null;

    const handleScroll = (): void => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!parallaxRef.current) return;
        const scrollY = window.scrollY || window.pageYOffset;
        const heroHeight = window.innerHeight;
        // Keep parallax active while the hero is in or near view
        if (scrollY <= heroHeight * 1.5) {
          const translateY = Math.max(0, scrollY) * 0.22;
          parallaxRef.current.style.transform = `translate3d(0, ${translateY.toFixed(1)}px, 0)`;
        }
      });
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, []);

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
        <div ref={parallaxRef} className={styles.parallaxWrapper}>
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
        </div>
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
