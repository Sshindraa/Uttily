import type { ComponentType } from 'react';
import type { OverlayProps } from './overlays/FullBikeOverlay';
import { BrakesTiresOverlay, DrivetrainOverlay, FullBikeOverlay } from './overlays';

export interface PhotoGuideAnimationDescriptor {
  src?: string;
  artboard?: string;
  stateMachine?: string;
  animationKey: string;
}

const OVERLAYS_REGISTRY: Record<string, ComponentType<OverlayProps>> = {
  'full-bike': FullBikeOverlay,
  'drivetrain-anatomy': DrivetrainOverlay,
  'brakes-tires': BrakesTiresOverlay,
  // Fallbacks pour les slots complémentaires VAE vers FullBikeOverlay
  battery: FullBikeOverlay,
  motor: DrivetrainOverlay,
  display: FullBikeOverlay,
  charger: FullBikeOverlay,
};

const ANIMATIONS_REGISTRY: Record<string, PhotoGuideAnimationDescriptor> = {
  'full-bike-intro': {
    animationKey: 'full-bike-intro',
    src: '/animations/BikePhotoGuide.riv',
    artboard: 'BikePhotoCoach',
    stateMachine: 'PhotoCoachStateMachine',
  },
  'drivetrain-zoom': {
    animationKey: 'drivetrain-zoom',
    src: '/animations/BikePhotoGuide.riv',
    artboard: 'BikePhotoCoach',
    stateMachine: 'PhotoCoachStateMachine',
  },
  'brakes-tires-spotlight': {
    animationKey: 'brakes-tires-spotlight',
    src: '/animations/BikePhotoGuide.riv',
    artboard: 'BikePhotoCoach',
    stateMachine: 'PhotoCoachStateMachine',
  },
};

export const PhotoGuideAnimationAdapter = {
  resolveOverlay(overlayKey: string): ComponentType<OverlayProps> {
    const Component = OVERLAYS_REGISTRY[overlayKey];
    if (!Component) {
      return FullBikeOverlay;
    }
    return Component;
  },

  resolveAnimation(animationKey: string): PhotoGuideAnimationDescriptor {
    const descriptor = ANIMATIONS_REGISTRY[animationKey];
    if (!descriptor) {
      return {
        animationKey,
        src: '/animations/BikePhotoGuide.riv',
        artboard: 'BikePhotoCoach',
        stateMachine: 'PhotoCoachStateMachine',
      };
    }
    return descriptor;
  },
};
