'use client';

import { type ChangeEvent, type ReactElement, useRef, useState } from 'react';
import { BIKE_PHOTO_SLOTS, type PhotoSlotType } from '@uttily/contracts';
import { PhotoCoachModal } from '@/components/photo-coach';
import { DEMO_PHOTO_COACH_ORG_ID } from '@/lib/photo-coach-constants';
import type { ProductPhotoSummary } from '@uttily/core';
import styles from './page.module.css';

interface StepDefinition {
  type: PhotoSlotType;
  stepNum: number;
  title: string;
  meta: string;
  isOptional: boolean;
  headline: string;
  tips: string[];
}

const STEP_DEFINITIONS: StepDefinition[] = [
  {
    type: 'HERO_PROFILE',
    stepNum: 1,
    title: 'Vue de profil',
    meta: 'Étape 1 · Requise',
    isOptional: false,
    headline: 'Vélo entier, bien centré, sur un fond dégagé.',
    tips: [
      'Cadrez le vélo en entier sans couper les roues',
      'Placez-vous à hauteur du cadre',
      'Gardez un fond simple et dégagé',
      'Évitez le contre-jour',
    ],
  },
  {
    type: 'THREE_QUARTER_FRONT',
    stepNum: 2,
    title: 'Vue 3/4 avant',
    meta: 'Étape 2 · Requise',
    isOptional: false,
    headline: 'Montrez le volume et le poste de pilotage.',
    tips: [
      'Placez-vous à 45° à l’avant du vélo',
      'Montrez le volume et le poste de pilotage',
      'Tournez légèrement le guidon vers vous',
      'Hauteur naturelle d’homme',
    ],
  },
  {
    type: 'SECONDARY_VIEW',
    stepNum: 3,
    title: 'Vue libre',
    meta: 'Étape 3 · Optionnelle',
    isOptional: true,
    headline: 'Ajoutez un détail utile ou valorisant.',
    tips: [
      'Choisissez un atout clé (cockpit, écran VAE, panier, selle)',
      'Rapprochez-vous pour un cadrage net',
      'Évitez les reflets sur les afficheurs',
      'Prise de vue soignée et contrastée',
    ],
  },
];

function VisualGuide({
  slotType,
  isDone,
}: {
  slotType: PhotoSlotType;
  isDone?: boolean;
}): ReactElement {
  switch (slotType) {
    case 'HERO_PROFILE':
      return (
        <svg
          viewBox="0 0 320 180"
          className={styles.visualSvg}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* Cadre de visée sobre & repères de marge */}
          <rect
            x="20"
            y="20"
            width="280"
            height="140"
            rx="6"
            stroke="rgba(255, 255, 255, 0.12)"
            strokeDasharray="4 6"
            strokeWidth="1"
          />
          <g stroke="rgba(255, 255, 255, 0.4)" strokeWidth="1.5">
            <path d="M20 32 V20 H32" />
            <path d="M300 32 V20 H288" />
            <path d="M20 148 V160 H32" />
            <path d="M300 148 V160 H288" />
          </g>

          {/* Ligne de sol propre */}
          <line
            x1="30"
            y1="146"
            x2="290"
            y2="146"
            stroke="rgba(255, 255, 255, 0.2)"
            strokeWidth="1"
            strokeDasharray="4 6"
          />

          {/* Centreur optique discret */}
          <line x1="160" y1="28" x2="160" y2="38" stroke="rgba(255, 255, 255, 0.2)" />
          <line x1="160" y1="142" x2="160" y2="152" stroke="rgba(255, 255, 255, 0.2)" />

          {/* Vélo de profil complet : proportions nettes */}
          <g stroke={isDone ? '#10b981' : '#f3f4f6'} strokeWidth="2.2" opacity="0.95">
            {/* Roue arrière */}
            <circle cx="86" cy="118" r="28" />
            <circle cx="86" cy="118" r="23" strokeWidth="1" strokeDasharray="2 3" opacity="0.5" />
            <circle cx="86" cy="118" r="3" fill="currentColor" />

            {/* Roue avant */}
            <circle cx="234" cy="118" r="28" />
            <circle cx="234" cy="118" r="23" strokeWidth="1" strokeDasharray="2 3" opacity="0.5" />
            <circle cx="234" cy="118" r="3" fill="currentColor" />

            {/* Cadre principal */}
            <line x1="86" y1="118" x2="155" y2="118" />
            <line x1="86" y1="118" x2="140" y2="72" />
            <line x1="155" y1="118" x2="140" y2="72" />
            <line x1="155" y1="118" x2="210" y2="68" />
            <line x1="140" y1="72" x2="210" y2="68" />
            <line x1="210" y1="68" x2="234" y2="118" />

            {/* Selle */}
            <line x1="140" y1="72" x2="138" y2="58" strokeWidth="2.5" />
            <path d="M125 58 H151" strokeWidth="3" />

            {/* Poste de pilotage & cintre */}
            <path d="M210 68 L213 50 Q215 42 225 45" strokeWidth="3" />

            {/* Pédalier transmission */}
            <circle cx="155" cy="118" r="8" strokeWidth="1.8" />
          </g>
        </svg>
      );

    case 'THREE_QUARTER_FRONT':
      return (
        <svg
          viewBox="0 0 320 180"
          className={styles.visualSvg}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* Cadre de visée */}
          <rect
            x="20"
            y="20"
            width="280"
            height="140"
            rx="6"
            stroke="rgba(255, 255, 255, 0.12)"
            strokeDasharray="4 6"
            strokeWidth="1"
          />
          <g stroke="rgba(255, 255, 255, 0.4)" strokeWidth="1.5">
            <path d="M20 32 V20 H32" />
            <path d="M300 32 V20 H288" />
            <path d="M20 148 V160 H32" />
            <path d="M300 148 V160 H288" />
          </g>

          {/* Repère d'angle 45° sobre */}
          <text
            x="290"
            y="38"
            textAnchor="end"
            fontSize="10"
            fill="rgba(255, 255, 255, 0.4)"
            fontWeight="500"
          >
            45°
          </text>

          {/* Perspective 3/4 avant */}
          <g stroke={isDone ? '#10b981' : '#f3f4f6'} strokeWidth="2.2" opacity="0.95">
            {/* Roue avant proéminente au premier plan */}
            <ellipse
              cx="224"
              cy="118"
              rx="22"
              ry="32"
              transform="rotate(-12 224 118)"
              strokeWidth="2.6"
            />
            <circle cx="224" cy="118" r="3" fill="currentColor" />

            {/* Roue arrière en retrait */}
            <ellipse
              cx="98"
              cy="104"
              rx="15"
              ry="22"
              transform="rotate(-6 98 104)"
              strokeWidth="1.8"
              opacity="0.75"
            />

            {/* Lignes du cadre en fuite */}
            <line x1="98" y1="104" x2="152" y2="114" strokeWidth="1.8" />
            <line x1="98" y1="104" x2="138" y2="78" strokeWidth="1.8" />
            <line x1="152" y1="114" x2="138" y2="78" strokeWidth="2" />
            <line x1="152" y1="114" x2="204" y2="70" strokeWidth="2.4" />
            <line x1="138" y1="78" x2="204" y2="70" strokeWidth="2.2" />
            <line x1="204" y1="70" x2="224" y2="118" strokeWidth="2.8" />

            {/* Selle */}
            <line x1="138" y1="78" x2="136" y2="65" strokeWidth="2.2" />
            <path d="M124 65 H146" strokeWidth="2.6" opacity="0.8" />

            {/* Cintre large orienté vers le photographe */}
            <line x1="204" y1="70" x2="206" y2="52" strokeWidth="3" />
            <path d="M182 53 L206 52 L234 49" strokeWidth="3.2" />
            <path d="M182 53 L180 58 M234 49 L236 54" strokeWidth="2.6" />
          </g>
        </svg>
      );

    case 'SECONDARY_VIEW':
    default:
      return (
        <svg
          viewBox="0 0 320 180"
          className={styles.visualSvg}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* Cadre de visée */}
          <rect
            x="20"
            y="20"
            width="280"
            height="140"
            rx="6"
            stroke="rgba(255, 255, 255, 0.12)"
            strokeDasharray="4 6"
            strokeWidth="1"
          />
          <g stroke="rgba(255, 255, 255, 0.4)" strokeWidth="1.5">
            <path d="M20 32 V20 H32" />
            <path d="M300 32 V20 H288" />
            <path d="M20 148 V160 H32" />
            <path d="M300 148 V160 H288" />
          </g>

          {/* Réticule de focus macro / détail signature */}
          <g stroke={isDone ? '#10b981' : '#f3f4f6'}>
            <circle cx="160" cy="88" r="42" strokeDasharray="4 4" strokeWidth="1.2" opacity="0.4" />
            <circle cx="160" cy="88" r="32" strokeWidth="2" opacity="0.8" />
            <circle cx="160" cy="88" r="4" fill="currentColor" />

            <line x1="160" y1="40" x2="160" y2="50" strokeWidth="2" />
            <line x1="160" y1="126" x2="160" y2="136" strokeWidth="2" />
            <line x1="112" y1="88" x2="122" y2="88" strokeWidth="2" />
            <line x1="198" y1="88" x2="208" y2="88" strokeWidth="2" />

            {/* Pictogramme composant clé */}
            <rect x="146" y="74" width="28" height="20" rx="3" strokeWidth="1.8" opacity="0.8" />
            <line x1="138" y1="102" x2="182" y2="102" strokeWidth="2" opacity="0.7" />
          </g>
        </svg>
      );
  }
}

function SmallThumbnail({ slotType }: { slotType: PhotoSlotType }): ReactElement {
  switch (slotType) {
    case 'THREE_QUARTER_FRONT':
      return (
        <svg viewBox="0 0 50 34" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="1.5">
          <ellipse cx="34" cy="22" rx="6" ry="9" transform="rotate(-10 34 22)" />
          <ellipse cx="14" cy="19" rx="4" ry="7" opacity="0.6" />
          <path d="M14 19 L24 21 L34 22 M24 21 L30 13 L34 22" />
        </svg>
      );
    case 'SECONDARY_VIEW':
    default:
      return (
        <svg viewBox="0 0 50 34" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="25" cy="17" r="8" strokeDasharray="2 2" opacity="0.5" />
          <circle cx="25" cy="17" r="4.5" />
          <line x1="25" y1="5" x2="25" y2="9" />
          <line x1="25" y1="25" x2="25" y2="29" />
        </svg>
      );
  }
}

export default function PhotoCoachDemoPage(): ReactElement {
  const [selectedSlot, setSelectedSlot] = useState<PhotoSlotType>('HERO_PROFILE');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [mockPhotos, setMockPhotos] = useState<ProductPhotoSummary[]>([]);
  const [showDevTools, setShowDevTools] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const hasHeroProfile = mockPhotos.some(
    (p) => p.slotType === 'HERO_PROFILE' || p.slotType === 'FULL_BIKE',
  );
  const hasThreeQuarter = mockPhotos.some(
    (p) =>
      p.slotType === 'THREE_QUARTER_FRONT' ||
      p.slotType === 'THREE_QUARTER' ||
      p.slotType === 'DRIVETRAIN',
  );
  const hasSecondaryView = mockPhotos.some(
    (p) =>
      p.slotType === 'SECONDARY_VIEW' ||
      p.slotType === 'SIGNATURE_DETAIL' ||
      p.slotType === 'BRAKES_TIRES',
  );

  const requiredCount = (hasHeroProfile ? 1 : 0) + (hasThreeQuarter ? 1 : 0);

  const nextSuggestedSlot: PhotoSlotType = !hasHeroProfile
    ? 'HERO_PROFILE'
    : !hasThreeQuarter
      ? 'THREE_QUARTER_FRONT'
      : !hasSecondaryView
        ? 'SECONDARY_VIEW'
        : 'HERO_PROFILE';

  const activeStep = STEP_DEFINITIONS.find((s) => s.type === selectedSlot) ?? STEP_DEFINITIONS[0]!;
  const upcomingSteps = STEP_DEFINITIONS.filter((s) => s.type !== selectedSlot);
  const isCurrentSlotDone = mockPhotos.some((p) => p.slotType === selectedSlot);

  const handleOpenCoach = () => {
    setIsModalOpen(true);
  };

  const handlePhotoUploaded = (photo: ProductPhotoSummary) => {
    setMockPhotos((prev) => [photo, ...prev.filter((p) => p.slotType !== photo.slotType)]);
  };

  const handleAdvanceToNext = () => {
    setSelectedSlot(nextSuggestedSlot);
  };

  const handleExistingPhotoClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const fakePhoto: ProductPhotoSummary = {
        id: crypto.randomUUID(),
        publicId: `pub-${crypto.randomUUID()}`,
        slotType: selectedSlot,
        fileState: 'AVAILABLE',
        contentType: file.type || 'image/jpeg',
        byteSize: file.size,
        widthPx: 1920,
        heightPx: 1080,
        sortOrder: mockPhotos.length,
        rejectionReason: null,
      };
      handlePhotoUploaded(fakePhoto);
    }
  };

  // Simulation dev sans polluer le design produit
  const handleSimulateActiveSlot = () => {
    const fakePhoto: ProductPhotoSummary = {
      id: crypto.randomUUID(),
      publicId: `pub-${crypto.randomUUID()}`,
      slotType: selectedSlot,
      fileState: 'AVAILABLE',
      contentType: 'image/jpeg',
      byteSize: 245100,
      widthPx: 1920,
      heightPx: 1080,
      sortOrder: mockPhotos.length,
      rejectionReason: null,
    };
    handlePhotoUploaded(fakePhoto);
  };

  return (
    <main className={styles.container}>
      <div className={styles.wrapper}>
        {/* 1. En-tête sobre & éditorial */}
        <header className={styles.header}>
          <span className={styles.overline}>Prise de vue guidée</span>
          <h1 className={styles.title}>Photographiez votre vélo en quelques étapes</h1>
          <p className={styles.subtitle}>
            2 vues requises, 1 vue libre optionnelle. Uttily vous guide pour obtenir des photos
            claires et cohérentes.
          </p>
        </header>

        {/* 2. Barre de progression compacte avec accent vert discret */}
        <section className={styles.progressSection} aria-label="Progression de la prise de vue">
          <div className={styles.progressHeader}>
            <span className={styles.stepCounter}>
              <span className={styles.counterDot} />
              Étape {activeStep.stepNum} sur 3
            </span>
            <span className={styles.requiredCounter}>
              {requiredCount} sur 2 vues requises validées
            </span>
          </div>
          <div className={styles.stepperSegments}>
            <div
              className={`${styles.segment} ${
                hasHeroProfile
                  ? styles.segmentDone
                  : selectedSlot === 'HERO_PROFILE'
                    ? styles.segmentActive
                    : ''
              }`}
            />
            <div
              className={`${styles.segment} ${
                hasThreeQuarter
                  ? styles.segmentDone
                  : selectedSlot === 'THREE_QUARTER_FRONT'
                    ? styles.segmentActive
                    : ''
              }`}
            />
            <div
              className={`${styles.segment} ${
                hasSecondaryView
                  ? styles.segmentDone
                  : selectedSlot === 'SECONDARY_VIEW'
                    ? styles.segmentActive
                    : ''
              }`}
            />
          </div>
        </section>

        {/* 3. Une seule grande carte active */}
        <section className={styles.activeCard} aria-labelledby="active-step-title">
          <div className={styles.cardTopHeader}>
            <div className={styles.stepMetaRow}>
              <span className={styles.activeDot} />
              <span className={styles.stepMeta}>{activeStep.meta}</span>
            </div>
            <h2 id="active-step-title" className={styles.stepTitle}>
              {activeStep.title}
            </h2>
            <p className={styles.stepDescription}>{activeStep.headline}</p>
          </div>

          {!isCurrentSlotDone ? (
            /* État normal de cadrage */
            <div className={styles.cardBodyGrid}>
              <div className={styles.visualFrameContainer}>
                <VisualGuide slotType={selectedSlot} isDone={false} />
              </div>

              <div className={styles.instructionsColumn}>
                <div className={styles.tipsBlock}>
                  <h3 className={styles.tipsHeading}>Pour réussir cette photo</h3>
                  <ul className={styles.tipsList}>
                    {activeStep.tips.map((tip, idx) => (
                      <li key={idx} className={styles.tipItem}>
                        <span className={styles.tipCheck}>✓</span>
                        <span>{tip}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className={styles.actionsBlock}>
                  <button
                    type="button"
                    className={styles.primaryCtaBtn}
                    onClick={handleOpenCoach}
                  >
                    Prendre cette photo
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryCtaBtn}
                    onClick={handleExistingPhotoClick}
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    <span>Utiliser une photo existante</span>
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* État après prise de photo validée */
            <div className={styles.validatedStateContent}>
              <div className={styles.validatedBanner}>
                <span>✓ Photo validée</span>
              </div>

              <div className={styles.validatedGrid}>
                <div className={styles.visualFrameContainer}>
                  <VisualGuide slotType={selectedSlot} isDone={true} />
                </div>

                <div className={styles.instructionsColumn}>
                  <div className={styles.criteriaSummary}>
                    <div className={styles.criteriaRow}>
                      <span className={styles.criteriaLabel}>Netteté</span>
                      <span className={styles.criteriaValue}>Bonne ✓</span>
                    </div>
                    <div className={styles.criteriaRow}>
                      <span className={styles.criteriaLabel}>Cadrage</span>
                      <span className={styles.criteriaValue}>Bon ✓</span>
                    </div>
                    <div className={styles.criteriaRow}>
                      <span className={styles.criteriaLabel}>Éclairage</span>
                      <span className={styles.criteriaValue}>Bon ✓</span>
                    </div>
                  </div>

                  <p className={styles.reassuringNote}>
                    Le vélo est entièrement visible et correctement cadré.
                  </p>

                  <div className={styles.actionsBlock}>
                    {requiredCount < 2 || !hasSecondaryView ? (
                      <button
                        type="button"
                        className={styles.primaryCtaBtn}
                        onClick={handleAdvanceToNext}
                      >
                        Continuer vers la {BIKE_PHOTO_SLOTS[nextSuggestedSlot].title} →
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={styles.primaryCtaBtn}
                        onClick={() => setSelectedSlot('HERO_PROFILE')}
                      >
                        Toutes les photos validées ✓
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.secondaryCtaBtn}
                      onClick={handleOpenCoach}
                    >
                      Reprendre cette photo
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* 4. Étapes suivantes (Rows compactes sans répétition) */}
        {upcomingSteps.length > 0 && (
          <section className={styles.upcomingSection} aria-label="Étapes suivantes">
            <h3 className={styles.upcomingTitle}>Étapes suivantes</h3>
            <div className={styles.upcomingListCard}>
              {upcomingSteps.map((step) => {
                const isStepDone = mockPhotos.some((p) => p.slotType === step.type);

                return (
                  <button
                    key={step.type}
                    type="button"
                    className={styles.upcomingRow}
                    onClick={() => setSelectedSlot(step.type)}
                  >
                    <div className={styles.upcomingRowLeft}>
                      <div className={styles.rowThumbnail}>
                        <SmallThumbnail slotType={step.type} />
                      </div>
                      <div className={styles.rowText}>
                        <span className={styles.rowTitle}>{step.title}</span>
                        <span className={styles.rowSubtitle}>{step.headline}</span>
                      </div>
                    </div>

                    <div className={styles.upcomingRowRight}>
                      {isStepDone ? (
                        <span className={styles.rowDoneBadge}>✓ Validée</span>
                      ) : step.isOptional ? (
                        <span className={styles.optionalTag}>Optionnelle</span>
                      ) : (
                        <span className={styles.requiredTag}>Requise</span>
                      )}
                      <span className={styles.chevron} aria-hidden="true">
                        ›
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Input discret pour photo existante */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />

        {/* Outils développeur discrets en footer */}
        <footer className={styles.devFooter}>
          <span>Uttily Assistant de Capture · Standard Visuel Pro</span>
          <button
            type="button"
            className={styles.devToggleBtn}
            onClick={() => setShowDevTools((prev) => !prev)}
          >
            {showDevTools ? 'Masquer outils dev' : 'Outils dev'}
          </button>
        </footer>

        {showDevTools && (
          <div className={styles.devToolbar}>
            <button
              type="button"
              className={styles.devActionBtn}
              onClick={handleSimulateActiveSlot}
            >
              ⚡ Simuler validation ({activeStep.title})
            </button>
            {mockPhotos.length > 0 && (
              <button
                type="button"
                className={styles.devActionBtn}
                onClick={() => {
                  setMockPhotos([]);
                  setSelectedSlot('HERO_PROFILE');
                }}
              >
                ↺ Vider les photos
              </button>
            )}
          </div>
        )}
      </div>

      {/* Modal Photo Coach enclenchée par "Prendre cette photo" */}
      <PhotoCoachModal
        orgId={DEMO_PHOTO_COACH_ORG_ID}
        productId="b5555acf-3f6a-4474-aa18-4d107993abbb"
        slotType={selectedSlot}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onPhotoUploaded={handlePhotoUploaded}
      />
    </main>
  );
}
