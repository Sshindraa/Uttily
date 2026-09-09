'use client';

import { useState, type ReactElement } from 'react';
import type { PhotoQualityAssessment, DetectedEquipmentFeatures } from '@uttily/contracts';
import styles from './PhotoCoachAiFeedback.module.css';

export interface PhotoCoachAiFeedbackProps {
  assessment: PhotoQualityAssessment;
  locale?: 'fr' | 'en';
  onConfirm: (confirmedFeatures: Partial<DetectedEquipmentFeatures>) => void;
  onRetake: () => void;
  isSaving?: boolean;
}

export function PhotoCoachAiFeedback({
  assessment,
  locale = 'fr',
  onConfirm,
  onRetake,
  isSaving = false,
}: PhotoCoachAiFeedbackProps): ReactElement {
  const fr = locale === 'fr';
  const { verdict, quality, detectedFeatures, issuesFr, issuesEn, suggestionsFr, suggestionsEn } =
    assessment;

  // Caractéristiques éditables / confirmables par le loueur
  const [confirmedFeatures, setConfirmedFeatures] = useState<{
    isElectric: boolean;
    hasLuggageRack: boolean;
    hasTrailerHitch: boolean;
    hasChildSeatCompatibleMount: boolean;
  }>({
    isElectric: detectedFeatures.isElectric,
    hasLuggageRack: detectedFeatures.hasLuggageRack,
    hasTrailerHitch: detectedFeatures.hasTrailerHitch,
    hasChildSeatCompatibleMount: detectedFeatures.hasChildSeatCompatibleMount,
  });

  const [overrideVlmVeto, setOverrideVlmVeto] = useState(false);

  const toggleFeature = (key: keyof typeof confirmedFeatures) => {
    setConfirmedFeatures((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const isRejected = verdict === 'REJECTED';
  const showFeatures = !isRejected || overrideVlmVeto;

  const getScoreColorClass = (score: number) => {
    if (score >= 70) return styles.fillGreen;
    if (score >= 45) return styles.fillAmber;
    return styles.fillRed;
  };

  return (
    <div className={styles.container}>
      {/* 1. Bannière de Verdict */}
      <div
        className={`${styles.verdictBanner} ${
          verdict === 'CONFORMANT'
            ? styles.verdictConformant
            : verdict === 'WARNING'
              ? styles.verdictWarning
              : styles.verdictRejected
        }`}
      >
        <span>{verdict === 'CONFORMANT' ? '✓' : verdict === 'WARNING' ? '⚠️' : '✕'}</span>
        <span>
          {verdict === 'CONFORMANT'
            ? fr
              ? 'Photo conforme aux standards professionnels'
              : 'Photo meets professional standards'
            : verdict === 'WARNING'
              ? fr
                ? 'Photo exploitable avec points d’amélioration conseillés'
                : 'Usable photo with advised improvements'
              : fr
                ? 'Photo déconseillée par le coach (standards non atteints)'
                : 'Photo advised against by coach (standards not met)'}
        </span>
      </div>

      {/* Bannière de dérogation loueur (ADR-042) */}
      {isRejected && overrideVlmVeto && (
        <div className={styles.overrideBanner} role="note">
          {fr
            ? '⚠️ Dérogation loueur activée : vous choisissez d’utiliser cette photo malgré l’avis du coach. En cochant les caractéristiques ci-dessous, vous attestez leur présence sous votre responsabilité professionnelle (niveau HUMAN_CONFIRMED).'
            : '⚠️ Merchant override enabled: you choose to use this photo despite coach feedback. By checking items below, you attest their presence under your responsibility (HUMAN_CONFIRMED level).'}
        </div>
      )}

      {/* 2. Jauges Techniques */}
      <div className={styles.metricsGrid}>
        <div className={styles.metricCard}>
          <div className={styles.metricHeader}>
            <span>{fr ? 'Netteté' : 'Sharpness'}</span>
            <span className={styles.metricScore}>{quality.sharpnessScore}/100</span>
          </div>
          <div className={styles.progressBarBg}>
            <div
              className={`${styles.progressBarFill} ${getScoreColorClass(quality.sharpnessScore)}`}
              style={{ width: `${quality.sharpnessScore}%` }}
            />
          </div>
        </div>

        <div className={styles.metricCard}>
          <div className={styles.metricHeader}>
            <span>{fr ? 'Cadrage' : 'Framing'}</span>
            <span className={styles.metricScore}>{quality.framingScore}/100</span>
          </div>
          <div className={styles.progressBarBg}>
            <div
              className={`${styles.progressBarFill} ${getScoreColorClass(quality.framingScore)}`}
              style={{ width: `${quality.framingScore}%` }}
            />
          </div>
        </div>

        <div className={styles.metricCard}>
          <div className={styles.metricHeader}>
            <span>{fr ? 'Éclairage' : 'Lighting'}</span>
            <span className={styles.metricScore}>{quality.exposureScore}/100</span>
          </div>
          <div className={styles.progressBarBg}>
            <div
              className={`${styles.progressBarFill} ${getScoreColorClass(quality.exposureScore)}`}
              style={{ width: `${quality.exposureScore}%` }}
            />
          </div>
        </div>

        <div className={styles.metricCard}>
          <div className={styles.metricHeader}>
            <span>{fr ? 'Arrière-plan' : 'Background'}</span>
            <span className={styles.metricScore}>{quality.backgroundNeutralityScore}/100</span>
          </div>
          <div className={styles.progressBarBg}>
            <div
              className={`${styles.progressBarFill} ${getScoreColorClass(
                quality.backgroundNeutralityScore,
              )}`}
              style={{ width: `${quality.backgroundNeutralityScore}%` }}
            />
          </div>
        </div>
      </div>

      {/* 3. Recommandations & Conseils */}
      {((fr ? issuesFr : issuesEn).length > 0 ||
        (fr ? suggestionsFr : suggestionsEn).length > 0) && (
        <div className={styles.sectionBox}>
          <h4 className={styles.sectionTitle}>
            {isRejected
              ? fr
                ? 'Points d’attention soulevés par l’analyse :'
                : 'Issues raised by visual analysis:'
              : fr
                ? 'Conseils atelier :'
                : 'Workshop tips:'}
          </h4>
          <ul className={styles.suggestionsList}>
            {[...(fr ? issuesFr : issuesEn), ...(fr ? suggestionsFr : suggestionsEn)].map(
              (tip, i) => (
                <li key={i}>{tip}</li>
              ),
            )}
          </ul>
        </div>
      )}

      {/* 4. Caractéristiques d'Équipement pour le PackSolver (ADR-042) */}
      {showFeatures && (
        <div className={styles.sectionBox}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h4 className={styles.sectionTitle}>
              {fr
                ? 'Équipements détectés (confirmation humaine requise) :'
                : 'Detected gear features (human confirmation required):'}
            </h4>
            <span className={styles.evidenceBadge}>
              {fr ? 'Observation IA → Confirmé par vous' : 'AI Observed → Verified by you'}
            </span>
          </div>
          <div className={styles.featuresGrid}>
            <label
              className={`${styles.featureTag} ${
                confirmedFeatures.isElectric ? styles.featureTagActive : ''
              }`}
            >
              <input
                type="checkbox"
                checked={confirmedFeatures.isElectric}
                onChange={() => toggleFeature('isElectric')}
              />
              ⚡ {fr ? 'Assistance électrique (VAE)' : 'E-Bike motor'}
            </label>

            <label
              className={`${styles.featureTag} ${
                confirmedFeatures.hasLuggageRack ? styles.featureTagActive : ''
              }`}
            >
              <input
                type="checkbox"
                checked={confirmedFeatures.hasLuggageRack}
                onChange={() => toggleFeature('hasLuggageRack')}
              />
              🎒 {fr ? 'Porte-bagages arrière' : 'Rear luggage rack'}
            </label>

            <label
              className={`${styles.featureTag} ${
                confirmedFeatures.hasChildSeatCompatibleMount ? styles.featureTagActive : ''
              }`}
            >
              <input
                type="checkbox"
                checked={confirmedFeatures.hasChildSeatCompatibleMount}
                onChange={() => toggleFeature('hasChildSeatCompatibleMount')}
              />
              👶 {fr ? 'Compatible siège enfant' : 'Child seat mount'}
            </label>

            <label
              className={`${styles.featureTag} ${
                confirmedFeatures.hasTrailerHitch ? styles.featureTagActive : ''
              }`}
            >
              <input
                type="checkbox"
                checked={confirmedFeatures.hasTrailerHitch}
                onChange={() => toggleFeature('hasTrailerHitch')}
              />
              🚜 {fr ? 'Attelage remorque' : 'Trailer hitch'}
            </label>

            {detectedFeatures.visibleSizeLabel && (
              <span className={`${styles.featureTag} ${styles.featureTagActive}`}>
                📏{' '}
                {fr
                  ? `Taille cadre : ${detectedFeatures.visibleSizeLabel}`
                  : `Size: ${detectedFeatures.visibleSizeLabel}`}
              </span>
            )}
          </div>
        </div>
      )}

      {/* 5. Actions (Garde-fous ADR-042 : Pas de veto absolu pour le VLM) */}
      <div className={styles.actionsRow}>
        {isRejected && !overrideVlmVeto ? (
          <>
            <button type="button" onClick={onRetake} className={styles.primaryAction}>
              {fr ? 'Reprendre la photo 📷' : 'Retake photo 📷'}
            </button>
            <button
              type="button"
              onClick={() => setOverrideVlmVeto(true)}
              className={styles.overrideAction}
            >
              {fr ? 'Continuer malgré tout avec cette photo' : 'Continue anyway with this photo'}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onConfirm(confirmedFeatures)}
              disabled={isSaving}
              className={styles.primaryAction}
            >
              {isSaving
                ? fr
                  ? 'Enregistrement…'
                  : 'Saving…'
                : fr
                  ? 'Valider et enrichir le catalogue →'
                  : 'Confirm and enrich catalog →'}
            </button>
            <button
              type="button"
              onClick={onRetake}
              disabled={isSaving}
              className={styles.secondaryAction}
            >
              {fr ? 'Reprendre' : 'Retake'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
