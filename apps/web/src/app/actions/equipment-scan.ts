'use server';

import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { runAction } from '@/lib/action-mapper';
import type { ActionResult } from '@uttily/contracts';
import {
  OpenRouterEquipmentEnrichmentProvider,
  FakeEquipmentEnrichmentProvider,
  type EquipmentEnrichmentProposal,
} from '@uttily/intelligence';

/**
 * Server Action pour l'analyse intelligente d'une photo d'équipement (P0 Scan & List).
 *
 * Conforme à l'ADR-008 (validation manuelle explicite des entrées HTTP/FormData)
 * et à l'ADR-040 (délégation du traitement multimodal à @uttily/intelligence).
 */
export async function scanEquipmentPhotoAction(
  organizationId: string,
  _prev: ActionResult<EquipmentEnrichmentProposal>,
  formData: FormData,
): Promise<ActionResult<EquipmentEnrichmentProposal>> {
  const file = formData.get('photo');
  if (!file || !(file instanceof File) || file.size === 0) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'Veuillez sélectionner une photo d’équipement valide.',
    };
  }

  // Limite de taille à 10 Mo
  if (file.size > 10 * 1024 * 1024) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: 'La taille de la photo ne doit pas dépasser 10 Mo.',
    };
  }

  const rawType = file.type.toLowerCase();
  const mimeType: 'image/jpeg' | 'image/png' | 'image/webp' = rawType.includes('png')
    ? 'image/png'
    : rawType.includes('webp')
      ? 'image/webp'
      : 'image/jpeg';

  const arrayBuffer = await file.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  return runAction(async () => {
    await requireCatalogManagerOf(organizationId);

    const provider = process.env.OPENROUTER_API_KEY
      ? new OpenRouterEquipmentEnrichmentProvider({
          model: process.env.OPENROUTER_MODEL || 'google/gemini-3.8-flash',
        })
      : new FakeEquipmentEnrichmentProvider();

    const result = await provider.enrichEquipment({
      organizationId,
      images: [{ base64, mimeType }],
      locale: 'fr',
    });

    return result.proposal;
  });
}
