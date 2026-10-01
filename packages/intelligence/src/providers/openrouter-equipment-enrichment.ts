import { createHash } from 'node:crypto';
import type { EquipmentEnrichmentInput } from '../schemas/equipment-enrichment';
import { EquipmentEnrichmentProposalSchema } from '../schemas/equipment-enrichment';
import type {
  EquipmentEnrichmentPort,
  EquipmentEnrichmentExecutionResult,
  EnrichmentExecutionMetadata,
} from '../ports/equipment-enrichment';

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

export interface OpenRouterEquipmentEnrichmentOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_MODEL = 'google/gemini-3.8-flash';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 60000;
const PROMPT_VERSION = 'p0-equipment-v1.1-openrouter';

const SYSTEM_PROMPT = `Tu es l'Inspecteur Technique & Rédacteur d'Uttily, la plateforme professionnelle de location d'équipements outdoor.
Ton rôle est d'analyser la photo d'un équipement (vélo, kayak, ski, surf, paddle, etc.) et d'en extraire les données factuelles avec une rigueur absolue.

RÈGLE CARDINALE D'ADR-041 : ABSTENTION > HALLUCINATION
- Chaque champ probabiliste est un objet JSON : { "value": ... | null, "confidence": 0.0 à 1.0, "reasoning": "brève justification visuelle" }.
- Si une information n'est pas lisible ou visible avec certitude (par exemple la taille exacte du cadre, ou la capacité exacte de la batterie), mets formellement "value": null et "confidence": 0. Ne devine JAMAIS.
- Si la marque est clairement visible (ex: logo "Specialized" ou "Trek"), mets une confiance élevée (0.95 à 0.99).

TAXONOMIE CANONIQUE UTTILY (ADR-035) :
- Familles acceptées ("categorySlug") : "bike", "kayak", "canoe", "paddleboard", "pedalboat", "surf", "ski", "snowboard", "snowshoes", "sled".
- Sous-types vélos ("subtype") : "electric_mountain", "mountain", "electric_city", "city", "gravel", "road", "electric_trekking", "trekking", "kids".

STANDARDS TECHNIQUES VÉLOS :
- Moteurs : Bosch, Shimano, Specialized (Brose), Yamaha, Bafang, Mahle, Fazua.
- Batteries usuelles (en Wh entiers) : 250, 400, 500, 625, 700, 750, 900.
- Transmissions : Shimano (Deore, SLX, XT, XTR, GRX, 105, Ultegra), SRAM (SX, NX, GX, X01, XX1, Apex, Rival, Force, Red).
- Tailles de cadre : "XS", "S", "M", "L", "XL", ou tailles en cm/pouces ("52", "54", "56").

SLOTS PHOTOS (ADR-031) :
- "HERO_PROFILE" (vélo entier de profil dégagé, côté transmission de préférence).
- "THREE_QUARTER_FRONT" (vue 3/4 avant dynamique).
- "SECONDARY_VIEW" (détail valorisant : cockpit, batterie, dérailleur, ou 3/4 arrière).

DESCRIPTIONS MARKETING :
- Rédige un descriptif commercial attrayant, précis et valorisant pour les loueurs professionnels en français ("marketingDescriptionFr") et en anglais ("marketingDescriptionEn").

FORMAT DE RÉPONSE STRICT :
Tu dois répondre EXCLUSIVEMENT avec un objet JSON valide respectant cette structure exacte, sans aucun texte avant ou après :
{
  "brand": { "value": string | null, "confidence": number, "reasoning"?: string },
  "model": { "value": string | null, "confidence": number, "reasoning"?: string },
  "categorySlug": { "value": string | null, "confidence": number, "reasoning"?: string },
  "subtype": { "value": string | null, "confidence": number, "reasoning"?: string },
  "frameSize": { "value": string | null, "confidence": number, "reasoning"?: string },
  "specifications": { "value": Record<string, string | number | boolean> | null, "confidence": number, "reasoning"?: string },
  "marketingDescriptionFr": { "value": string | null, "confidence": number },
  "marketingDescriptionEn": { "value": string | null, "confidence": number },
  "suggestedCondition": { "value": "NEW" | "GOOD" | "FAIR" | "POOR" | "BROKEN" | null, "confidence": number, "reasoning"?: string },
  "detectedPhotoSlot": { "value": "HERO_PROFILE" | "THREE_QUARTER_FRONT" | "SECONDARY_VIEW" | "SIGNATURE_DETAIL" | "FULL_BIKE" | null, "confidence": number, "reasoning"?: string },
  "generalObservations": string
}`;

export class OpenRouterEquipmentEnrichmentProvider implements EquipmentEnrichmentPort {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: OpenRouterEquipmentEnrichmentOptions = {}) {
    const key = options.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!key) {
      throw new Error(
        'Clé OpenRouter manquante : définissez OPENROUTER_API_KEY ou fournissez apiKey dans les options.',
      );
    }
    this.apiKey = key;
    this.model = options.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async enrichEquipment(
    input: EquipmentEnrichmentInput,
  ): Promise<EquipmentEnrichmentExecutionResult> {
    const startTime = Date.now();

    // Calcul de l'empreinte d'entrée déterministe
    const hash = createHash('sha256');
    hash.update(input.organizationId);
    for (const img of input.images) {
      if (img.url) hash.update(img.url);
      if (img.base64) hash.update(img.base64.slice(0, 100));
    }
    if (input.contextHint) hash.update(input.contextHint);
    const inputFingerprint = hash.digest('hex');

    // Construction du payload multimodal OpenRouter
    const contentParts: Array<
      { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
    > = [];

    // Message contextuel utilisateur
    const userPromptText = input.contextHint
      ? `Analyse cette image d'équipement outdoor pour préparer sa fiche location Uttily.\nContexte additionnel fourni par le loueur : "${input.contextHint}"`
      : `Analyse cette image d'équipement outdoor pour préparer sa fiche location Uttily.`;

    contentParts.push({ type: 'text', text: userPromptText });

    for (const img of input.images) {
      const imageUrl = img.url ? img.url : `data:${img.mimeType};base64,${img.base64}`;
      contentParts.push({
        type: 'image_url',
        image_url: { url: imageUrl },
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://uttily.com',
          'X-Title': 'Uttily Equipment Intelligence',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: contentParts },
          ],
          temperature: 0.1,
          max_tokens: 2000,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `Erreur OpenRouter (${response.status} ${response.statusText}): ${errorBody}`,
        );
      }

      const data = (await response.json()) as OpenRouterChatCompletionResponse;
      const latencyMs = Date.now() - startTime;

      const rawChoiceContent = data.choices?.[0]?.message?.content;
      if (!rawChoiceContent) {
        throw new Error("Réponse vide ou invalide reçue d'OpenRouter");
      }

      // Nettoyage éventuel des balises markdown ```json ... ```
      const cleanedJson = rawChoiceContent
        .replace(/^```json\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      const parsedJson = JSON.parse(cleanedJson);
      const validatedProposal = EquipmentEnrichmentProposalSchema.parse(parsedJson);

      const metadata: EnrichmentExecutionMetadata = {
        provider: 'openrouter',
        model: this.model,
        promptVersion: PROMPT_VERSION,
        providerRequestId: data.id ?? `or-${Date.now()}`,
        latencyMs,
        costMicrounits: this.estimateCostMicrounits(
          data.usage?.prompt_tokens,
          data.usage?.completion_tokens,
        ),
        ...(typeof data.usage?.prompt_tokens === 'number'
          ? { inputUnits: data.usage.prompt_tokens }
          : {}),
        ...(typeof data.usage?.completion_tokens === 'number'
          ? { outputUnits: data.usage.completion_tokens }
          : {}),
      };

      return {
        proposal: validatedProposal,
        metadata,
        inputFingerprint,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private estimateCostMicrounits(promptTokens?: number, completionTokens?: number): number {
    if (!promptTokens && !completionTokens) return 0;
    // Qwen3 VL 32B Instruct : $0.10 / M in, $0.42 / M out -> micro-centimes d'euro (~0.95 EUR/USD)
    const promptCost = (promptTokens ?? 0) * 0.0000001;
    const complCost = (completionTokens ?? 0) * 0.00000042;
    const totalDollars = promptCost + complCost;
    return Math.round(totalDollars * 0.95 * 100 * 10000); // 1 euro = 100 cents = 1_000_000 micro-cents
  }
}
