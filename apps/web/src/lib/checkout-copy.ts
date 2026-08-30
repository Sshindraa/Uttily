import type { AppLocale } from './locale';

export type CheckoutCopy = {
  paymentForm: {
    notInitialized: string;
    verifyDetails: string;
    genericError: string;
    loadingModule: string;
    paying: string;
    loadingPayment: string;
    pay: string;
    preparingPayment: string;
    processingPayment: string;
    preparingForm: string;
  };
  success: {
    title: string;
    description: (renterName: string) => string;
    bookingsLink: string;
  };
  error: {
    title: string;
    generic: string;
    retry: string;
  };
  summary: {
    heading: string;
    equipment: string;
    rental: string;
    serviceFee: string;
    total: string;
    expiresAt: (date: string) => string;
    initiate: string;
    preparingPayment: string;
    unavailable: string;
    missingBookingTitle: string;
    missingBookingDescription: string;
    accessDeniedTitle: string;
    accessDeniedDescription: string;
    fallbackEquipment: string;
    fallbackRenter: string;
  };
};

const FR_COPY: CheckoutCopy = {
  paymentForm: {
    notInitialized: "Le formulaire de paiement n'est pas encore initialisé.",
    verifyDetails: 'Vérifiez les informations de paiement saisies.',
    genericError: 'Le paiement n’a pas pu aboutir. Veuillez réessayer.',
    loadingModule: 'Chargement du module de paiement',
    paying: 'Paiement en cours...',
    loadingPayment: 'Chargement du paiement...',
    pay: 'Payer',
    preparingPayment: 'Préparation du paiement…',
    processingPayment: 'Traitement du paiement…',
    preparingForm: 'Préparation du formulaire de paiement…',
  },
  success: {
    title: 'Paiement confirmé !',
    description: (renterName) =>
      `Votre réservation chez ${renterName} est validée. Retrouvez tous les détails et l’itinéraire dans votre espace.`,
    bookingsLink: 'Accéder à mes locations →',
  },
  error: {
    title: 'Paiement interrompu',
    generic: 'Une erreur est survenue lors de l’initialisation de votre paiement.',
    retry: 'Réessayer le paiement',
  },
  summary: {
    heading: 'Récapitulatif de votre équipement',
    equipment: 'Équipement loué',
    rental: 'Location',
    serviceFee: 'Frais de service',
    total: 'Total à régler',
    expiresAt: (date) => `Brouillon valide jusqu’au ${date}`,
    initiate: 'Initier le paiement',
    preparingPayment: 'Préparation du paiement…',
    unavailable:
      'Le service de paiement est momentanément indisponible. Veuillez réessayer plus tard.',
    missingBookingTitle: 'Réservation introuvable ou expirée',
    missingBookingDescription:
      'Ce panier de réservation n’est plus valide. Veuillez relancer une recherche.',
    accessDeniedTitle: 'Accès refusé',
    accessDeniedDescription: 'Cette réservation appartient à un autre compte utilisateur.',
    fallbackEquipment: 'Équipement loué',
    fallbackRenter: 'Loueur partenaire',
  },
};

const EN_COPY: CheckoutCopy = {
  paymentForm: {
    notInitialized: 'The payment form is not ready yet.',
    verifyDetails: 'Check the payment details you entered.',
    genericError: 'Payment could not be completed. Please try again.',
    loadingModule: 'Loading payment module',
    paying: 'Payment in progress...',
    loadingPayment: 'Loading payment...',
    pay: 'Pay',
    preparingPayment: 'Preparing payment…',
    processingPayment: 'Processing payment…',
    preparingForm: 'Preparing payment form…',
  },
  success: {
    title: 'Payment confirmed!',
    description: (renterName) =>
      `Your booking with ${renterName} is confirmed. Find all details and directions in your account.`,
    bookingsLink: 'Go to my bookings →',
  },
  error: {
    title: 'Payment interrupted',
    generic: 'An error occurred while starting your payment.',
    retry: 'Retry payment',
  },
  summary: {
    heading: 'Your equipment summary',
    equipment: 'Rented equipment',
    rental: 'Rental',
    serviceFee: 'Service fee',
    total: 'Total to pay',
    expiresAt: (date) => `Booking draft valid until ${date}`,
    initiate: 'Start payment',
    preparingPayment: 'Preparing payment…',
    unavailable: 'The payment service is temporarily unavailable. Please try again later.',
    missingBookingTitle: 'Booking not found or expired',
    missingBookingDescription: 'This booking draft is no longer valid. Please start a new search.',
    accessDeniedTitle: 'Access denied',
    accessDeniedDescription: 'This booking belongs to another user account.',
    fallbackEquipment: 'Rented equipment',
    fallbackRenter: 'Partner renter',
  },
};

export function getCheckoutCopy(locale: AppLocale | string): CheckoutCopy {
  return locale === 'en' ? EN_COPY : FR_COPY;
}
