'use client';

import * as React from 'react';
import Link from 'next/link';
import { Icon, type IconName } from '@uttily/ui';
import { ScrollReveal } from '@/components/scroll-reveal';
import styles from './featured-showcase.module.css';

interface ShowcaseSlide {
  id: string;
  tabLabel: { fr: string; en: string };
  category: { fr: string; en: string };
  title: { fr: string; en: string };
  statNumber: string;
  statLabel: { fr: string; en: string };
  description: { fr: string; en: string };
  trustPills: { fr: string[]; en: string[] };
  actionLabel: { fr: string; en: string };
  actionHref: string;
  iconName: IconName;
  screenLabel: { fr: string; en: string };
}

const SHOWCASE_SLIDES: ShowcaseSlide[] = [
  {
    id: 'bikes',
    tabLabel: { fr: 'Vélos & VAE', en: 'Bikes & e-Bikes' },
    category: { fr: 'Vélos & VAE · Disponible', en: 'Bikes & e-Bikes · Available' },
    title: {
      fr: 'Réservation directe & retrait en station',
      en: 'Direct booking & pickup at your destination',
    },
    statNumber: '100%',
    statLabel: {
      fr: 'Exemplaires physiques garantis',
      en: 'Guaranteed physical inventory',
    },
    description: {
      fr: 'Du VTT enduro au vélo de route de haute montagne, chaque équipement est révisé par un loueur professionnel partenaire avant chaque sortie.',
      en: 'From enduro mountain bikes to high-mountain road bikes, every piece of equipment is serviced by a professional local partner.',
    },
    trustPills: {
      fr: ['Révisé en atelier pro', 'Hold garanti sans débit', 'Retrait direct station'],
      en: ['Workshop inspected', 'Guaranteed instant hold', 'Direct pickup at destination'],
    },
    actionLabel: { fr: 'Explorer les vélos', en: 'Explore bikes' },
    actionHref: '/offers',
    iconName: 'bike',
    screenLabel: { fr: 'Catalogue Vélos & VAE', en: 'Bikes & e-Bikes' },
  },
  {
    id: 'winter',
    tabLabel: { fr: 'Sports d’Hiver', en: 'Winter Sports' },
    category: { fr: 'Sports d’Hiver · En saison', en: 'Winter Sports · In season' },
    title: {
      fr: 'Pack glisse complet prêt au pied des pistes',
      en: 'Complete ski & board gear ready slopeside',
    },
    statNumber: '0 min',
    statLabel: {
      fr: 'D’attente inutile en boutique',
      en: 'Wasted waiting time in-store',
    },
    description: {
      fr: 'Skis alpins, snowboards et chaussures réglés à votre profil en amont, avec hold temporaire garanti sans mauvaise surprise.',
      en: 'Alpine skis, snowboards, and fitted boots preset to your profile in advance, backed by guaranteed instant holds.',
    },
    trustPills: {
      fr: ['Réglages fixations sur-mesure', 'Au pied des remontées', 'Matériel farté et affûté'],
      en: ['Custom binding setup', 'Slopeside pickup', 'Waxed & sharpened gear'],
    },
    actionLabel: { fr: 'Découvrir les packs glisse', en: 'Discover winter gear' },
    actionHref: '/offers',
    iconName: 'pin',
    screenLabel: { fr: 'Packs Glisse & Skis', en: 'Ski & Snowboard Packs' },
  },
  {
    id: 'water',
    tabLabel: { fr: 'Sports Nautiques', en: 'Water Sports' },
    category: { fr: 'Sports Nautiques · Lac & Mer', en: 'Water Sports · Lakes & Ocean' },
    title: {
      fr: 'Kayaks, wingfoils et paddles au bord de l’eau',
      en: 'Kayaks, wingfoils & paddles right by the water',
    },
    statNumber: '4',
    statLabel: {
      fr: 'Univers outdoor canoniques',
      en: 'Canonical outdoor universes',
    },
    description: {
      fr: 'Naviguez en toute sérénité grâce à des équipements homologués et loués par des bases nautiques professionnelles locales.',
      en: 'Hit the water with confidence using certified gear rented by professional local water-sport centers.',
    },
    trustPills: {
      fr: ['Gilets & pagaies fournis', 'Bases nautiques certifiées', 'Point météo & sécurité'],
      en: ['Vests & paddles included', 'Certified water bases', 'Safety briefing included'],
    },
    actionLabel: { fr: 'Explorer le nautisme', en: 'Explore water sports' },
    actionHref: '/offers',
    iconName: 'heart',
    screenLabel: { fr: 'Bases Nautiques & Flotte', en: 'Water Sports Fleet' },
  },
  {
    id: 'mountain',
    tabLabel: { fr: 'Montagne & Rando', en: 'Mountain & Hiking' },
    category: { fr: 'Montagne & Rando · Toute l’année', en: 'Mountain & Hiking · Year-round' },
    title: {
      fr: 'Matériel d’alpinisme et bivouac de précision',
      en: 'High-precision mountaineering & trekking gear',
    },
    statNumber: '48h',
    statLabel: {
      fr: 'D’anticipation ou départ immédiat',
      en: 'Advance planning or instant departure',
    },
    description: {
      fr: 'Préparez vos ascensions et randonnées avec du matériel de sécurité vérifié et des conseils sur mesure par des experts locaux.',
      en: 'Plan your climbs and treks with safety-checked gear and custom advice from local mountain professionals.',
    },
    trustPills: {
      fr: ['Contrôle EPI certifié', 'Conseils guides de terrain', 'Matériel léger de pointe'],
      en: ['Certified safety gear', 'Local mountain guides', 'Lightweight performance gear'],
    },
    actionLabel: { fr: 'Découvrir la montagne', en: 'Discover mountain gear' },
    actionHref: '/offers',
    iconName: 'pin',
    screenLabel: { fr: 'Matériel Alpinisme & Rando', en: 'Alpine & Trekking Gear' },
  },
];

export interface FeaturedShowcaseProps {
  locale?: 'fr' | 'en';
}

/**
 * Composant PhoneMockup : reproduit un iPhone 16 Pro avec bordures ultra-fines,
 * Dynamic Island, reflets de verre et canvas intérieur vide haut de gamme.
 */
function PhoneMockup({
  positionClass,
  testId,
  label,
  iconName,
  slotTitle,
  isFrench,
}: {
  positionClass: string;
  testId: string;
  label: string;
  iconName: IconName;
  slotTitle: string;
  isFrench: boolean;
}): React.ReactElement {
  return (
    <div
      className={`${styles.phoneMockup} ${positionClass}`}
      data-testid={testId}
      aria-label={label}
    >
      <div className={styles.phoneScreen}>
        {/* Reflet de vitre diagonale Apple */}
        <div className={styles.screenGlare} aria-hidden="true" />

        {/* Dynamic Island avec lentille de caméra */}
        <div className={styles.dynamicIsland} aria-hidden="true">
          <div className={styles.sensorHole} />
        </div>

        {/* Barre d'état iOS */}
        <div className={styles.phoneStatusBar} aria-hidden="true">
          <span>9:41</span>
          <div className={styles.statusIcons}>
            {/* Signal Cellulaire 4 barres */}
            <svg width="15" height="11" viewBox="0 0 17 11" fill="currentColor">
              <rect x="0" y="8" width="3" height="3" rx="0.5" />
              <rect x="4.5" y="5.5" width="3" height="5.5" rx="0.5" />
              <rect x="9" y="3" width="3" height="8" rx="0.5" />
              <rect x="13.5" y="0" width="3" height="11" rx="0.5" />
            </svg>
            {/* Wi-Fi */}
            <svg width="14" height="11" viewBox="0 0 16 12" fill="currentColor">
              <path d="M8 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm-4.24-3.18a6 6 0 0 1 8.48 0 .75.75 0 0 1-1.06 1.06 4.5 4.5 0 0 0-6.36 0 .75.75 0 1 1-1.06-1.06Zm-2.83-2.83a10 10 0 0 1 14.14 0 .75.75 0 0 1-1.06 1.06 8.5 8.5 0 0 0-12.02 0 .75.75 0 1 1-1.06-1.06Z" />
            </svg>
            {/* Batterie */}
            <svg width="22" height="11" viewBox="0 0 25 12" fill="currentColor">
              <rect x="0.5" y="0.5" width="21" height="11" rx="3" fill="none" stroke="currentColor" />
              <rect x="2.5" y="2.5" width="14" height="7" rx="1.5" />
              <path d="M23 4.5v3a1.5 1.5 0 0 0 1.5-1.5 1.5 1.5 0 0 0-1.5-1.5Z" />
            </svg>
          </div>
        </div>

        {/* Écran intérieur vide (canvas haut de gamme prêt pour le futur) */}
        <div className={styles.phoneCanvas} data-testid={`${testId}-canvas`}>
          <div className={styles.canvasCard}>
            <div className={styles.canvasTop}>
              <span className={styles.canvasDot} />
              <span>Uttily OS · Mobile</span>
            </div>

            <div className={styles.canvasCenter}>
              <div className={styles.canvasIconRing}>
                <Icon name={iconName} size={24} />
              </div>
              <h4 className={styles.canvasTitle}>{slotTitle}</h4>
              <p className={styles.canvasSubtitle}>
                {isFrench
                  ? 'Écran modulaire disponible'
                  : 'Modular screen placeholder'}
              </p>
            </div>

            <div className={styles.canvasBottom}>
              <span>{isFrench ? 'Écran disponible' : 'Screen available'}</span>
            </div>
          </div>
        </div>

        {/* Home Indicator */}
        <div className={styles.homeIndicator} aria-hidden="true" />
      </div>
    </div>
  );
}

export function FeaturedShowcase({ locale = 'fr' }: FeaturedShowcaseProps): React.ReactElement {
  const [currentIndex, setCurrentIndex] = React.useState(0);
  const [isPaused, setIsPaused] = React.useState(false);
  const [dragOffset, setDragOffset] = React.useState(0);
  const [isDragging, setIsDragging] = React.useState(false);
  const touchStartX = React.useRef<number | null>(null);
  const mouseStartX = React.useRef<number | null>(null);
  const hadDragged = React.useRef(false);

  const isFrench = locale === 'fr';

  const handlePrev = React.useCallback((): void => {
    setCurrentIndex((prev) => (prev === 0 ? SHOWCASE_SLIDES.length - 1 : prev - 1));
  }, []);

  const handleNext = React.useCallback((): void => {
    setCurrentIndex((prev) => (prev === SHOWCASE_SLIDES.length - 1 ? 0 : prev + 1));
  }, []);

  // Autoplay à la Orbix Studio (pause au survol ou pendant l'interaction)
  React.useEffect(() => {
    if (isPaused || isDragging) return;
    const interval = setInterval(() => {
      handleNext();
    }, 6000);
    return () => clearInterval(interval);
  }, [isPaused, isDragging, handleNext]);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') {
        handlePrev();
      } else if (e.key === 'ArrowRight') {
        handleNext();
      }
    },
    [handlePrev, handleNext],
  );

  // Touch Swipe
  const onTouchStart = (e: React.TouchEvent): void => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
    hadDragged.current = false;
    setIsDragging(true);
  };

  const onTouchMove = (e: React.TouchEvent): void => {
    if (touchStartX.current === null) return;
    const currentX = e.touches[0]?.clientX ?? touchStartX.current;
    const diff = currentX - touchStartX.current;
    if (Math.abs(diff) > 5) {
      hadDragged.current = true;
    }
    setDragOffset(diff);
  };

  const onTouchEnd = (): void => {
    if (touchStartX.current !== null) {
      if (dragOffset < -50) {
        handleNext();
      } else if (dragOffset > 50) {
        handlePrev();
      }
    }
    touchStartX.current = null;
    setDragOffset(0);
    setIsDragging(false);
    setTimeout(() => {
      hadDragged.current = false;
    }, 50);
  };

  // Mouse Drag
  const onMouseDown = (e: React.MouseEvent): void => {
    mouseStartX.current = e.clientX;
    hadDragged.current = false;
    setIsDragging(true);
  };

  const onMouseMove = (e: React.MouseEvent): void => {
    if (mouseStartX.current === null || !isDragging) return;
    const diff = e.clientX - mouseStartX.current;
    if (Math.abs(diff) > 5) {
      hadDragged.current = true;
    }
    setDragOffset(diff);
  };

  const onMouseUp = (): void => {
    if (mouseStartX.current !== null) {
      if (dragOffset < -50) {
        handleNext();
      } else if (dragOffset > 50) {
        handlePrev();
      }
    }
    mouseStartX.current = null;
    setDragOffset(0);
    setIsDragging(false);
    setTimeout(() => {
      hadDragged.current = false;
    }, 50);
  };

  return (
    <section
      id="featured-showcase"
      className={styles.section}
      aria-label={isFrench ? 'Expérience mobile et matériel en vedette' : 'Featured mobile experience & gear'}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <div className={styles.container}>
        {/* En-tête avec badge et titre bi-police signature Orbix + Scroll-driven Reveal */}
        <ScrollReveal as="header" className={styles.header} delay={0} offset={16}>
          <div className={styles.badge}>
            <span className={styles.badgeIconWrap} aria-hidden="true">
              <Icon name="check" size={12} />
            </span>
            <span>{isFrench ? 'Expérience mobile' : 'Featured Experience'}</span>
          </div>

          <h2 className={styles.title}>
            <span className={styles.titleSolid}>
              {isFrench ? 'Explorez notre expérience' : 'Explore Our Latest'}
            </span>
            <span className={styles.serifItalic}>
              {isFrench ? 'pensée pour le terrain outdoor' : 'Work Across Industries'}
            </span>
          </h2>
        </ScrollReveal>

        {/* Slider Carousel style Orbix Studio avec Scroll-driven Reveal */}
        <ScrollReveal className={styles.sliderRevealWrapper} delay={140} offset={16}>
          <div
            className={styles.sliderWrapper}
            onMouseEnter={() => setIsPaused(true)}
            onMouseLeave={() => {
              setIsPaused(false);
              if (isDragging) {
                onMouseUp();
              }
            }}
          >
            {/* Bouton flèche gauche circulaire flottant */}
            <button
              type="button"
              className={`${styles.arrowBtn} ${styles.arrowLeft}`}
              onClick={handlePrev}
              aria-label={isFrench ? 'Slide précédent' : 'Previous slide'}
              data-testid="showcase-prev-btn"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>

            {/* Bouton flèche droite circulaire flottant */}
            <button
              type="button"
              className={`${styles.arrowBtn} ${styles.arrowRight}`}
              onClick={handleNext}
              aria-label={isFrench ? 'Slide suivant' : 'Next slide'}
              data-testid="showcase-next-btn"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>

          {/* Masque de défilement horizontal */}
          <div
            className={styles.sliderMask}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
          >
            <div
              className={styles.sliderTrack}
              style={{
                transform: `translate3d(calc(-${currentIndex * 100}% + ${dragOffset}px), 0, 0)`,
                transition: isDragging ? 'none' : 'transform 600ms cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            >
              {SHOWCASE_SLIDES.map((slide, index) => {
                const isFirst = index === 0;
                return (
                  <div key={slide.id} className={styles.slide}>
                    {/* 1. Grande carte Showcase Orbix (scène visuelle des 3 téléphones) */}
                    <div className={styles.showcaseCard} role="region" aria-roledescription="carousel">
                      <div className={styles.cardMesh} aria-hidden="true" />

                      <div className={styles.phoneStage} data-testid={isFirst ? 'phones-stage' : undefined}>
                        <PhoneMockup
                          positionClass={styles.phoneLeft ?? ''}
                          testId={isFirst ? 'phone-mockup-left' : `phone-mockup-left-${index}`}
                          label={isFrench ? 'Téléphone gauche (aperçu)' : 'Left phone (preview)'}
                          iconName={slide.id === 'bikes' ? 'settings' : slide.id === 'winter' ? 'calendar' : slide.id === 'water' ? 'check' : 'users'}
                          slotTitle={
                            isFrench
                              ? slide.id === 'bikes'
                                ? 'Matériel révisé'
                                : slide.id === 'winter'
                                  ? 'Fixations réglées'
                                  : slide.id === 'water'
                                    ? 'Gilets & pagaies'
                                    : 'Contrôle EPI'
                              : slide.id === 'bikes'
                                ? 'Serviced Gear'
                                : slide.id === 'winter'
                                  ? 'Custom Bindings'
                                  : slide.id === 'water'
                                    ? 'Vests & Paddles'
                                    : 'PPE Checked'
                          }
                          isFrench={isFrench}
                        />
                        <PhoneMockup
                          positionClass={styles.phoneCenter ?? ''}
                          testId={isFirst ? 'phone-mockup-center' : `phone-mockup-center-${index}`}
                          label={isFrench ? 'Téléphone principal' : 'Main phone'}
                          iconName={slide.iconName}
                          slotTitle={isFrench ? slide.screenLabel.fr : slide.screenLabel.en}
                          isFrench={isFrench}
                        />
                        <PhoneMockup
                          positionClass={styles.phoneRight ?? ''}
                          testId={isFirst ? 'phone-mockup-right' : `phone-mockup-right-${index}`}
                          label={isFrench ? 'Téléphone droit (aperçu)' : 'Right phone (preview)'}
                          iconName={slide.id === 'winter' ? 'globe' : 'pin'}
                          slotTitle={
                            isFrench
                              ? slide.id === 'bikes'
                                ? 'Retrait sur place'
                                : slide.id === 'winter'
                                  ? 'Pied des pistes'
                                  : slide.id === 'water'
                                    ? 'Base nautique'
                                    : 'Départ immédiat'
                              : slide.id === 'bikes'
                                ? 'Local Pickup'
                                : slide.id === 'winter'
                                  ? 'Slopeside'
                                  : slide.id === 'water'
                                    ? 'Water Base'
                                    : 'Trailhead'
                          }
                          isFrench={isFrench}
                        />
                      </div>
                    </div>

                    {/* 2. Bloc d'information inférieur (Disposition exacte Orbix Studio) */}
                    <footer className={styles.infoCard}>
                      <div className={styles.infoTopRow}>
                        <div className={styles.infoTitleBlock}>
                          <div className={styles.tagWrap}>
                            <span className={styles.tagPipe} aria-hidden="true" />
                            <span className={styles.tagText}>
                              {isFrench ? slide.category.fr : slide.category.en}
                            </span>
                          </div>
                          <h3 className={styles.infoTitle}>
                            {isFrench ? slide.title.fr : slide.title.en}
                          </h3>
                        </div>

                        <div className={styles.statBlock}>
                          <span className={styles.statNumber}>{slide.statNumber}</span>
                          <span className={styles.statLabel}>
                            {isFrench ? slide.statLabel.fr : slide.statLabel.en}
                          </span>
                        </div>
                      </div>

                      <div className={styles.infoBottomRow}>
                        <p className={styles.infoDescription}>
                          {isFrench ? slide.description.fr : slide.description.en}
                        </p>

                        <Link
                          href={slide.actionHref}
                          className={styles.actionBtn}
                          onClick={(e) => {
                            if (hadDragged.current) {
                              e.preventDefault();
                            }
                          }}
                        >
                          <span>{isFrench ? slide.actionLabel.fr : slide.actionLabel.en}</span>
                          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M5 12h14" />
                            <path d="m12 5 7 7-7 7" />
                          </svg>
                        </Link>
                      </div>
                    </footer>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Indicateurs de pagination Orbix */}
          <div className={styles.paginationDots} role="tablist" aria-label="Navigation slides">
            {SHOWCASE_SLIDES.map((s, i) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={i === currentIndex}
                aria-label={`Slide ${i + 1} : ${isFrench ? s.tabLabel.fr : s.tabLabel.en}`}
                className={`${styles.dot} ${i === currentIndex ? styles.dotActive : ''}`}
                onClick={() => setCurrentIndex(i)}
              />
            ))}
          </div>
        </div>
      </ScrollReveal>
      </div>
    </section>
  );
}
