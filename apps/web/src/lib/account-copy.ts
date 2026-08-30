import type { CustomerBookingStatus } from '@uttily/core';
import type { AppLocale } from './locale';

export type AccountCopy = {
  nav: {
    bookings: string;
    search: string;
  };
  bookings: {
    eyebrow: string;
    title: string;
    description: string;
    search: string;
    emptyTitle: string;
    emptyDescription: string;
    upcoming: string;
    active: string;
    past: string;
    renter: (name: string) => string;
    view: string;
  };
  statusLabels: Record<CustomerBookingStatus, string>;
  detail: {
    back: string;
    categoryFallback: string;
    renter: (name: string) => string;
    datesHeading: string;
    pickup: string;
    return: string;
    mapLink: string;
    instructionsHeading: string;
    identity: string;
    identityText: string;
    storeReception: string;
    storeReceptionText: string;
    pickupInstructions: string;
    returnInstructions: string;
    equipmentHeading: string;
    size: (size: string) => string;
    documentsHeading: string;
    issuedOn: (date: string) => string;
    downloadPdf: string;
    paymentHeading: string;
    totalAmount: string;
    paidOnline: string;
    paymentPending: string;
    paymentAction: string;
    paidOn: (date: string) => string;
    noPayment: string;
    managementHeading: string;
    cancellationAllowed: string;
    cancelledOn: (date: string) => string;
    refundRequested: (amount: string) => string;
    splitRefundUnresolved: string;
    notModifiable: string;
    helpTitle: string;
    helpWithPhone: (phone: string) => string;
    helpWithoutPhone: string;
    statusBanner: {
      confirmedTitle: string;
      confirmedDescription: string;
      readyTitle: string;
      readyDescription: string;
      activeTitle: string;
      activeDescription: string;
      completedTitle: string;
      completedDescription: string;
      refundPendingTitle: string;
      refundPendingDescription: (amount?: string) => string;
      refundedTitle: string;
      refundedDescription: (amount?: string) => string;
      noRefundTitle: string;
      noRefundDescription: string;
      actionRequiredTitle: string;
      actionRequiredDescription: string;
      unavailableTitle: string;
      unavailableDescription: string;
    };
  };
  cancellation: {
    button: string;
    dialogTitle: string;
    successWithRefund: (amount: string) => string;
    successWithoutRefund: string;
    backToBooking: string;
    loading: string;
    paidAmount: string;
    expectedRefund: string;
    retainedFees: string;
    policyNotice: string;
    keepBooking: string;
    confirm: string;
    cancelling: string;
    stalePreview: string;
  };
};

const FR_COPY: AccountCopy = {
  nav: { bookings: 'Mes locations', search: 'Rechercher un équipement' },
  bookings: {
    eyebrow: 'Espace personnel',
    title: 'Mes locations',
    description: 'Retrouvez l’ensemble de vos réservations et gérez vos trajets.',
    search: 'Rechercher un équipement',
    emptyTitle: 'Aucune location pour le moment',
    emptyDescription: 'Trouvez votre prochain équipement près de chez vous en quelques clics.',
    upcoming: 'À venir',
    active: 'En cours',
    past: 'Historique',
    renter: (name) => `Loueur : ${name}`,
    view: 'Voir ma location →',
  },
  statusLabels: {
    CONFIRMED: 'Confirmée',
    READY_FOR_PICKUP: 'Votre équipement est prêt',
    ACTIVE: 'En cours',
    COMPLETED: 'Terminée',
    CANCELLED_REFUND_PENDING: 'Annulée · Remboursement en cours',
    CANCELLED_REFUNDED: 'Annulée · Remboursée',
    CANCELLED_NO_REFUND: 'Annulée',
    CANCELLED_ACTION_REQUIRED: 'Annulée · Action requise',
  },
  detail: {
    back: '← Mes locations',
    categoryFallback: 'Location',
    renter: (name) => `Loueur : ${name}`,
    datesHeading: '📅 Dates et lieu de location',
    pickup: 'Retrait',
    return: 'Retour',
    mapLink: 'Ouvrir l’itinéraire Google Maps ↗',
    instructionsHeading: 'ℹ️ Consignes & Déroulement',
    identity: 'Pièce d’identité',
    identityText: 'Présentez une pièce d’identité valide au moment du retrait.',
    storeReception: 'Accueil magasin',
    storeReceptionText: 'Présentez-vous directement à l’accueil en indiquant votre nom.',
    pickupInstructions: 'Consignes de retrait',
    returnInstructions: 'Consignes de retour',
    equipmentHeading: '🧰 Équipement réservé',
    size: (size) => `Taille ${size}`,
    documentsHeading: '📄 Vos documents',
    issuedOn: (date) => `Émis le ${date}`,
    downloadPdf: 'Télécharger PDF ↗',
    paymentHeading: '💳 Votre paiement',
    totalAmount: 'Montant total',
    paidOnline: '✓ Payé en ligne',
    paymentPending: '⏳ Paiement en cours',
    paymentAction: '⚠️ Paiement à régulariser',
    paidOn: (date) => `le ${date}`,
    noPayment: 'Informations de paiement non disponibles.',
    managementHeading: '⚙️ Gestion de la réservation',
    cancellationAllowed: 'Vous pouvez annuler votre réservation selon les conditions convenues.',
    cancelledOn: (date) => `Réservation annulée le ${date}.`,
    refundRequested: (amount) => `Remboursement demandé : ${amount}`,
    splitRefundUnresolved:
      'L’annulation en ligne est temporairement indisponible pour cette réservation. Contactez le loueur pour son traitement.',
    notModifiable: 'Cette réservation n’est plus modifiable ou annulable en ligne.',
    helpTitle: 'Besoin d’aide ?',
    helpWithPhone: (phone) =>
      `Pour toute question relative à votre équipement, contactez directement l’établissement au ${phone}.`,
    helpWithoutPhone:
      'Pour toute question relative à votre équipement, contactez directement l’établissement.',
    statusBanner: {
      confirmedTitle: 'Votre location est confirmée',
      confirmedDescription:
        'Le loueur a préparé votre dossier. Présentez-vous au point de retrait à l’heure convenue.',
      readyTitle: 'Votre équipement est prêt au magasin',
      readyDescription: 'Votre équipement a été préparé par le loueur.',
      activeTitle: 'Location en cours',
      activeDescription:
        'Profitez de votre trajet ! Pensez à restituer l’équipement avant l’heure limite de retour.',
      completedTitle: 'Location terminée',
      completedDescription: 'L’équipement a été restitué. Merci d’avoir loué avec Uttily !',
      refundPendingTitle: 'Réservation annulée — Remboursement en cours de traitement',
      refundPendingDescription: (amount) =>
        amount
          ? `Une demande de remboursement de ${amount} a été transmise et est en cours de traitement.`
          : 'Votre réservation est annulée.',
      refundedTitle: 'Réservation annulée et remboursée',
      refundedDescription: (amount) =>
        amount
          ? `Un remboursement de ${amount} a été émis sur votre moyen de paiement.`
          : 'Réservation annulée.',
      noRefundTitle: 'Réservation annulée',
      noRefundDescription:
        'Cette réservation a été annulée conformément aux conditions applicables.',
      actionRequiredTitle: 'Réservation annulée — Action requise',
      actionRequiredDescription:
        'Le traitement de votre dossier nécessite une intervention. Notre équipe vous contacte.',
      unavailableTitle: 'Statut indisponible',
      unavailableDescription:
        'Nous ne pouvons pas confirmer l’état actuel de cette location. Contactez le loueur.',
    },
  },
  cancellation: {
    button: 'Annuler ma réservation',
    dialogTitle: 'Annulation de réservation',
    successWithRefund: (amount) =>
      `Votre réservation a bien été annulée. Une demande de remboursement de ${amount} a été transmise pour traitement selon les conditions applicables.`,
    successWithoutRefund: 'Votre réservation a bien été annulée.',
    backToBooking: 'Retour à ma réservation',
    loading: 'Calcul des conditions de remboursement...',
    paidAmount: 'Montant réglé',
    expectedRefund: 'Remboursement prévu',
    retainedFees: 'Frais retenus',
    policyNotice:
      'Calculé conformément à la politique d’annulation applicable à cette réservation.',
    keepBooking: 'Conserver ma réservation',
    confirm: 'Confirmer l’annulation',
    cancelling: 'Annulation…',
    stalePreview: 'Les conditions ont évolué. Vos montants ont été actualisés.',
  },
};

const EN_COPY: AccountCopy = {
  nav: { bookings: 'My bookings', search: 'Find equipment' },
  bookings: {
    eyebrow: 'Personal area',
    title: 'My bookings',
    description: 'View all your bookings and manage your trips.',
    search: 'Find equipment',
    emptyTitle: 'No bookings yet',
    emptyDescription: 'Find your next piece of equipment near you in just a few clicks.',
    upcoming: 'Upcoming',
    active: 'In progress',
    past: 'History',
    renter: (name) => `Renter: ${name}`,
    view: 'View my booking →',
  },
  statusLabels: {
    CONFIRMED: 'Confirmed',
    READY_FOR_PICKUP: 'Ready for pickup',
    ACTIVE: 'In progress',
    COMPLETED: 'Completed',
    CANCELLED_REFUND_PENDING: 'Cancelled · Refund pending',
    CANCELLED_REFUNDED: 'Cancelled · Refunded',
    CANCELLED_NO_REFUND: 'Cancelled',
    CANCELLED_ACTION_REQUIRED: 'Cancelled · Action required',
  },
  detail: {
    back: '← My bookings',
    categoryFallback: 'Booking',
    renter: (name) => `Renter: ${name}`,
    datesHeading: '📅 Booking dates and location',
    pickup: 'Pickup',
    return: 'Return',
    mapLink: 'Open Google Maps directions ↗',
    instructionsHeading: 'ℹ️ Instructions & details',
    identity: 'ID document',
    identityText: 'Present a valid ID document at pickup.',
    storeReception: 'Store reception',
    storeReceptionText: 'Go to reception and give them your name.',
    pickupInstructions: 'Pickup instructions',
    returnInstructions: 'Return instructions',
    equipmentHeading: '🧰 Reserved equipment',
    size: (size) => `Size ${size}`,
    documentsHeading: '📄 Your documents',
    issuedOn: (date) => `Issued on ${date}`,
    downloadPdf: 'Download PDF ↗',
    paymentHeading: '💳 Your payment',
    totalAmount: 'Total amount',
    paidOnline: '✓ Paid online',
    paymentPending: '⏳ Payment pending',
    paymentAction: '⚠️ Payment action required',
    paidOn: (date) => `on ${date}`,
    noPayment: 'Payment information unavailable.',
    managementHeading: '⚙️ Booking management',
    cancellationAllowed: 'You can cancel your booking according to the applicable terms.',
    cancelledOn: (date) => `Booking cancelled on ${date}.`,
    refundRequested: (amount) => `Refund requested: ${amount}`,
    splitRefundUnresolved:
      'Online cancellation is temporarily unavailable for this booking. Contact the renter to process it.',
    notModifiable: 'This booking can no longer be changed or cancelled online.',
    helpTitle: 'Need help?',
    helpWithPhone: (phone) =>
      `For questions about your equipment, contact the location at ${phone}.`,
    helpWithoutPhone: 'For questions about your equipment, contact the location directly.',
    statusBanner: {
      confirmedTitle: 'Your booking is confirmed',
      confirmedDescription:
        'The renter has prepared your booking. Arrive at the pickup point on time.',
      readyTitle: 'Your equipment is ready at the store',
      readyDescription: 'Your equipment has been prepared by the renter.',
      activeTitle: 'Booking in progress',
      activeDescription:
        'Enjoy your trip! Remember to return the equipment by the agreed deadline.',
      completedTitle: 'Booking completed',
      completedDescription: 'The equipment has been returned. Thank you for renting with Uttily!',
      refundPendingTitle: 'Booking cancelled — Refund being processed',
      refundPendingDescription: (amount) =>
        amount
          ? `A refund request for ${amount} has been submitted and is being processed.`
          : 'Your booking has been cancelled.',
      refundedTitle: 'Booking cancelled and refunded',
      refundedDescription: (amount) =>
        amount
          ? `A refund of ${amount} has been issued to your payment method.`
          : 'Booking cancelled.',
      noRefundTitle: 'Booking cancelled',
      noRefundDescription: 'This booking was cancelled according to the applicable terms.',
      actionRequiredTitle: 'Booking cancelled — Action required',
      actionRequiredDescription: 'Your case requires attention. Our team will contact you.',
      unavailableTitle: 'Status unavailable',
      unavailableDescription:
        'We cannot confirm the current status of this booking. Contact the renter.',
    },
  },
  cancellation: {
    button: 'Cancel my booking',
    dialogTitle: 'Cancel booking',
    successWithRefund: (amount) =>
      `Your booking has been cancelled. A refund request for ${amount} has been submitted for processing under the applicable terms.`,
    successWithoutRefund: 'Your booking has been cancelled.',
    backToBooking: 'Back to my booking',
    loading: 'Calculating refund terms...',
    paidAmount: 'Amount paid',
    expectedRefund: 'Expected refund',
    retainedFees: 'Retained fees',
    policyNotice: 'Calculated according to the cancellation policy applicable to this booking.',
    keepBooking: 'Keep my booking',
    confirm: 'Confirm cancellation',
    cancelling: 'Cancelling…',
    stalePreview: 'The terms have changed. Your amounts have been updated.',
  },
};

export function getAccountCopy(locale: AppLocale | string): AccountCopy {
  return locale === 'en' ? EN_COPY : FR_COPY;
}
