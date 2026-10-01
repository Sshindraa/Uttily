'use client';

import * as React from 'react';
import { Icon } from '@uttily/ui';
import { ScrollReveal } from '@/components/scroll-reveal';
import styles from './how-it-works-keynote.module.css';

export interface HowItWorksKeynoteProps {
  locale: 'fr' | 'en';
}

interface StepItem {
  id: string;
  number: string;
  title: { fr: string; en: string };
  description: { fr: string; en: string };
  screenBadge: { fr: string; en: string };
}

const STEPS: StepItem[] = [
  {
    id: 'spot',
    number: '01',
    title: {
      fr: 'Trouvez votre spot',
      en: 'Find your spot',
    },
    description: {
      fr: 'Retrait directement au pied des pistes ou en station.',
      en: 'Direct pickup at the foot of the slopes or in-resort.',
    },
    screenBadge: {
      fr: 'Station & Spot Locator',
      en: 'Resort & Spot Locator',
    },
  },
  {
    id: 'hold',
    number: '02',
    title: {
      fr: 'Bloquez l’exemplaire physique',
      en: 'Lock the physical item',
    },
    description: {
      fr: 'Hold garanti sans mauvaise surprise.',
      en: 'Guaranteed hold with zero surprises.',
    },
    screenBadge: {
      fr: 'Allocation Immédiate & Hold',
      en: 'Instant Allocation & Hold',
    },
  },
  {
    id: 'ride',
    number: '03',
    title: {
      fr: 'Partez rider',
      en: 'Hit the trails & slopes',
    },
    description: {
      fr: 'Matériel vérifié et réglé à votre profil.',
      en: 'Gear inspected and tuned to your rider profile.',
    },
    screenBadge: {
      fr: 'Contrôle Atelier Pro',
      en: 'Pro Workshop Calibration',
    },
  },
];

const STEP_DURATION_MS = 6000;
const TICK_INTERVAL_MS = 60;

export function HowItWorksKeynote({ locale }: HowItWorksKeynoteProps): React.ReactElement {
  const fr = locale === 'fr';
  const [activeStep, setActiveStep] = React.useState(0);
  const [progress, setProgress] = React.useState(0);
  const [isPaused, setIsPaused] = React.useState(false);

  // Auto-advance loop
  React.useEffect(() => {
    if (isPaused) return;

    const timer = setInterval(() => {
      setProgress((prev) => {
        const next = prev + (TICK_INTERVAL_MS / STEP_DURATION_MS) * 100;
        if (next >= 100) {
          setActiveStep((current) => (current + 1) % STEPS.length);
          return 0;
        }
        return next;
      });
    }, TICK_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [isPaused]);

  const handleStepSelect = (index: number): void => {
    setActiveStep(index);
    setProgress(0);
  };

  const handleKeyDown = (event: React.KeyboardEvent, currentIndex: number): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      const next = (currentIndex + 1) % STEPS.length;
      handleStepSelect(next);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const prev = (currentIndex - 1 + STEPS.length) % STEPS.length;
      handleStepSelect(prev);
    }
  };

  const currentStepData = STEPS[activeStep] ?? STEPS[0]!;

  return (
    <section className={styles.section} aria-labelledby="how-it-works-title">
      <ScrollReveal className={styles.header} delay={0} offset={16}>
        <div className={styles.eyebrow}>
          <span className={styles.eyebrowDot} aria-hidden="true" />
          <span>{fr ? 'Comment ça marche' : 'How it works'}</span>
        </div>
        <h2 id="how-it-works-title" className={styles.heading}>
          {fr ? 'Trois étapes clés,' : 'Three simple steps,'}{' '}
          <span className={styles.headingAccent}>
            {fr ? 'votre matériel prêt sur place.' : 'your gear ready on site.'}
          </span>
        </h2>
        <p className={styles.lead}>
          {fr
            ? 'Une réservation réelle portant sur un équipement physiquement alloué, vérifié par un pro avant votre arrivée.'
            : 'A genuine booking for a physically allocated item, verified and tuned by a local pro before you arrive.'}
        </p>
      </ScrollReveal>

      <div
        className={styles.stageGrid}
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
        onFocus={() => setIsPaused(true)}
        onBlur={() => setIsPaused(false)}
      >
        {/* Left: Interactive Keynote Step Switcher */}
        <div className={styles.stepList} role="tablist" aria-label={fr ? 'Étapes de réservation' : 'Booking steps'}>
          {STEPS.map((step, index) => {
            const isActive = index === activeStep;
            return (
              <button
                key={step.id}
                role="tab"
                id={`tab-${step.id}`}
                aria-selected={isActive}
                aria-controls={`panel-${step.id}`}
                tabIndex={isActive ? 0 : -1}
                className={`${styles.stepButton} ${isActive ? styles.stepButtonActive : ''}`}
                onClick={() => handleStepSelect(index)}
                onKeyDown={(e) => handleKeyDown(e, index)}
                type="button"
              >
                <div className={styles.stepHeader}>
                  <span className={styles.stepNumber}>{step.number}</span>
                  <span className={styles.stepTitle}>{step.title[locale]}</span>
                </div>
                <p className={styles.stepDescription}>{step.description[locale]}</p>

                {isActive ? (
                  <div className={styles.progressBar} aria-hidden="true">
                    <div className={styles.progressFill} style={{ width: `${progress}%` }} />
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>

        {/* Right: Keynote Stage Screen Viewport */}
        <div
          className={styles.stageScreen}
          role="tabpanel"
          id={`panel-${currentStepData.id}`}
          aria-labelledby={`tab-${currentStepData.id}`}
        >
          <div className={styles.screenGlow} aria-hidden="true" />

          {/* Top terminal bar */}
          <div className={styles.screenTopBar}>
            <div className={styles.screenWindowDots} aria-hidden="true">
              <span className={styles.windowDot} />
              <span className={styles.windowDot} />
              <span className={styles.windowDot} />
            </div>
            <div className={styles.screenLabel}>
              <span className={styles.screenPulse} aria-hidden="true" />
              <span>{currentStepData.screenBadge[locale]}</span>
            </div>
            <span className={styles.screenStepIndicator}>
              {currentStepData.number} / 03
            </span>
          </div>

          {/* Dynamic slide body */}
          <div className={styles.screenBody}>
            {activeStep === 0 && (
              <div className={styles.locatorCard}>
                <div className={styles.spotHeader}>
                  <h3 className={styles.spotTitle}>
                    {fr ? 'Chamonix-Mont-Blanc · Station Village' : 'Chamonix-Mont-Blanc · Resort Village'}
                  </h3>
                  <span className={styles.spotDistanceBadge}>
                    <Icon name="pin" size={14} />
                    <span>{fr ? 'À 50m des remontées' : '50m from ski lifts'}</span>
                  </span>
                </div>
                <div className={styles.spotInfoGrid}>
                  <div className={styles.spotInfoItem}>
                    <span className={styles.spotInfoLabel}>
                      {fr ? 'Atelier partenaire' : 'Partner workshop'}
                    </span>
                    <span className={styles.spotInfoValue}>
                      {fr ? 'Chamonix Pro Rental · Certifié Uttily' : 'Chamonix Pro Rental · Certified'}
                    </span>
                  </div>
                  <div className={styles.spotInfoItem}>
                    <span className={styles.spotInfoLabel}>
                      {fr ? 'Horaires de retrait' : 'Pickup hours'}
                    </span>
                    <span className={styles.spotInfoValue}>08:00 — 19:30</span>
                  </div>
                </div>
                <div className={styles.guaranteePills}>
                  <span className={styles.guaranteePill}>
                    <Icon name="check" size={14} />
                    <span>{fr ? 'Consigne sécurisée sur place' : 'Secure locker on site'}</span>
                  </span>
                  <span className={styles.guaranteePill}>
                    <Icon name="check" size={14} />
                    <span>{fr ? 'Accès direct pistes & sentiers' : 'Direct trail & slope access'}</span>
                  </span>
                </div>
              </div>
            )}

            {activeStep === 1 && (
              <div className={styles.holdCard}>
                <div className={styles.holdTop}>
                  <span className={styles.serialBadge}>
                    {fr ? 'Exemplaire physique alloué' : 'Allocated physical item'} #UT-8492
                  </span>
                  <span className={styles.spotDistanceBadge}>
                    <span className={styles.screenPulse} aria-hidden="true" />
                    <span>{fr ? 'Inventaire vérifié' : 'Inventory verified'}</span>
                  </span>
                </div>
                <div className={styles.chronoDisplay}>
                  <span className={styles.chronoTime}>14:59</span>
                  <div className={styles.chronoText}>
                    <strong>{fr ? 'Hold temporaire garanti.' : 'Guaranteed temporary hold.'}</strong>
                    <br />
                    <span>
                      {fr
                        ? 'Votre exemplaire est verrouillé 15 minutes sans débit immédiat.'
                        : 'Your item is locked for 15 minutes with no instant charge.'}
                    </span>
                  </div>
                </div>
                <div className={styles.guaranteePills}>
                  <span className={styles.guaranteePill}>
                    <Icon name="wallet" size={14} />
                    <span>{fr ? '0 € débité pendant le hold' : '€0 charged during hold'}</span>
                  </span>
                  <span className={styles.guaranteePill}>
                    <Icon name="check" size={14} />
                    <span>{fr ? 'Zéro risque de surbooking' : 'Zero overbooking risk'}</span>
                  </span>
                </div>
              </div>
            )}

            {activeStep === 2 && (
              <div className={styles.tuningCard}>
                <div className={styles.riderProfilePill}>
                  <span>
                    <strong>{fr ? 'Fiche atelier réglages' : 'Workshop setup profile'}</strong>
                  </span>
                  <span>{fr ? 'Taille 1m82 · Poids 74kg · Niveau Expert' : 'Height 1.82m · Weight 74kg · Expert'}</span>
                </div>
                <div className={styles.checklist}>
                  <div className={styles.checkItem}>
                    <span className={styles.checkIcon}>
                      <Icon name="check" size={12} />
                    </span>
                    <span>
                      {fr
                        ? 'Fixations et suspensions étalonnées selon vos paramètres'
                        : 'Bindings and suspension calibrated to your specs'}
                    </span>
                  </div>
                  <div className={styles.checkItem}>
                    <span className={styles.checkIcon}>
                      <Icon name="check" size={12} />
                    </span>
                    <span>
                      {fr
                        ? 'Sélection de taille vérifiée (Cadre M / Longueur 174cm)'
                        : 'Size selection verified (Frame M / Length 174cm)'}
                    </span>
                  </div>
                  <div className={styles.checkItem}>
                    <span className={styles.checkIcon}>
                      <Icon name="check" size={12} />
                    </span>
                    <span>
                      {fr
                        ? 'Contrôle sécurité 12 points validé avant remise en main propre'
                        : '12-point safety inspection cleared before handoff'}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Screen footer */}
          <div className={styles.screenFooter}>
            <span>{fr ? 'Garantie d’engagement Uttily' : 'Uttily standard guarantee'}</span>
            <span>{fr ? 'Prêt à l’usage dès l’arrivée' : 'Ready to use on arrival'}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
