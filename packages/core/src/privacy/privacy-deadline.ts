// ---------------------------------------------------------------------------
// Lot 21-P1 — Calcul des échéances RGPD (article 12.3).
//
// Le RGPD impose un délai de réponse d'UN MOIS CALENDAIRE, pas 30 jours.
// La prolongation en cas de complexité est de DEUX MOIS CALENDAIRES
// supplémentaires, avec notification dans le premier mois.
// ---------------------------------------------------------------------------

/**
 * Calcule la date limite de réponse à une demande RGPD : +1 mois calendaire.
 *
 * Gère les cas limites :
 * - 31 janvier → 28/29 février (clamp au dernier jour du mois)
 * - 31 mars → 30 avril
 * - Année bissextile
 */
export function computePrivacyResponseDeadline(receivedAt: Date): Date {
  const deadline = new Date(receivedAt);
  const originalDay = deadline.getUTCDate();

  deadline.setUTCMonth(deadline.getUTCMonth() + 1);

  // Si le jour a débordé (ex: 31 jan + 1 mois = 3 mars), on clampe
  // au dernier jour du mois cible.
  if (deadline.getUTCDate() !== originalDay) {
    // Revenir au dernier jour du mois précédent (le mois cible voulu).
    deadline.setUTCDate(0);
  }

  return deadline;
}

/**
 * Calcule la date limite de prolongation : +2 mois calendaires à partir
 * de la date de réponse initiale.
 */
export function computePrivacyExtensionDeadline(responseDueAt: Date): Date {
  const extension = new Date(responseDueAt);
  const originalDay = extension.getUTCDate();

  extension.setUTCMonth(extension.getUTCMonth() + 2);

  if (extension.getUTCDate() !== originalDay) {
    extension.setUTCDate(0);
  }

  return extension;
}
