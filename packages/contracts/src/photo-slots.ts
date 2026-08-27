/**
 * @uttily/contracts — Définitions sémantiques des slots photo et guide vélo (G8B-3).
 *
 * Nouvelle narration désirable e-commerce / location :
 * 1. HERO_PROFILE   : Vue Hero profil complet (accroche & proportion)
 * 2. THREE_QUARTER  : Vue 3/4 dynamique (volume & projection d'usage)
 * 3. SIGNATURE_DETAIL : Détail signature (cockpit, écran, panier, finitions)
 */

export type PhotoSlotType =
  | 'HERO_PROFILE'
  | 'THREE_QUARTER'
  | 'SIGNATURE_DETAIL'
  | 'FULL_BIKE'
  | 'DRIVETRAIN'
  | 'BRAKES_TIRES'
  | 'BATTERY'
  | 'MOTOR'
  | 'DISPLAY'
  | 'CHARGER';

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
  HERO_PROFILE: {
    type: 'HERO_PROFILE',
    title: 'Vue Profil Hero',
    shortDescription: 'Vélo entier de profil, lumière homogène et arrière-plan dégagé',
    required: true,
    minMediaCount: 1,
    maxMediaCount: 3,
    multiMediaRecommended: false,
    checklistItems: [
      'Vélo entier visible sans coupure des roues ni du guidon',
      'Pris bien de profil avec un arrière-plan propre et contrasté',
      'Vélo propre, droit et correctement éclairé',
    ],
    guide: {
      animationKey: 'hero-profile-intro',
      overlayKey: 'hero-profile',
      helperHint: 'Cadrez le vélo entier dans le repère de profil',
    },
  },
  THREE_QUARTER: {
    type: 'THREE_QUARTER',
    title: 'Vue 3/4 Dynamique',
    shortDescription: 'Angle 3/4 avant valorisant le volume, la profondeur et le poste de pilotage',
    required: true,
    minMediaCount: 1,
    maxMediaCount: 3,
    multiMediaRecommended: false,
    checklistItems: [
      'Prise de vue à 45° mettant en valeur le volume et la perspective',
      'Guidon légèrement orienté et vue d’ensemble dégagée',
      'Hauteur d’homme ou légère plongée naturelle',
    ],
    guide: {
      animationKey: 'three-quarter-intro',
      overlayKey: 'three-quarter',
      helperHint: 'Placez-vous à 45° à l’avant du vélo pour donner du volume',
    },
  },
  SIGNATURE_DETAIL: {
    type: 'SIGNATURE_DETAIL',
    title: 'Détail Signature',
    shortDescription:
      'Gros plan valorisant sur l’équipement distinctif (cockpit, écran, panier, finitions)',
    required: true,
    minMediaCount: 1,
    maxMediaCount: 5,
    multiMediaRecommended: true,
    checklistItems: [
      'Équipement attractif ou pratique cadré de près avec netteté',
      'Mise en valeur d’un point fort (écran VAE, panier, poste de conduite, selle)',
      'Éclairage précis sans reflet gênant',
    ],
    guide: {
      animationKey: 'signature-detail-intro',
      overlayKey: 'signature-detail',
      helperHint: 'Rapprochez-vous de l’atout ou de l’équipement distinctif',
    },
  },

  // Rétrocompatibilité slots techniques
  FULL_BIKE: {
    type: 'FULL_BIKE',
    title: 'Vue complète',
    shortDescription: 'Vélo entier de profil',
    required: false,
    minMediaCount: 1,
    maxMediaCount: 3,
    multiMediaRecommended: false,
    checklistItems: ['Vélo entier visible', 'Arrière-plan dégagé'],
    guide: {
      animationKey: 'hero-profile-intro',
      overlayKey: 'hero-profile',
      helperHint: 'Placez le vélo dans le repère',
    },
  },
  DRIVETRAIN: {
    type: 'DRIVETRAIN',
    title: 'Transmission',
    shortDescription: 'Pédalier, chaîne et cassette',
    required: false,
    minMediaCount: 1,
    maxMediaCount: 3,
    multiMediaRecommended: false,
    checklistItems: ['Plateau et chaîne bien nets'],
    guide: {
      animationKey: 'signature-detail-intro',
      overlayKey: 'signature-detail',
      helperHint: 'Rapprochez-vous de la transmission',
    },
  },
  BRAKES_TIRES: {
    type: 'BRAKES_TIRES',
    title: 'Freins et pneus',
    shortDescription: 'Freins et surface des pneus',
    required: false,
    minMediaCount: 1,
    maxMediaCount: 5,
    multiMediaRecommended: true,
    checklistItems: ['Freins et pneus nets'],
    guide: {
      animationKey: 'signature-detail-intro',
      overlayKey: 'signature-detail',
      helperHint: 'Montrez les freins et pneus',
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
      animationKey: 'signature-detail-intro',
      overlayKey: 'signature-detail',
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
      animationKey: 'signature-detail-intro',
      overlayKey: 'signature-detail',
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
      animationKey: 'signature-detail-intro',
      overlayKey: 'signature-detail',
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
      animationKey: 'signature-detail-intro',
      overlayKey: 'signature-detail',
      helperHint: "Posez le chargeur à plat et montrez l'embout",
    },
  },
};
