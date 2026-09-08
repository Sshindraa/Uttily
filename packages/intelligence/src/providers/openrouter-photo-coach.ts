import { PHOTO_SLOT_TYPES } from '@uttily/contracts';
import {
  PhotoQualityAssessmentSchema,
  type PhotoQualityAssessment,
} from '../schemas/photo-coach-schema';
import { PHOTO_COACH_SYSTEM_PROMPT } from '../prompts/photo-coach-prompt';
import type { AnalyzePhotoInput, PhotoCoachAnalyzer } from '../fakes/fake-photo-coach';

interface OpenRouterChatCompletionResponse {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export interface OpenRouterPhotoCoachOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_MODEL = 'google/gemini-3.8-flash'; // Modèle multimodal vision officiel Uttily (latence faible, haute précision)
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 25000;

export class OpenRouterPhotoCoachAnalyzer implements PhotoCoachAnalyzer {
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options?: OpenRouterPhotoCoachOptions) {
    this.apiKey = options?.apiKey ?? process.env.OPENROUTER_API_KEY;
    this.model =
      options?.model ??
      process.env.OPENROUTER_PHOTO_MODEL ??
      process.env.OPENROUTER_MODEL ??
      DEFAULT_MODEL;
    this.baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async analyzePhoto(input: AnalyzePhotoInput): Promise<PhotoQualityAssessment> {
    if (!this.apiKey) {
      throw new Error('OPENROUTER_API_KEY non configurée pour l’analyse Photo Coach.');
    }

    const expectedSlot = input.expectedSlot || 'HERO_PROFILE';
    const categorySlug = input.categorySlug || 'bike';

    // Formatage de l'image (si format base64 brut sans data URL, ajouter le préfixe jpeg)
    let imageUrl = input.imageBase64OrDataUrl;
    if (!imageUrl.startsWith('data:') && !imageUrl.startsWith('http')) {
      imageUrl = `data:image/jpeg;base64,${imageUrl}`;
    }

    const userPrompt = `Voici la photo téléversée par le loueur professionnel.
Slot attendu : "${expectedSlot}".
Catégorie d'équipement attendue : "${categorySlug}".

Évalue la conformité au slot attendu et au standard professionnel.
RÈGLE D'OR : Si la photo ne montre PAS un équipement de la catégorie "${categorySlug}" (ex: lunettes, vêtements, voiture au lieu d'un vélo), tu DOIS attribuer verdict: "REJECTED", slotConformity: false, scores de qualité à 0, et lister explicitement dans issuesFr l'objet détecté à la place.
Extrais les caractéristiques physiques réelles uniquement si un équipement de la catégorie "${categorySlug}" est bien présent.
Réponds uniquement en JSON conforme au schéma strict.`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://uttily.com',
          'X-Title': 'Uttily Photo Quality Coach',
        },
        body: JSON.stringify({
          model: this.model,
          response_format: { type: 'json_object' },
          temperature: 0.1,
          messages: [
            {
              role: 'system',
              content: PHOTO_COACH_SYSTEM_PROMPT,
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: userPrompt },
                {
                  type: 'image_url',
                  image_url: {
                    url: imageUrl,
                  },
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Erreur API OpenRouter Vision (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as OpenRouterChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error('Réponse vide du modèle vision OpenRouter.');
      }

      const parsedJson = JSON.parse(content);
      const isKnownSlot =
        typeof parsedJson?.matchedSlot === 'string' &&
        (PHOTO_SLOT_TYPES as readonly string[]).includes(parsedJson.matchedSlot);
      if (!isKnownSlot) {
        parsedJson.matchedSlot = expectedSlot;
      }
      if (parsedJson?.detectedFeatures && parsedJson.detectedFeatures.visibleSizeLabel === undefined) {
        parsedJson.detectedFeatures.visibleSizeLabel = null;
      }
      return PhotoQualityAssessmentSchema.parse(parsedJson);
    } finally {
      clearTimeout(timer);
    }
  }
}
