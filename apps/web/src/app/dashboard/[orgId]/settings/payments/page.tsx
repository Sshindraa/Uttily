import { redirect } from 'next/navigation';

/**
 * Bridge de redirection pour l'ancien chemin des paramètres de paiement.
 * L'expérience bancaire et Stripe Connect appartient désormais à l'espace Revenus (/finances).
 */
export default async function PaymentsSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<never> {
  const { orgId } = await params;
  redirect(`/dashboard/${orgId}/finances`);
}
