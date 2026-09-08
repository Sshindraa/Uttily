import type {
  IntentCompilerPort,
  IntentCompilerInput,
  IntentCompilerExecutionResult,
  IntentProposal,
} from '../ports/intent-compiler';
import { IntentProposalSchema } from '../schemas/intent-compiler';

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

export interface OpenRouterIntentCompilerOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_MODEL = 'openai/gpt-5.6-luna';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 15000;

const SYSTEM_PROMPT = `Tu es le Compilateur d'Intention et Assistant de Recherche d'Uttily, la plateforme de location d'équipements outdoor et de mobilité.
Ton rôle est de traduire une requête utilisateur en langage naturel en un AST strict de critères de recherche pour le moteur de réservation.

RÈGLE CARDINALE D'ADR-041 : ABSTENTION > HALLUCINATION
- Tout champ incertain ou non mentionné est un objet JSON : { "value": ... | null, "confidence": 0.0 à 1.0, "reasoning": "..." }.
- Ne devine JAMAIS une destination, une date ou un nombre de personnes si l'utilisateur ne l'a pas explicité.
- Si une destination n'est pas mentionnée, mets "value": null et "confidence": 0.
- Si la requête correspond à l'une des destinations de la liste fournie, renseigne le label exact dans "destination" et son identifiant dans "destinationPublicId".

NOMBRE DE PERSONNES (RÈGLE STRICTE ANTI-HALLUCINATION) :
- Ne devine JAMAIS le nombre de personnes s'il n'est pas explicitement formulé dans la requête.
- Si la requête ne mentionne PAS de nombre de participants (ex: "Tour du lac d'Annecy en VTT électrique ce samedi", "Kayak à Annecy demain"), "peopleCount" DOIT OBLIGATOIREMENT être :
  { "value": null, "confidence": 0, "reasoning": "Non précisé dans la requête" }
- N'invente JAMAIS 2 personnes par défaut ! Ne déduis un nombre que si l'utilisateur dit expressément "2 personnes", "pour 3", "en famille de 4", "pour moi seul" (1), etc.

EXTRACTION DES DATES :
- Utilise la date de référence actuelle fournie dans le prompt pour résoudre les dates relatives ("ce samedi", "demain", "ce week-end", "le 15 août").
- Format des dates : AAAA-MM-JJ (ex: "2026-09-12").
- Mode : "DAY_RANGE" pour des journées entières, "TIME_RANGE" si des heures sont précisées ("de 9h à 17h").
- Format des heures si TIME_RANGE : HH:MM (ex: "09:00", "17:00").
- RÈGLE DE COHÉRENCE : Pour une location sur une seule journée (ex: "ce samedi"), "startDate" est ce samedi et "endDateExclusive" DOIT OBLIGATOIREMENT être le jour suivant (startDate + 1 jour). "endDateExclusive" ne doit JAMAIS être antérieure ou égale à "startDate".

BESOINS EN ÉQUIPEMENT :
- "requirements" : tableau de besoins par catégorie (ex: vélos électriques, remorque, kayak).
- "categorySlug" : slug parmi les catégories fournies (ex: "bike", "kayak", "ski", "paddleboard").

SORTIE STRICTE :
Réponds UNIQUEMENT avec un objet JSON valide conforme à la structure demandée.`;

export class OpenRouterIntentCompilerProvider implements IntentCompilerPort {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: OpenRouterIntentCompilerOptions = {}) {
    const key = options.apiKey || process.env.OPENROUTER_API_KEY;
    if (!key) {
      throw new Error(
        'OPENROUTER_API_KEY est requis pour utiliser OpenRouterIntentCompilerProvider.',
      );
    }
    this.apiKey = key;
    this.model =
      options.model ||
      process.env.OPENROUTER_INTENT_MODEL ||
      process.env.OPENROUTER_MODEL ||
      DEFAULT_MODEL;
    this.baseUrl = options.baseUrl || process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  async compileIntent(input: IntentCompilerInput): Promise<IntentCompilerExecutionResult> {
    const startTime = Date.now();

    const currentIso = input.userContext?.currentDateTimeIso || new Date().toISOString();
    const destinationsList = input.userContext?.availableDestinations
      ? input.userContext.availableDestinations
          .map((d) => `- ${d.label} (slug: "${d.slug}", publicId: "${d.publicId}")`)
          .join('\n')
      : 'Aucune liste pré-établie.';

    const categoriesList = input.userContext?.availableCategories
      ? input.userContext.availableCategories
          .map((c) => `- ${c.name} (slug: "${c.slug}", id: "${c.id}")`)
          .join('\n')
      : 'Aucune liste pré-établie.';

    const userPrompt = `Date et heure actuelles de référence : ${currentIso} (fuseau Europe/Paris).
Langue de l'utilisateur : ${input.locale}

DESTINATIONS PROPOSÉES SUR LA PLATEFORME :
${destinationsList}

CATÉGORIES D'ÉQUIPEMENTS DISPONIBLES :
${categoriesList}

REQUÊTE DE L'UTILISATEUR :
"${input.rawQuery}"

Compulse cette intention sous forme JSON :
{
  "destination": { "value": string | null, "confidence": number, "reasoning": string },
  "destinationPublicId": { "value": string | null, "confidence": number, "reasoning": string },
  "dates": {
    "value": {
      "mode": "DAY_RANGE" | "TIME_RANGE",
      "startDate": "YYYY-MM-DD",
      "endDateExclusive": "YYYY-MM-DD (strictement > startDate, ex: startDate + 1 jour pour une seule journée)",
      "startAt": "YYYY-MM-DDTHH:MM:SSZ",
      "endAt": "YYYY-MM-DDTHH:MM:SSZ"
    } | null,
    "confidence": number,
    "reasoning": string
  },
  "peopleCount": { "value": number | null, "confidence": number, "reasoning": string },
  "requirements": [
    {
      "categorySlug": string,
      "categoryId": string (optionnel si identifié),
      "subtypes": string[],
      "targetHeightCm": number (optionnel),
      "electricPreferred": boolean (optionnel)
    }
  ],
  "rawQueryCleaned": string,
  "explanationFr": "Synthèse amicale en français des critères compris",
  "explanationEn": "Friendly summary in English"
}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://uttily.com',
          'X-Title': 'Uttily Intent Compiler',
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.1,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Erreur OpenRouter API (${response.status} ${response.statusText}): ${errorText}`,
        );
      }

      const data = (await response.json()) as OpenRouterChatCompletionResponse;
      const rawContent = data.choices?.[0]?.message?.content;

      if (!rawContent) {
        throw new Error("Réponse vide reçue du modèle d'intention OpenRouter.");
      }

      let parsedJson: unknown;
      try {
        const cleaned = rawContent
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim();
        parsedJson = JSON.parse(cleaned);
      } catch (parseError) {
        throw new Error(
          `Impossible de parser le JSON renvoyé par OpenRouter: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        );
      }

      const validatedProposal: IntentProposal = IntentProposalSchema.parse(parsedJson);

      return {
        proposal: validatedProposal,
        latencyMs: Date.now() - startTime,
        model: this.model,
      };
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `Dépassement du délai d'attente (${this.timeoutMs}ms) lors de l'appel au compilateur d'intention.`,
        );
      }
      throw err;
    }
  }
}
