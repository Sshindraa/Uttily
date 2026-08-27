/**
 * @uttily/contracts — Définitions sémantiques des slots photo et guide vélo (G8B-3).
 *
 * Contrat de domaine strictement agnostique du moteur de rendu UI.
 */

export type PhotoSlotType =
  'FULL_BIKE' | 'DRIVETRAIN' | 'BRAKES_TIRES' | 'BATTERY' | 'MOTOR' | 'DISPLAY' | 'CHARGER';

export interface PhotoSlotDefinition {
  type: PhotoSlotType;
  title: string;
  shortDescription: string;
  required: boolean;
  minMediaCount: number;
  maxMediaCount: number;
  multiMediaRecommended: boolean;
  checklistItems: readonly string[];
  guide: {
    animationKey: string;
    overlayKey: string;
    helperHint: string;
  };
}

export const BIKE_PHOTO_SLOTS: Record<PhotoSlotType, PhotoSlotDefinition> = {
  FULL_BIKE: {
    type: 'FULL_BIKE',
    title: 'Vue complète',
    shortDescription: 'Vélo entier de profil, côté transmission (côté droit / chaîne)',
    required: true,
    minMediaCount: 1,
    maxMediaCount: 3,
    multiMediaRecommended: false,
    checklistItems: [
      'Vélo entier visible sans coupure des roues ni du guidon',
      'Pris de profil avec la transmission (chaîne/pédalier) face à vous',
      'Arrière-plan dégagé et contraste net avec le vélo',
    ],
    guide: {
      animationKey: 'full-bike-intro',
      overlayKey: 'full-bike',
      helperHint: 'Placez le vélo dans le repère, sans couper les roues',
    },
  },
  DRIVETRAIN: {
    type: 'DRIVETRAIN',
    title: 'Transmission',
    shortDescription: 'Pédalier, chaîne, cassette et dérailleur',
    required: true,
    minMediaCount: 1,
    maxMediaCount: 3,
    multiMediaRecommended: false,
    checklistItems: [
      'Plateau, manivelle et chaîne bien nets et éclairés',
      'Cassette ou pignon arrière visible',
      'Cadrage de proximité sans élément masquant',
    ],
    guide: {
      animationKey: 'drivetrain-zoom',
      overlayKey: 'drivetrain-anatomy',
      helperHint: 'Rapprochez-vous du bloc pédalier et dérailleur',
    },
  },
  BRAKES_TIRES: {
    type: 'BRAKES_TIRES',
    title: 'Freins et pneus',
    shortDescription: 'Système de freinage et profil des pneumatiques',
    required: true,
    minMediaCount: 1,
    maxMediaCount: 5,
    multiMediaRecommended: true,
    checklistItems: [
      'Système de freinage (étrier / disque / patin) clairement identifiable',
      'Sculpture ou profil de la bande de roulement du pneu net',
      'Plusieurs photos recommandées pour dissocier freins et pneus',
    ],
    guide: {
      animationKey: 'brakes-tires-spotlight',
      overlayKey: 'brakes-tires',
      helperHint: 'Montrez les étriers/disques et la surface du pneu',
    },
  },
  BATTERY: {
    type: 'BATTERY',
    title: 'Batterie (VAE)',
    shortDescription: 'Intégration cadre et serrure',
    required: false,
    minMediaCount: 0,
    maxMediaCount: 2,
    multiMediaRecommended: false,
    checklistItems: ['Batterie en place', 'Serrure ou connecteur visible'],
    guide: {
      animationKey: 'battery-highlight',
      overlayKey: 'battery',
      helperHint: 'Cadrez le logement et le verrou de la batterie',
    },
  },
  MOTOR: {
    type: 'MOTOR',
    title: 'Moteur (VAE)',
    shortDescription: 'Bloc moteur central ou moyeu',
    required: false,
    minMediaCount: 0,
    maxMediaCount: 2,
    multiMediaRecommended: false,
    checklistItems: ['Marque ou bloc moteur visible'],
    guide: {
      animationKey: 'motor-highlight',
      overlayKey: 'motor',
      helperHint: 'Cadrez le bloc moteur au niveau du pédalier ou du moyeu',
    },
  },
  DISPLAY: {
    type: 'DISPLAY',
    title: 'Écran / Commande (VAE)',
    shortDescription: 'Console au guidon',
    required: false,
    minMediaCount: 0,
    maxMediaCount: 2,
    multiMediaRecommended: false,
    checklistItems: ['Écran allumé ou commandes visibles'],
    guide: {
      animationKey: 'display-highlight',
      overlayKey: 'display',
      helperHint: "Cadrez l'afficheur au guidon sans reflet gênant",
    },
  },
  CHARGER: {
    type: 'CHARGER',
    title: 'Chargeur (VAE)',
    shortDescription: 'Chargeur secteur fourni',
    required: false,
    minMediaCount: 0,
    maxMediaCount: 2,
    multiMediaRecommended: false,
    checklistItems: ['Chargeur et embout de charge nets'],
    guide: {
      animationKey: 'charger-highlight',
      overlayKey: 'charger',
      helperHint: "Posez le chargeur à plat et montrez l'embout",
    },
  },
};
