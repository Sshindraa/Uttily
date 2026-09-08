'use server';

import type { ActionResult } from '@uttily/contracts';
import {
  OpenRouterIntentCompilerProvider,
  FakeIntentCompilerProvider,
  type IntentProposal,
} from '@uttily/intelligence';
import { loadHomeSearchOptions } from './home-search-options';

/**
 * Server Action de compilation d'intention de recherche en langage naturel (P1).
 *
 * Conforme à l'ADR-008 (validation manuelle, aucun Zod aux frontières HTTP)
 * et à l'ADR-040 (délégation du traitement NLP à @uttily/intelligence).
 */
export async function compileSearchIntentAction(
  rawQuery: string,
  locale: 'fr' | 'en' = 'fr',
): Promise<ActionResult<IntentProposal>> {
  const trimmed = rawQuery ? rawQuery.trim() : '';
  if (!trimmed) {
    return {
      ok: false,
      code: 'VALIDATION',
      message:
        locale === 'fr'
          ? 'Veuillez décrire votre projet de sortie ou de location.'
          : 'Please describe your rental or trip project.',
    };
  }

  if (trimmed.length > 500) {
    return {
      ok: false,
      code: 'VALIDATION',
      message:
        locale === 'fr'
          ? 'Votre description est trop longue (500 caractères max).'
          : 'Your description is too long (500 characters max).',
    };
  }

  try {
    const filterOptions = await loadHomeSearchOptions(locale);

    const availableDestinations = filterOptions?.destinations.map((d) => ({
      publicId: d.publicId,
      label: d.label,
      slug: d.slug,
    }));

    const availableCategories = filterOptions?.categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
    }));

    const provider = process.env.OPENROUTER_API_KEY
      ? new OpenRouterIntentCompilerProvider({
          model: process.env.OPENROUTER_INTENT_MODEL || 'openai/gpt-5.6-luna',
        })
      : new FakeIntentCompilerProvider();

    const result = await provider.compileIntent({
      rawQuery: trimmed,
      locale,
      userContext: {
        currentDateTimeIso: new Date().toISOString(),
        ...(availableDestinations ? { availableDestinations } : {}),
        ...(availableCategories ? { availableCategories } : {}),
      },
    });

    return {
      ok: true,
      data: result.proposal,
    };
  } catch (err) {
    return {
      ok: false,
      code: 'UNKNOWN',
      message: err instanceof Error ? err.message : 'Erreur lors de la compilation de l’intention.',
    };
  }
}
