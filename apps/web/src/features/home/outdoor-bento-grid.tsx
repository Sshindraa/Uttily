'use client';

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Icon } from '@uttily/ui';
import { ScrollReveal } from '@/components/scroll-reveal';
import styles from './outdoor-bento-grid.module.css';

export interface OutdoorBentoGridProps {
  locale: 'fr' | 'en';
}

interface DestinationSpot {
  id: string;
  category: { fr: string; en: string };
  title: { fr: string; en: string };
  description: { fr: string; en: string };
  liveBadge: { fr: string; en: string };
  featureBadge: { fr: string; en: string };
  tags: string[];
  actionLabel: { fr: string; en: string };
  href: string;
  imageSrc: string;
  imageAlt: { fr: string; en: string };
  isHero?: boolean;
}

const DESTINATION_SPOTS: DestinationSpot[] = [
  {
    id: 'chamonix',
    category: {
      fr: 'Alpinisme & VTT · Haute-Savoie',
      en: 'Mountaineering & MTB · Haute-Savoie',
    },
    title: {
      fr: 'Chamonix & Mont-Blanc',
      en: 'Chamonix & Mont-Blanc',
    },
    description: {
      fr: 'VTT enduro, matériel d’alpinisme certifié et packs haute montagne préparés au pied des sommets mythiques.',
      en: 'Enduro mountain bikes, certified mountaineering gear, and alpine packs tuned at the foot of legendary peaks.',
    },
    liveBadge: {
      fr: '14 loueurs pros prêts',
      en: '14 pro shops ready',
    },
    featureBadge: {
      fr: 'Hold 15 min garanti',
      en: 'Guaranteed 15 min hold',
    },
    tags: ['Aiguille du Midi', 'Vallorcine', 'Les Houches'],
    actionLabel: {
      fr: 'Explorer Chamonix',
      en: 'Explore Chamonix',
    },
    href: '/search?destination=Chamonix-Mont-Blanc',
    imageSrc: '/images/home/chamonix-mont-blanc.jpg',
    imageAlt: {
      fr: 'Massif du Mont-Blanc à Chamonix au coucher du soleil avec sentier de montagne pour VTT et alpinisme',
      en: 'Mont-Blanc massif in Chamonix at sunset with mountain singletrack for MTB and mountaineering',
    },
    isHero: true,
  },
  {
    id: 'pays-basque',
    category: {
      fr: 'Surf & Route · Côte Atlantique',
      en: 'Surf & Road Bike · Atlantic Coast',
    },
    title: {
      fr: 'Pays Basque & Landes',
      en: 'Basque Coast & Landes',
    },
    description: {
      fr: 'Shortboards, planches évolutives et vélos de route côtiers pour rider entre dunes océanes et forêt de pins.',
      en: 'Shortboards, funboards, and coastal road bikes ready to ride between ocean waves and pine forests.',
    },
    liveBadge: {
      fr: 'Dispo aujourd’hui',
      en: 'Available today',
    },
    featureBadge: {
      fr: '8 ateliers partenaires',
      en: '8 partner workshops',
    },
    tags: ['Hossegor', 'Biarritz', 'Guéthary'],
    actionLabel: {
      fr: 'Explorer la côte',
      en: 'Explore the coast',
    },
    href: '/search?destination=Biarritz',
    imageSrc: '/images/home/pays-basque-surf.jpg',
    imageAlt: {
      fr: 'Vagues de surf sur la côte Basque et Landaise avec route côtière et forêt de pins',
      en: 'Surf waves on the Basque and Landes coast with coastal scenic road and pine forest',
    },
  },
  {
    id: 'annecy',
    category: {
      fr: 'Paddle & Wingfoil · Lac Alpin',
      en: 'Paddle & Wingfoil · Alpine Lake',
    },
    title: {
      fr: 'Annecy & Eaux Cristallines',
      en: 'Annecy & Crystal Waters',
    },
    description: {
      fr: 'Packs wingfoil et paddles rigides prêts au bord de l’eau, vélos gravel pour faire le tour du lac dès l’aube.',
      en: 'Wingfoil kits and rigid stand up paddles ready waterside, gravel bikes to circle the lake at dawn.',
    },
    liveBadge: {
      fr: 'Retrait sur ponton',
      en: 'Dockside pickup',
    },
    featureBadge: {
      fr: 'Matériel préparé',
      en: 'Inspected & prepared',
    },
    tags: ['Doussard', 'Talloires', 'Semnoz'],
    actionLabel: {
      fr: 'Explorer Annecy',
      en: 'Explore Annecy',
    },
    href: '/search?destination=Annecy',
    imageSrc: '/images/home/annecy-lake.jpg',
    imageAlt: {
      fr: 'Lac d’Annecy aux eaux turquoises avec paddle et wingfoil face aux montagnes',
      en: 'Lake Annecy with crystal turquoise water, paddleboard and wingfoil facing alpine peaks',
    },
  },
];

export function OutdoorBentoGrid({ locale }: OutdoorBentoGridProps): React.ReactElement {
  const fr = locale === 'fr';

  return (
    <section
      className={styles.section}
      aria-labelledby="outdoor-bento-title"
    >
      <ScrollReveal className={styles.header} delay={0} offset={16}>
        <div className={styles.eyebrow}>
          <span className={styles.eyebrowDot} aria-hidden="true" />
          <span>{fr ? 'Destinations & Univers' : 'Destinations & Playgrounds'}</span>
        </div>
        <h2 id="outdoor-bento-title" className={styles.heading}>
          {fr ? 'Les grands terrains de jeu,' : 'The greatest playgrounds,'}{' '}
          <span className={styles.headingAccent}>
            {fr ? 'votre matériel sur place.' : 'your gear waiting on site.'}
          </span>
        </h2>
        <p className={styles.lead}>
          {fr
            ? 'Réservez un équipement physique certifié auprès de nos loueurs professionnels locaux et partez l’esprit tranquille.'
            : 'Reserve verified physical gear directly from local professional rental shops and head out with complete peace of mind.'}
        </p>
      </ScrollReveal>

      <div className={styles.grid}>
        {DESTINATION_SPOTS.map((spot, index) => {
          const isHero = spot.isHero;
          const delay = (index + 1) * 80;

          return (
            <ScrollReveal
              key={spot.id}
              as="div"
              className={isHero ? styles.cardHero : styles.cardSecondary}
              delay={delay}
              offset={16}
            >
              <Link
                href={`/${locale}${spot.href}`}
                className={styles.card}
                style={{ width: '100%', height: '100%' }}
                aria-label={`${spot.title[locale]} - ${spot.category[locale]}`}
              >
                <div className={styles.imageContainer}>
                  <Image
                    src={spot.imageSrc}
                    alt={spot.imageAlt[locale]}
                    fill
                    sizes={isHero ? '(max-width: 1024px) 100vw, 60vw' : '(max-width: 1024px) 100vw, 40vw'}
                    className={styles.image}
                    priority={isHero === true}
                  />
                </div>
                <div className={isHero ? styles.overlayHero : styles.overlaySecondary} aria-hidden="true" />

                <div className={styles.cardTop}>
                  <div className={styles.badgeGroup}>
                    <span className={styles.liveBadge}>
                      <span className={styles.livePulseDot} aria-hidden="true" />
                      <span>{spot.liveBadge[locale]}</span>
                    </span>
                    <span className={styles.featureBadge}>{spot.featureBadge[locale]}</span>
                  </div>
                </div>

                <div className={styles.cardBottom}>
                  <span className={styles.cardCategory}>{spot.category[locale]}</span>
                  <h3 className={styles.cardTitle}>{spot.title[locale]}</h3>
                  <p className={styles.cardDescription}>{spot.description[locale]}</p>

                  <div className={styles.cardTags} aria-label={fr ? 'Points d’intérêt' : 'Highlights'}>
                    {spot.tags.map((tag) => (
                      <span key={tag} className={styles.tag}>
                        {tag}
                      </span>
                    ))}
                  </div>

                  <span className={styles.cardAction}>
                    <span>{spot.actionLabel[locale]}</span>
                    <span className={styles.actionIcon} aria-hidden="true">
                      <Icon name="arrow-up-right" size={16} />
                    </span>
                  </span>
                </div>
              </Link>
            </ScrollReveal>
          );
        })}
      </div>
    </section>
  );
}
