import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BIKE_PHOTO_SLOTS } from '@uttily/contracts';
import { FullBikeOverlay, DrivetrainOverlay, BrakesTiresOverlay } from './overlays';
import { PhotoGuideAnimationAdapter } from './adapter';
import { PhotoChecklist } from './PhotoChecklist';
import { PhotoProgress } from './PhotoProgress';

describe('PhotoCoach Overlays & Adapter', () => {
  it('résout correctement les overlays sémantiques depuis les clés de guide', () => {
    expect(PhotoGuideAnimationAdapter.resolveOverlay('full-bike')).toBe(FullBikeOverlay);
    expect(PhotoGuideAnimationAdapter.resolveOverlay('drivetrain-anatomy')).toBe(DrivetrainOverlay);
    expect(PhotoGuideAnimationAdapter.resolveOverlay('brakes-tires')).toBe(BrakesTiresOverlay);
  });

  it('rend FullBikeOverlay comme calque SVG accessible avec viewBox standard', () => {
    const html = renderToStaticMarkup(<FullBikeOverlay className="test-overlay" />);
    expect(html).toContain('<svg');
    expect(html).toContain('viewBox="0 0 1000 600"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('test-overlay');
  });

  it('rend DrivetrainOverlay avec ses repères anatomiques', () => {
    const html = renderToStaticMarkup(<DrivetrainOverlay />);
    expect(html).toContain('<svg');
    expect(html).toContain('viewBox="0 0 1000 600"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('rend BrakesTiresOverlay avec ses repères de freins et pneumatiques', () => {
    const html = renderToStaticMarkup(<BrakesTiresOverlay />);
    expect(html).toContain('<svg');
    expect(html).toContain('viewBox="0 0 1000 600"');
    expect(html).toContain('aria-hidden="true"');
  });
});

describe('PhotoChecklist Component', () => {
  const slot = BIKE_PHOTO_SLOTS.FULL_BIKE;
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

  it('calcule la complétude exacte à partir des slots présents', () => {
    const htmlExact1 = renderToStaticMarkup(
      <PhotoProgress slots={{ hasFullBike: true, hasDrivetrain: false, hasBrakesTires: false }} />,
    );
    expect(htmlExact1).toContain('1/3 complétés');

    const htmlExact2 = renderToStaticMarkup(
      <PhotoProgress slots={{ hasFullBike: true, hasDrivetrain: true, hasBrakesTires: false }} />,
    );
    expect(htmlExact2).toContain('2/3 complétés');

    const htmlExact3 = renderToStaticMarkup(
      <PhotoProgress slots={{ hasFullBike: true, hasDrivetrain: true, hasBrakesTires: true }} />,
    );
    expect(htmlExact3).toContain('3/3 complétés');
  });
});
