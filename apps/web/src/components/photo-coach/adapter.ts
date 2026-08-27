import type { ComponentType } from 'react';
import type { OverlayProps } from './overlays/FullBikeOverlay';
import {
  BrakesTiresOverlay,
  DrivetrainOverlay,
  FullBikeOverlay,
  SignatureDetailOverlay,
  ThreeQuarterOverlay,
} from './overlays';

export interface PhotoGuideAnimationDescriptor {
  src?: string;
  artboard?: string;
  stateMachine?: string;
  animationKey: string;
}

const OVERLAYS_REGISTRY: Record<string, ComponentType<OverlayProps>> = {
  'hero-profile': FullBikeOverlay,
  'three-quarter': ThreeQuarterOverlay,
  'signature-detail': SignatureDetailOverlay,
  'full-bike': FullBikeOverlay,
  'drivetrain-anatomy': DrivetrainOverlay,
  'brakes-tires': BrakesTiresOverlay,
  battery: SignatureDetailOverlay,
  motor: SignatureDetailOverlay,
  display: SignatureDetailOverlay,
  charger: SignatureDetailOverlay,
};

const ANIMATIONS_REGISTRY: Record<string, PhotoGuideAnimationDescriptor> = {
  'hero-profile-intro': {
    animationKey: 'hero-profile-intro',
    src: '/animations/BikePhotoGuide.riv',
    artboard: 'BikePhotoCoach',
    stateMachine: 'PhotoCoachStateMachine',
  },
  'three-quarter-intro': {
    animationKey: 'three-quarter-intro',
    src: '/animations/BikePhotoGuide.riv',
    artboard: 'BikePhotoCoach',
    stateMachine: 'PhotoCoachStateMachine',
  },
  'signature-detail-intro': {
    animationKey: 'signature-detail-intro',
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
