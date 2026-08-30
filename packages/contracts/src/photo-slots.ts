/**
 * @uttily/contracts — Définitions sémantiques des slots photo et guide vélo (G8B-3).
 *
 * Narration e-commerce désirable & pragmatique en 3 temps forts :
 * 1. HERO_PROFILE        : Vue Hero profil complet (accroche & proportion)
 * 2. THREE_QUARTER_FRONT : Vue 3/4 avant dynamique (volume & perspective)
 * 3. SECONDARY_VIEW      : Vue libre valorisante (détail utile si pertinent : cockpit, écran, panier, selle ; sinon 3/4 arrière)
 */

export const PHOTO_SLOT_TYPES = [
  'HERO_PROFILE',
  'THREE_QUARTER_FRONT',
  'SECONDARY_VIEW',
  'THREE_QUARTER', // Alias rétrocompatibilité
  'SIGNATURE_DETAIL', // Alias rétrocompatibilité
  'FULL_BIKE',
  'DRIVETRAIN',
  'BRAKES_TIRES',
  'BATTERY',
  'MOTOR',
  'DISPLAY',
  'CHARGER',
] as const;

export type PhotoSlotType = (typeof PHOTO_SLOT_TYPES)[number];

/** Slots canoniques obligatoires pour la publication d'un vélo (ADR-031). */
export const REQUIRED_BIKE_PHOTO_SLOTS = [
  'HERO_PROFILE',
  'THREE_QUARTER_FRONT',
  'SECONDARY_VIEW',
] as const satisfies readonly PhotoSlotType[];

export type RequiredBikePhotoSlot = (typeof REQUIRED_BIKE_PHOTO_SLOTS)[number];

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
    title: 'Profil Hero',
    shortDescription: 'Vélo entier de profil, fond dégagé',
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
  THREE_QUARTER_FRONT: {
    type: 'THREE_QUARTER_FRONT',
    title: '3/4 Avant',
    shortDescription: 'Montrez le volume et le poste de pilotage',
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
  SECONDARY_VIEW: {
    type: 'SECONDARY_VIEW',
    title: 'Vue libre',
    shortDescription: 'Choisissez le détail ou l’angle le plus valorisant',
    required: true,
    minMediaCount: 1,
    maxMediaCount: 5,
    multiMediaRecommended: true,
    checklistItems: [
      'Atout utile bien cadré (cockpit, panier, écran, selle) OU vue 3/4 arrière',
      'Image nette, lumineuse et sans reflets gênants',
      'Met en valeur la praticité, le confort ou l’esthétique du vélo',
    ],
    guide: {
      animationKey: 'secondary-view-intro',
      overlayKey: 'secondary-view',
      helperHint: 'Cadrez un équipement clé (cockpit, panier, écran) ou une vue 3/4 arrière',
    },
  },

  // Alias de rétrocompatibilité
  THREE_QUARTER: {
    type: 'THREE_QUARTER',
    title: 'Vue 3/4 Dynamique',
    shortDescription: 'Angle 3/4 avant valorisant le volume et la perspective',
    required: true,
    minMediaCount: 1,
    maxMediaCount: 3,
    multiMediaRecommended: false,
    checklistItems: [
      'Prise de vue à 45° mettant en valeur le volume et la perspective',
      'Guidon légèrement orienté',
    ],
    guide: {
      animationKey: 'three-quarter-intro',
      overlayKey: 'three-quarter',
      helperHint: 'Placez-vous à 45° à l’avant du vélo',
    },
  },
  SIGNATURE_DETAIL: {
    type: 'SIGNATURE_DETAIL',
    title: 'Détail Signature',
    shortDescription: 'Gros plan valorisant sur l’équipement distinctif',
    required: true,
    minMediaCount: 1,
    maxMediaCount: 5,
    multiMediaRecommended: true,
    checklistItems: ['Équipement attractif cadré de près', 'Éclairage précis sans reflet gênant'],
    guide: {
      animationKey: 'secondary-view-intro',
      overlayKey: 'secondary-view',
      helperHint: 'Cadrez l’atout ou le détail clé',
    },
  },
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
      animationKey: 'secondary-view-intro',
      overlayKey: 'secondary-view',
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
      animationKey: 'secondary-view-intro',
      overlayKey: 'secondary-view',
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
      animationKey: 'secondary-view-intro',
      overlayKey: 'secondary-view',
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
      animationKey: 'secondary-view-intro',
      overlayKey: 'secondary-view',
      helperHint: 'Cadrez le bloc moteur',
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
      animationKey: 'secondary-view-intro',
      overlayKey: 'secondary-view',
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
      animationKey: 'secondary-view-intro',
      overlayKey: 'secondary-view',
      helperHint: "Posez le chargeur à plat et montrez l'embout",
    },
  },
};
