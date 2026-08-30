/**
 * @uttily/core — Modèle de progression d'onboarding unifié (Chantier 6).
 *
 * Mappe les 7 critères de readiness technique du Core en 4 étapes fluides pour
 * le loueur :
 * 1. Mon activité (Organization)
 * 2. Ma boutique (Location & horaires)
 * 3. Mon premier équipement (Produit + Photos + Tarif + Exemplaires)
 * 4. Mes virements (Paiements & Coordonnées bancaires)
 *
 * Déterminé EXCLUSIVEMENT à partir des données réelles (zéro champ d'état fragile).
 */

import type { OrganizationOnboardingReadiness } from './onboarding-readiness';

export type UnifiedOnboardingStepKey = 'ACTIVITY' | 'STORE' | 'FIRST_BIKE' | 'PAYOUTS';

export interface UnifiedOnboardingStep {
  key: UnifiedOnboardingStepKey;
  num: number;
  label: string;
  shortLabel: string;
  description: string;
  completed: boolean;
  href: string;
  ctaLabel: string;
}

export interface UnifiedFirstBikeDetails {
  id: string | null;
  name: string | null;
  photosCount: number;
  hasPrice: boolean;
  inventoryCount: number;
  isComplete: boolean;
}

export interface UnifiedOnboardingProgress {
  steps: UnifiedOnboardingStep[];
  completedCount: number;
  totalCount: number;
  percentage: number;
  currentStepNum: number | 'COMPLETE';
  currentStep: UnifiedOnboardingStep | null;
  isReadyForReservations: boolean;
  isConfigurationComplete: boolean;
  firstBike: UnifiedFirstBikeDetails;
  primaryCta: {
    label: string;
    href: string;
  };
}

/**
 * Projette la readiness technique (7 critères) en progression unifiée (4 étapes).
 */
export function resolveUnifiedOnboardingProgress(
  orgId: string,
  readiness: OrganizationOnboardingReadiness,
): UnifiedOnboardingProgress {
  const milestoneMap = new Map(readiness.milestones.map((m) => [m.key, m]));

  const orgMilestone = milestoneMap.get('ORGANIZATION');
  const locMilestone = milestoneMap.get('LOCATION');
  const prodMilestone = milestoneMap.get('PRIMARY_PRODUCT');
  const photoMilestone = milestoneMap.get('PHOTOS');
  const priceMilestone = milestoneMap.get('PRICING');
  const invMilestone = milestoneMap.get('INVENTORY');
  const payMilestone = milestoneMap.get('PAYMENTS');

  // Étape 1 : Mon activité
  const isActivityComplete = orgMilestone?.completed ?? false;

  // Étape 2 : Ma boutique
  const isStoreComplete = locMilestone?.completed ?? false;

  // Étape 3 : Mon premier équipement (regroupe Produit, Photos, Tarif, Inventaire)
  const firstBikeId = prodMilestone?.details.productId ?? null;
  const isProductCreated = prodMilestone?.completed ?? false;
  const isPhotosComplete = photoMilestone?.completed ?? false;
  const isPriceComplete = priceMilestone?.completed ?? false;
  const isInventoryComplete = invMilestone?.completed ?? false;

  const isFirstBikeComplete =
    isProductCreated && isPhotosComplete && isPriceComplete && isInventoryComplete;

  const firstBikeDetails: UnifiedFirstBikeDetails = {
    id: firstBikeId,
    name: prodMilestone?.details.info ?? null,
    photosCount: photoMilestone?.details.count ?? 0,
    hasPrice: isPriceComplete,
    inventoryCount: invMilestone?.details.count ?? 0,
    isComplete: isFirstBikeComplete,
  };

  // URL du premier équipement : si déjà créé, renvoie vers son setup résumable, sinon vers /bikes/new
  const firstBikeHref = firstBikeId
    ? `/dashboard/${orgId}/bikes/${firstBikeId}/setup`
    : `/dashboard/${orgId}/bikes/new`;

  // Étape 4 : Mes virements
  const isPayoutsComplete = payMilestone?.completed ?? false;

  const steps: UnifiedOnboardingStep[] = [
    {
      key: 'ACTIVITY',
      num: 1,
      label: '① Mon activité',
      shortLabel: 'Activité',
      description: 'Raison sociale et identité de votre entreprise de location.',
      completed: isActivityComplete,
      href: `/dashboard/${orgId}/settings`,
      ctaLabel: 'Vérifier mon activité',
    },
    {
      key: 'STORE',
      num: 2,
      label: '② Ma boutique',
      shortLabel: 'Boutique',
      description: 'Point de retrait physique, adresse et horaires d’ouverture.',
      completed: isStoreComplete,
      href: `/dashboard/${orgId}/locations/new`,
      ctaLabel: 'Ajouter ma boutique',
    },
    {
      key: 'FIRST_BIKE',
      num: 3,
      label: '③ Mon premier équipement',
      shortLabel: 'Premier équipement',
      description: 'Modèle, photos normées, tarif journalier et nombre d’exemplaires.',
      completed: isFirstBikeComplete,
      href: firstBikeHref,
      ctaLabel: firstBikeId ? 'Continuer l’équipement' : 'Ajouter mon premier équipement',
    },
    {
      key: 'PAYOUTS',
      num: 4,
      label: '④ Mes virements',
      shortLabel: 'Virements',
      description: 'Coordonnées bancaires sécurisées pour recevoir les revenus locataires.',
      completed: isPayoutsComplete,
      href: `/dashboard/${orgId}/finances`,
      ctaLabel: 'Activer mes virements',
    },
  ];

  const completedCount = steps.filter((s) => s.completed).length;
  const totalCount = steps.length;
  const percentage = Math.round((completedCount / totalCount) * 100);

  const currentStep = steps.find((s) => !s.completed) ?? null;
  const currentStepNum = currentStep ? currentStep.num : 'COMPLETE';

  // Détermination du CTA principal
  let primaryCta: { label: string; href: string };
  if (!isActivityComplete) {
    primaryCta = { label: 'Configurer mon activité →', href: `/dashboard/${orgId}/settings` };
  } else if (!isStoreComplete) {
    primaryCta = { label: 'Ajouter ma boutique →', href: `/dashboard/${orgId}/locations/new` };
  } else if (!isFirstBikeComplete) {
    primaryCta = {
      label: firstBikeId
        ? 'Continuer la configuration de l’équipement →'
        : 'Ajouter mon premier équipement →',
      href: firstBikeHref,
    };
  } else if (!isPayoutsComplete) {
    primaryCta = {
      label: 'Activer mes virements bancaires →',
      href: `/dashboard/${orgId}/finances`,
    };
  } else {
    primaryCta = { label: 'Voir mes équipements en ligne →', href: `/dashboard/${orgId}/bikes` };
  }

  return {
    steps,
    completedCount,
    totalCount,
    percentage,
    currentStepNum,
    currentStep,
    isReadyForReservations: readiness.isReadyForReservations,
    isConfigurationComplete: isActivityComplete && isStoreComplete && isFirstBikeComplete,
    firstBike: firstBikeDetails,
    primaryCta,
  };
}
