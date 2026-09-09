'use server';

import { CatalogError, stripJpegExif } from '@uttily/core';
import { revalidatePath } from 'next/cache';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { runAction } from '@/lib/action-mapper';
import { isValidUuid } from '@/lib/validation';
import {
  OpenRouterPhotoCoachAnalyzer,
  FakePhotoCoachAnalyzer,
  type PhotoQualityAssessment,
  type DetectedEquipmentFeatures,
} from '@uttily/intelligence';
import {
  type ActionResult,
  type EquipmentAttributeEvidence,
  type PhotoSlotType,
  PHOTO_SLOT_TYPES,
} from '@uttily/contracts';
import { eq, isNull, and } from 'drizzle-orm';
import { productVariants, products } from '@uttily/database';
import { DEMO_PHOTO_COACH_ORG_ID } from '@/lib/photo-coach-constants';

export async function analyzePhotoQualityAction(
  organizationId: string,
  _prev: ActionResult<PhotoQualityAssessment>,
  formData: FormData,
): Promise<ActionResult<PhotoQualityAssessment>> {
  const file = formData.get('file');
  const expectedSlot = String(formData.get('expectedSlot') ?? 'HERO_PROFILE');
  const categorySlug = String(formData.get('categorySlug') ?? 'bike');

  if (!(file instanceof File)) {
    return { ok: false, code: 'VALIDATION', message: 'Fichier image manquant.' };
  }

  return runAction(async () => {
    // Vérifier l'accès loueur (contourné uniquement pour l'organisation de démonstration publique)
    if (organizationId !== DEMO_PHOTO_COACH_ORG_ID) {
      await requireCatalogManagerOf(organizationId);
    }

    // Expurgation EXIF (GPS, horodatage, modèle d'appareil) avant tout appel tiers (ADR-042)
    const arrayBuffer = await file.arrayBuffer();
    const rawBytes = new Uint8Array(arrayBuffer);
    const { sanitizedBuffer } = stripJpegExif(rawBytes);
    const buffer = Buffer.from(sanitizedBuffer);
    const mimeType = file.type || 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;

    // Choix du provider : OpenRouter si clé disponible, sinon Fake déterministe
    const analyzer = process.env.OPENROUTER_API_KEY
      ? new OpenRouterPhotoCoachAnalyzer()
      : new FakePhotoCoachAnalyzer();

    try {
      const assessment = await analyzer.analyzePhoto({
        imageBase64OrDataUrl: dataUrl,
        expectedSlot,
        categorySlug,
      });
      return assessment;
    } catch (err) {
      console.error('[PhotoCoach] OpenRouter analysis failed:', err);
      // En environnement avec clé API, ne JAMAIS halluciner un faux vélo avec attributs inventés (ADR-042).
      // On retourne un diagnostic dégradé avec confidence=0 permettant la validation manuelle par le loueur.
      const safeSlot: PhotoSlotType =
        expectedSlot && (PHOTO_SLOT_TYPES as readonly string[]).includes(expectedSlot)
          ? (expectedSlot as PhotoSlotType)
          : 'HERO_PROFILE';

      return {
        verdict: 'WARNING',
        matchedSlot: safeSlot,
        slotConformity: true,
        quality: {
          sharpnessScore: 70,
          exposureScore: 70,
          framingScore: 70,
          backgroundNeutralityScore: 70,
        },
        detectedFeatures: {
          isElectric: false,
          hasLuggageRack: false,
          hasTrailerHitch: false,
          hasChildSeatCompatibleMount: false,
          drivetrainType: 'UNKNOWN',
          brakeType: 'UNKNOWN',
          frameType: 'UNKNOWN',
          confidence: 0,
        },
        issuesFr: [
          'L’analyse automatique par vision n’a pas pu aboutir (indisponibilité temporaire). Vous pouvez continuer et attester les caractéristiques manuellement.',
        ],
        issuesEn: [
          'Automatic vision analysis could not complete (temporary unavailability). You may proceed and confirm attributes manually.',
        ],
        suggestionsFr: [
          'Vérifiez manuellement que le vélo est net, centré et photographié côté transmission.',
        ],
        suggestionsEn: [
          'Please verify manually that the bike is sharp, centered, and photographed on the drive side.',
        ],
      };
    }
  });
}

export interface ConfirmEquipmentFeaturesInput {
  readonly organizationId: string;
  readonly productId: string;
  readonly features: Partial<DetectedEquipmentFeatures>;
}

export async function confirmEquipmentFeaturesAction(
  input: ConfirmEquipmentFeaturesInput,
): Promise<ActionResult<{ updatedVariantsCount: number }>> {
  const { organizationId, productId, features } = input;

  if (!isValidUuid(productId)) {
    return { ok: false, code: 'VALIDATION', message: 'Identifiant de produit invalide.' };
  }

  return runAction(async () => {
    if (organizationId === DEMO_PHOTO_COACH_ORG_ID) {
      return { updatedVariantsCount: 1 };
    }

    const { db, organizationId: authorizedOrgId } = await requireCatalogManagerOf(organizationId);

    // Vérifier que le produit appartient bien à l'organisation
    const [prod] = await db
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.id, productId),
          eq(products.organizationId, authorizedOrgId),
          isNull(products.deletedAt),
        ),
      );

    if (!prod) {
      throw new CatalogError('NOT_FOUND', 'Produit introuvable.');
    }

    // Récupérer les variantes actives du produit
    const variants = await db
      .select({
        id: productVariants.id,
        attributes: productVariants.attributes,
      })
      .from(productVariants)
      .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt)));

    let updatedCount = 0;
    for (const v of variants) {
      const existingAttributes = (v.attributes as Record<string, unknown>) ?? {};
      const existingEvidence =
        (existingAttributes.evidence as Record<string, EquipmentAttributeEvidence>) ?? {};

      const updatedEvidence: Record<string, EquipmentAttributeEvidence> = {
        ...existingEvidence,
      };

      for (const [key, value] of Object.entries(features)) {
        if (value !== undefined) {
          updatedEvidence[key] = {
            key,
            value,
            evidenceLevel: 'HUMAN_CONFIRMED',
            confirmedBy: authorizedOrgId,
            confirmedAt: new Date().toISOString(),
          };
        }
      }

      const updatedAttributes = {
        ...existingAttributes,
        ...features,
        evidence: updatedEvidence,
        verifiedByPhotoCoachAt: new Date().toISOString(),
      };

      await db
        .update(productVariants)
        .set({
          attributes: updatedAttributes,
          updatedAt: new Date(),
        })
        .where(eq(productVariants.id, v.id));

      updatedCount++;
    }

    revalidatePath(`/dashboard/${authorizedOrgId}/bikes/${productId}`);
    revalidatePath(`/dashboard/${authorizedOrgId}/catalog/${productId}`);
    return { updatedVariantsCount: updatedCount };
  });
}
