import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BIKE_PHOTO_SLOTS } from '@uttily/contracts';
import {
  FullBikeOverlay,
  DrivetrainOverlay,
  BrakesTiresOverlay,
  ThreeQuarterOverlay,
  SignatureDetailOverlay,
} from './overlays';
import { PhotoGuideAnimationAdapter } from './adapter';
import { PhotoChecklist } from './PhotoChecklist';
import { PhotoProgress } from './PhotoProgress';

describe('PhotoCoach Overlays & Adapter', () => {
  it('résout correctement les overlays sémantiques de la narration 3 vues', () => {
    expect(PhotoGuideAnimationAdapter.resolveOverlay('hero-profile')).toBe(FullBikeOverlay);
    expect(PhotoGuideAnimationAdapter.resolveOverlay('three-quarter')).toBe(ThreeQuarterOverlay);
    expect(PhotoGuideAnimationAdapter.resolveOverlay('signature-detail')).toBe(
      SignatureDetailOverlay,
    );
  });

  it('rend FullBikeOverlay comme calque SVG accessible avec viewBox standard', () => {
    const html = renderToStaticMarkup(<FullBikeOverlay className="test-overlay" />);
    expect(html).toContain('<svg');
    expect(html).toContain('viewBox="0 0 1000 600"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('test-overlay');
  });

  it('rend ThreeQuarterOverlay avec ses repères en perspective 3/4', () => {
    const html = renderToStaticMarkup(<ThreeQuarterOverlay />);
    expect(html).toContain('<svg');
    expect(html).toContain('viewBox="0 0 1000 600"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('rend SignatureDetailOverlay avec son réticule macro', () => {
    const html = renderToStaticMarkup(<SignatureDetailOverlay />);
    expect(html).toContain('<svg');
    expect(html).toContain('viewBox="0 0 1000 600"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('rend DrivetrainOverlay et BrakesTiresOverlay pour les slots techniques', () => {
    const drivetrainHtml = renderToStaticMarkup(<DrivetrainOverlay />);
    expect(drivetrainHtml).toContain('<svg');
    const brakesHtml = renderToStaticMarkup(<BrakesTiresOverlay />);
    expect(brakesHtml).toContain('<svg');
  });
});

describe('PhotoChecklist Component', () => {
  const slot = BIKE_PHOTO_SLOTS.HERO_PROFILE;
  const dummyBlob = new Blob(['dummy-image-content'], { type: 'image/jpeg' });

  it('rend les éléments de checklist non cochés et le bouton désactivé par défaut', () => {
    const html = renderToStaticMarkup(
      <PhotoChecklist
        slot={slot}
        imageBlob={dummyBlob}
        isSaving={false}
        onRetake={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(html).toContain('Utiliser cette photo');
    expect(html).toContain('Reprendre');
    expect(html).toContain('disabled=""'); // bouton désactivé par défaut
    for (const item of slot.checklistItems) {
      expect(html).toContain(item);
    }
  });
});

describe('PhotoProgress Component', () => {
  it('affiche le bon état de complétude selon le nombre de slots validés', () => {
    const html0 = renderToStaticMarkup(<PhotoProgress completedSlotsCount={0} />);
    expect(html0).toContain('0/3 complétés');

    const html1 = renderToStaticMarkup(<PhotoProgress completedSlotsCount={1} />);
    expect(html1).toContain('1/3 complétés');

    const html3 = renderToStaticMarkup(<PhotoProgress completedSlotsCount={3} />);
    expect(html3).toContain('3/3 complétés');
  });

  it('calcule la complétude exacte à partir des slots narratifs présents', () => {
    const htmlExact1 = renderToStaticMarkup(
      <PhotoProgress
        slots={{ hasHeroProfile: true, hasThreeQuarter: false, hasSignatureDetail: false }}
      />,
    );
    expect(htmlExact1).toContain('1/3 complétés');

    const htmlExact2 = renderToStaticMarkup(
      <PhotoProgress
        slots={{ hasHeroProfile: true, hasThreeQuarter: true, hasSignatureDetail: false }}
      />,
    );
    expect(htmlExact2).toContain('2/3 complétés');

    const htmlExact3 = renderToStaticMarkup(
      <PhotoProgress
        slots={{ hasHeroProfile: true, hasThreeQuarterFront: true, hasSecondaryView: true }}
      />,
    );
    expect(htmlExact3).toContain('3/3 complétés');
  });
});
