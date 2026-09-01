import type { UnifiedBike } from './unified-bike';

export type BikeSetupStep = 'IDENTITY' | 'PHOTOS' | 'PRICING' | 'INVENTORY' | 'REVIEW';

export interface BikeSetupProgress {
  productId: string;
  completedSteps: BikeSetupStep[];
  nextStep: BikeSetupStep;
  isPublicationReady: boolean;
  isOfferReady: boolean;
}

/**
 * Calcule dynamiquement la progression du setup d'un vélo
 * à partir de ses données réelles (source de vérité pure, sans champ d'état fragile).
 */
export function resolveBikeSetupProgress(bike: UnifiedBike): BikeSetupProgress {
  const completedSteps: BikeSetupStep[] = [];

  // 1. Identité complète (nom >= 2 car, description non vide, catégorie présente)
  const isIdentityComplete =
    bike.product.name.trim().length >= 2 &&
    (bike.product.description ?? '').trim().length > 0 &&
    bike.product.categoryId.length > 0;

  if (isIdentityComplete) {
    completedSteps.push('IDENTITY');
  }

  // 2. Flotte et lieu renseignés (au moins 1 exemplaire créé)
  const isInventoryComplete = bike.inventory.totalCount >= 1;
  if (isInventoryComplete) {
    completedSteps.push('INVENTORY');
  }

  // 3. Tarification configurée (plan actif ou draft)
  const isPricingComplete =
    bike.pricing.isPriced || bike.pricing.draftPlan !== null || bike.pricing.activePlan !== null;
  if (isPricingComplete) {
    completedSteps.push('PRICING');
  }

  // 4. Photos complètes (slots canoniques pour un vélo + checksums distincts)
  const isPhotosComplete = bike.photos.isComplete;
  if (isPhotosComplete) {
    completedSteps.push('PHOTOS');
  }

  // 5. Détermine la prochaine meilleure étape
  let nextStep: BikeSetupStep = 'IDENTITY';
  if (!isIdentityComplete) {
    nextStep = 'IDENTITY';
  } else if (!isInventoryComplete) {
    nextStep = 'INVENTORY';
  } else if (!isPricingComplete) {
    nextStep = 'PRICING';
  } else if (!isPhotosComplete) {
    nextStep = 'PHOTOS';
  } else {
    nextStep = 'REVIEW';
  }

  return {
    productId: bike.product.id,
    completedSteps,
    nextStep,
    isPublicationReady: bike.publication.ready,
    isOfferReady: bike.offerReadiness.isAvailable,
  };
}
