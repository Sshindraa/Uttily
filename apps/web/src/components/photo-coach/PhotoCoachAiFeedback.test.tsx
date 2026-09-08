import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PhotoQualityAssessment } from '@uttily/contracts';
import { PhotoCoachAiFeedback } from './PhotoCoachAiFeedback';

describe('PhotoCoachAiFeedback Component', () => {
  const conformantAssessment: PhotoQualityAssessment = {
    verdict: 'CONFORMANT',
    matchedSlot: 'HERO_PROFILE',
    slotConformity: true,
    quality: {
      sharpnessScore: 92,
      exposureScore: 88,
      framingScore: 95,
      backgroundNeutralityScore: 85,
    },
    detectedFeatures: {
      isElectric: true,
      hasLuggageRack: true,
      hasTrailerHitch: false,
      hasChildSeatCompatibleMount: true,
      drivetrainType: 'DERAILLEUR',
      brakeType: 'HYDRAULIC_DISC',
      frameType: 'STEP_THROUGH',
      visibleSizeLabel: 'M',
      confidence: 0.95,
    },
    issuesFr: [],
    issuesEn: [],
    suggestionsFr: ['Angle et éclairage parfaits pour la marketplace.'],
    suggestionsEn: ['Perfect angle and lighting for the marketplace.'],
  };

  const warningAssessment: PhotoQualityAssessment = {
    verdict: 'WARNING',
    matchedSlot: 'HERO_PROFILE',
    slotConformity: true,
    quality: {
      sharpnessScore: 68,
      exposureScore: 55,
      framingScore: 72,
      backgroundNeutralityScore: 40,
    },
    detectedFeatures: {
      isElectric: true,
      hasLuggageRack: false,
      hasTrailerHitch: false,
      hasChildSeatCompatibleMount: false,
      drivetrainType: 'HUB_INTERNAL',
      brakeType: 'MECHANICAL_DISC',
      frameType: 'DIAMOND',
      confidence: 0.82,
    },
    issuesFr: ['Arrière-plan encombré par des cartons atelier.'],
    issuesEn: ['Background cluttered with workshop boxes.'],
    suggestionsFr: ['Placez le vélo devant un mur uni ou une bâche blanche pour un rendu optimal.'],
    suggestionsEn: ['Place the bike against a plain wall for best results.'],
  };

  const rejectedAssessment: PhotoQualityAssessment = {
    verdict: 'REJECTED',
    matchedSlot: 'HERO_PROFILE',
    slotConformity: false,
    quality: {
      sharpnessScore: 25,
      exposureScore: 30,
      framingScore: 20,
      backgroundNeutralityScore: 15,
    },
    detectedFeatures: {
      isElectric: false,
      hasLuggageRack: false,
      hasTrailerHitch: false,
      hasChildSeatCompatibleMount: false,
      drivetrainType: 'UNKNOWN',
      brakeType: 'UNKNOWN',
      frameType: 'UNKNOWN',
      confidence: 0.2,
    },
    issuesFr: [
      'Image très floue (bougé appareil ou optique sale).',
      'Roues coupées au cadrage.',
    ],
    issuesEn: ['Very blurry image.', 'Wheels cropped out of frame.'],
    suggestionsFr: ['Nettoyez l’objectif de votre smartphone et reculez de 1 mètre.'],
    suggestionsEn: ['Clean your smartphone lens and step back 1 meter.'],
  };

  it('rend un verdict CONFORMANT avec les jauges, caractéristiques et bouton de confirmation', () => {
    const html = renderToStaticMarkup(
      <PhotoCoachAiFeedback
        assessment={conformantAssessment}
        onConfirm={() => {}}
        onRetake={() => {}}
      />,
    );

    expect(html).toContain('Photo conforme aux standards professionnels');
    expect(html).toContain('92/100');
    expect(html).toContain('95/100');
    expect(html).toContain('88/100');
    expect(html).toContain('85/100');
    expect(html).toContain('Assistance électrique (VAE)');
    expect(html).toContain('Porte-bagages arrière');
    expect(html).toContain('Compatible siège enfant');
    expect(html).toContain('Taille cadre : M');
    expect(html).toContain('Valider et enrichir le catalogue →');
    expect(html).toContain('Reprendre');
  });

  it('rend un verdict WARNING avec conseils d’amélioration et options de confirmation', () => {
    const html = renderToStaticMarkup(
      <PhotoCoachAiFeedback
        assessment={warningAssessment}
        onConfirm={() => {}}
        onRetake={() => {}}
      />,
    );

    expect(html).toContain('Photo exploitable avec points d’amélioration conseillés');
    expect(html).toContain('Arrière-plan encombré par des cartons atelier.');
    expect(html).toContain('Placez le vélo devant un mur uni ou une bâche blanche pour un rendu optimal.');
    expect(html).toContain('Valider et enrichir le catalogue →');
  });

  it('rend un verdict REJECTED recommandant la reprise mais offrant la dérogation loueur (ADR-042)', () => {
    const html = renderToStaticMarkup(
      <PhotoCoachAiFeedback
        assessment={rejectedAssessment}
        onConfirm={() => {}}
        onRetake={() => {}}
      />,
    );

    expect(html).toContain('Photo déconseillée par le coach (standards non atteints)');
    expect(html).toContain('Points d’attention soulevés par l’analyse :');
    expect(html).toContain('Image très floue (bougé appareil ou optique sale).');
    expect(html).toContain('Roues coupées au cadrage.');
    expect(html).toContain('Reprendre la photo 📷');
    // Le loueur dispose toujours de l'action pour passer outre le VLM (ADR-042)
    expect(html).toContain('Continuer malgré tout avec cette photo');
  });

  it('prend en compte la locale anglaise', () => {
    const htmlEn = renderToStaticMarkup(
      <PhotoCoachAiFeedback
        assessment={conformantAssessment}
        locale="en"
        onConfirm={() => {}}
        onRetake={() => {}}
      />,
    );

    expect(htmlEn).toContain('Photo meets professional standards');
    expect(htmlEn).toContain('Sharpness');
    expect(htmlEn).toContain('Framing');
    expect(htmlEn).toContain('Confirm and enrich catalog →');
  });
});
