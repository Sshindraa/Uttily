/**
 * @uttily/core — Module Public Search (G7E-B).
 *
 * Use case : searchPublicOffers(db, input).
 *
 * Moteur de recherche publique géographique (read-only, informatif).
 * PostgreSQL reste l'autorité des filtres d'inventaire et de disponibilité.
 * Le hold transactionnel (createBookingDraftWithHold) reste l'autorité de
 * réservation. Un résultat disponible ne remplace jamais le hold.
 *
 * Architecture :
 * 1. Valider l'entrée (destinationPublicId, locale, intent, pageSize, cursor).
 * 2. Charger la destination par publicId + vérifier isActive + pays actif.
 * 3. Résoudre les catégories éligibles (récursion bornée si categoryId fourni).
 * 4. Requête SQL ensembliste (CTE) : candidates éligibles.
 * 5. Pour chaque location candidate : convertir l'intent en UTC par SON fuseau.
 * 6. Vérifier la disponibilité en batch (1 requête batch NOT EXISTS sur inventory_blocks).
 * 7. Charger le contexte pricing en batch (1 requête batch resolve_effective_pricing_plans).
 * 8. Pour chaque candidate disponible : calculer le prix via computeQuote (pur).
 * 9. Grouper par (publicProductId, publicLocationId) → sélectionner le moins cher.
 * 10. Trier par (rawDistanceMeters ASC, publicProductId ASC, publicLocationId ASC).
 * 11. Pagination keyset (curseur versionné, aucun offset) avec lookahead SQL.
 * 12. Construction du read model et du curseur de continuation.
 *     - Lookahead SQL : chaque lot charge scanCapacity + 1 groupes. Le groupe
 *       supplémentaire prouve qu'une suite existe sans être traité. lastScanned
 *       est le tuple du dernier groupe TRAITÉ, pas du lookahead.
 *     - Page pleine + groupe après le dernier résultat retourné (traité ou
 *       lookahead) : curseur depuis le dernier élément retourné.
 *     - Page pleine + dernier résultat = dernier groupe de la source : null.
 *     - Page partielle/vide + vrai lookahead : curseur checkpoint depuis
 *       lastScanned (dernier groupe traité).
 *     - Page partielle/vide + source épuisée (pas de lookahead) : null.
 *
 * Batching des requêtes SQL (indépendant du nombre de résultats) :
 *
 * Requête initiale (hors boucle de lots, exécutée une fois avant tout scan) :
 * - loadDestination : destination + pays via db.select, ET centre géographique
 *        via db.execute (ST_X/ST_Y sur PostGIS). Le db.execute du centre compte
 *        dans la borne documentée ci-dessous.
 * - resolveCategoryTree (optionnel, si categoryId fourni) : une requête
 *        db.execute WITH RECURSIVE pour résoudre l'arbre des catégories
 *        éligibles.
 *
 * Appels directs par lot (ré-exécutés à chaque lot de la boucle de scan) :
 * - loadCandidateGroups : requête principale ensembliste groupes (db.execute,
 *        CTE candidates, charge scanCapacity + 1 groupes pour le lookahead).
 * - loadCandidateVariantRows : variantes éligibles batch (db.execute, CTE
 *        groups, pour les groupes traités du lot courant).
 * - loadPricingContextsBatch : resolve_effective_pricing_plans batch
 *        (db.execute, CROSS JOIN LATERAL pour toutes les locations du lot en
 *        une seule requête).
 * - checkAvailabilityBatch : disponibilité batch (db.execute, NOT EXISTS sur
 *        inventory_blocks pour toutes les candidates du lot en une seule
 *        requête).
 *
 * Pricing et disponibilité sont chacun batchés en une seule requête par lot,
 * pas une requête par lieu. Un lot valide utilise au maximum **quatre** appels
 * directs db.execute dans l'implémentation actuelle. La mesure de 5 sur un
 * appel à un seul lot correspond à 1 initial (loadDestination centre) + 4 pour
 * le lot. La borne maximale actuelle est **1 + 4 × MAX_SCAN_BATCHES**, plus la
 * requête récursive éventuelle de catégorie (si categoryId fourni).
 *
 * Note d'instrumentation : le total SQL réel n'est pas actuellement
 * instrumenté. Les db.select (loadDestination destination/pays, traductions,
 * fenêtres, paliers, horaires d'ouverture) ne sont pas comptés par le test ;
 * seuls les db.execute (loadDestination centre, resolveCategoryTree, et les
 * quatre appels par lot) sont visibles dans la borne documentée ci-dessus.
 *
 * publicationGate (gating asynchrone batch, fail-closed) : le moteur exige une
 * dépendance explicite PublicProductPublicationGate. Aucun prédicat synchrone,
 * aucune implémentation par défaut permissive, aucun `() => true` n'est accepté.
 * G7F-A fournira l'implémentation PostgreSQL réelle (au moins trois photos).
 * Le read model G7D-A NE PEUT PAS être exposé par G7E tant que G7F-A n'a pas
 * fourni un publicationGate réel. Le futur publication gate PostgreSQL n'est
 * PAS inclus dans la borne ci-dessus tant qu'il n'est pas implémenté. Voir
 * types.ts et la documentation.
 */

import { eq, inArray, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  categories,
  countries,
  destinations,
  destinationTranslations,
  locationOpeningHours,
  locationScheduleExceptions,
  multiDayDiscountTiers,
  pricingPlanTranslations,
  pricingPlanWindows,
} from '@uttily/database';
import type {
  Candidate,
  PricingContext,
  ResolvedFlexiblePricingIntent,
  ResolvedPlan,
  ResolvedTier,
  ResolvedTranslation,
  ResolvedWindow,
  OpeningHour,
} from '../pricing-plans/types';
import { selectBestCandidate, compareCandidates } from '../pricing-plans/selector';
import { generateCandidates } from '../pricing-plans/candidate-generator';
import { calculateAmount } from '../pricing-plans/amount-calculator';
import { validateGrid } from '../pricing-plans/grid-validator';
import {
  isDayRangeBoundariesCompatibleWithSchedule,
  isWithinOpeningHours,
  validateDayRangeBoundariesAgainstSchedule,
} from '../pricing-plans/opening-hours';
import { resolveLocale, getTranslation } from '../pricing-plans/locale-resolver';
import { FlexiblePricingError } from '../pricing-plans/errors';
import { calculateMarketplaceFeeSnapshotFromPricing } from '../marketplace-fees';
import {
  LocalToUtcError,
  localDateTimeStringToUtc,
  localDateTimeToUtc,
  parseLocalDateTimeString,
} from '../pricing-plans/local-to-utc';
import {
  civilDayNumber,
  civilDayNumberToDate,
  getWeekdayFromDate,
  parseDateString,
} from '../pricing-plans/time-utils';
import { findDayRangeWindow } from '../pricing-plans/windows';
import {
  PADDLE_CATEGORY_CONTRACT,
  isHistoricalPaddleCategorySlug,
} from '../catalog/equipment-taxonomy';
import type {
  CandidateRow,
  KeysetTuple,
  PublicOfferSearchItem,
  PublicPriceSummary,
  PublicProductPublicationGate,
  PublicSearchGeographicMatch,
  PublicSearchIntent,
  SearchPublicOffersInput,
  SearchPublicOffersResult,
} from './types';
import { PublicSearchError } from './errors';
import {
  type PublicSearchCursorCodec,
  type CursorFingerprint,
  PUBLIC_SEARCH_CONTRACT_VERSION,
} from './cursor';
import {
  classifyPublicSearchGeographicMatch,
  isValidPublicSearchViewport,
  normalizePublicSearchViewport,
  publicSearchViewportCenter,
  roundDistanceForDisplay,
} from './geo';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 24;
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 48;

/** Profondeur maximale de récursion des catégories (anti-cycle défensif). */
const MAX_CATEGORY_DEPTH = 10;

/**
 * Nombre maximal de batches keyset consécutifs (scanCapacity groupes traités
 * par batch, + 1 groupe de lookahead).
 *
 * Si des groupes sont éliminés par le pricing, la disponibilité ou le gating,
 * le moteur requête le "lot suivant" jusqu'à obtenir pageSize résultats valides
 * ou atteindre cette borne. Cette borne garantit un temps de réponse prévisible.
 * La borne maximale d'appels db.execute par appel est 1 (loadDestination centre)
 * + 4 × MAX_SCAN_BATCHES (quatre appels par lot), plus 1 requête récursive
 * éventuelle de catégorie si categoryId est fourni.
 */
const MAX_SCAN_BATCHES = 5;

function buildSearchFingerprint(input: SearchPublicOffersInput): CursorFingerprint {
  return {
    destinationPublicId: input.destinationPublicId,
    canonicalLocale: canonicalizeLocale(input.locale),
    canonicalIntent: input.intent,
    categoryId: input.categoryId ?? null,
    viewport: input.viewport ? normalizePublicSearchViewport(input.viewport) : null,
    contractVersion: PUBLIC_SEARCH_CONTRACT_VERSION,
  };
}

function canonicalizeLocale(locale: string): string {
  return locale.toLowerCase().replace(/_/g, '-');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recherche publique d'offres de location.
 *
 * Read-only, informatif. PostgreSQL reste l'autorité des filtres et de
 * disponibilité. Le hold transactionnel reste l'autorité de réservation.
 *
 * @throws PublicSearchError pour toute erreur métier (codes fermés).
 */
export async function searchPublicOffers(
  db: DatabaseClient,
  input: SearchPublicOffersInput,
  options: { publicationGate: PublicProductPublicationGate; cursorCodec: PublicSearchCursorCodec },
): Promise<SearchPublicOffersResult> {
  if (!options?.publicationGate) {
    throw new PublicSearchError('PUBLICATION_GATE_UNAVAILABLE', 'Gating de publication manquant.');
  }
  if (!options?.cursorCodec) {
    throw new PublicSearchError('CURSOR_CODEC_UNAVAILABLE', 'Codec de curseur manquant.');
  }

  // 1. Valider l'entrée.
  validateInput(input);

  // 2. Décoder le curseur (si fourni) — avant tout accès DB.
  let keyset: KeysetTuple | null = null;
  if (input.cursor) {
    keyset = options.cursorCodec.decode(input.cursor, buildSearchFingerprint(input));
  }

  // 3. Charger la destination par publicId + vérifier isActive + pays actif.
  const destInfo = await loadDestination(db, input.destinationPublicId, input.locale);
  const searchArea = resolveSearchArea(destInfo, input.viewport);

  // 4. Résoudre les catégories éligibles (si filtre fourni).
  let eligibleCategoryIds: string[] | null = null;
  if (input.categoryId) {
    eligibleCategoryIds = await resolveCategoryTree(db, input.categoryId);
  }

  // 5. Pagination keyset SQL ensembliste avec scan batch borné et lookahead.
  //    Chaque lot charge scanCapacity + 1 groupes : scanCapacity groupes traités
  //    + 1 groupe de lookahead qui prouve qu'une suite existe sans être traité.
  //    Lorsque MAX_SCAN_BATCHES est atteint avec une page partielle ou vide et
  //    qu'un lookahead existe, le curseur de continuation est encodé depuis le
  //    checkpoint de scan `lastScanned` (dernier groupe TRAITÉ, pas le lookahead).
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const scanCapacity = pageSize;
  const selected: GroupedOffer[] = [];
  let currentKeyset = keyset;
  let lastScanned: KeysetTuple | null = null;
  let lastHasMoreGroupsAfterBatch = false;
  let pageFull = false;

  for (let batch = 0; batch < MAX_SCAN_BATCHES; batch++) {
    const {
      candidates,
      lastScanned: batchLastScanned,
      hasMoreGroupsAfterBatch,
    } = await loadCandidates(db, searchArea, eligibleCategoryIds, currentKeyset, scanCapacity);
    lastScanned = batchLastScanned ?? lastScanned;
    lastHasMoreGroupsAfterBatch = hasMoreGroupsAfterBatch;

    if (candidates.length === 0) {
      // Aucune candidate valide dans ce lot.
      if (hasMoreGroupsAfterBatch) {
        // Un lookahead existe : continuer depuis le checkpoint de scan.
        currentKeyset = lastScanned;
        continue;
      }
      // sourceExhausted : la source PostgreSQL n'a plus de groupes.
      break;
    }

    const batchValid = await processCandidateBatch(
      db,
      candidates,
      input,
      destInfo,
      searchArea,
      options,
    );

    for (const offer of batchValid) {
      if (selected.length < pageSize) {
        selected.push(offer);
      }
    }

    if (selected.length === pageSize) {
      pageFull = true;
      break;
    }

    if (hasMoreGroupsAfterBatch) {
      currentKeyset = lastScanned;
      continue;
    }
    // sourceExhausted : plus aucun groupe dans PostgreSQL.
    break;
  }

  // 6. Construire le read model public et le curseur de continuation.
  //
  // Règles nextCursor (cas A-E) :
  // - Cas A — Page vide/partielle + limite 5 scans + vrai lookahead :
  //   nextCursor signé depuis lastScanned (checkpoint de scan).
  // - Cas B — Page vide/partielle + exactement tous les groupes consommés
  //   (pas de lookahead) : nextCursor = null.
  // - Cas C — Page pleine + groupe traité ou lookahead après le dernier
  //   résultat retourné : nextCursor non nul depuis le dernier résultat retourné.
  //   Si la page devient pleine avant la fin des groupes du lot courant, il faut
  //   conserver un curseur même si PostgreSQL n'a aucun groupe après le lot
  //   courant (des groupes du lot courant situés après le dernier élément
  //   retourné doivent encore être parcourus).
  // - Cas D — Page pleine + dernier résultat = dernier groupe de la source :
  //   nextCursor = null.
  // - Cas E — Aucun résultat perdu, aucun doublon, ordre keyset inchangé :
  //   condition strictement > sur le tuple conservée.
  let nextCursor: string | null = null;
  if (pageFull) {
    // Cas C/D : identifier le dernier élément retourné et le dernier groupe traité.
    const last = selected[pageSize - 1]!;
    const lastReturnedKeyset: KeysetTuple = {
      rawDistanceMeters: last.rawDistanceMeters,
      publicProductId: last.publicProductId,
      publicLocationId: last.publicLocationId,
    };
    // nextCursor non nul si lastReturned < lastScanned (un groupe traité après
    // le dernier résultat retourné existe dans le lot courant) OU un lookahead
    // existe (hasMoreGroupsAfterBatch).
    const hasGroupAfterLastReturned =
      (lastScanned !== null && compareKeyset(lastReturnedKeyset, lastScanned) < 0) ||
      lastHasMoreGroupsAfterBatch;
    if (hasGroupAfterLastReturned) {
      nextCursor = options.cursorCodec.encode(lastReturnedKeyset, buildSearchFingerprint(input));
    }
    // Sinon (Cas D) : nextCursor = null.
  } else if (lastScanned && lastHasMoreGroupsAfterBatch) {
    // Cas A : page partielle/vide + vrai lookahead → checkpoint de scan.
    nextCursor = options.cursorCodec.encode(lastScanned, buildSearchFingerprint(input));
  }
  // Cas B : page partielle/vide + source épuisée → nextCursor = null (déjà null).

  const items: PublicOfferSearchItem[] = selected.map((o) => ({
    publicProductId: o.publicProductId,
    publicLocationId: o.publicLocationId,
    organizationPublicDisplayName: o.organizationPublicDisplayName,
    productName: o.productName,
    locationName: o.locationName,
    addressLine1: o.addressLine1,
    addressLine2: o.addressLine2,
    city: o.city,
    postalCode: o.postalCode,
    countryCode: o.countryCode,
    latitude: o.latitude,
    longitude: o.longitude,
    distanceMeters: roundDistanceForDisplay(o.rawDistanceMeters),
    isAvailable: true,
    geographicMatch: o.geographicMatch,
    price: o.price,
  }));

  return { items, nextCursor };
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch processing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Traite un batch de candidates (toutes les variantes des groupes chargés) et
 * retourne les offres groupées valides (prix, disponibilité, gating) triées par
 * le keyset (rawDistanceMeters, publicProductId, publicLocationId).
 *
 * Cette fonction ne fait JAMAIS de slice() : elle retourne le batch entier.
 * La pagination est gérée par l'appelant dans searchPublicOffers.
 */
async function processCandidateBatch(
  db: DatabaseClient,
  candidates: CandidateRow[],
  input: SearchPublicOffersInput,
  destination: DestinationInfo,
  searchArea: SearchArea,
  options: { publicationGate: PublicProductPublicationGate },
): Promise<GroupedOffer[]> {
  if (candidates.length === 0) {
    return [];
  }

  // 1. Résoudre les instants clients UTC pour TIME_RANGE par location (avant pricing).
  const timeRangeCustomerPeriods = new Map<
    string,
    { customerStartAt: Date; customerEndAt: Date }
  >();
  if (input.intent.kind === 'TIME_RANGE') {
    const byLocation = new Map<string, CandidateRow>();
    for (const c of candidates) {
      byLocation.set(c.locationId, c);
    }
    for (const c of byLocation.values()) {
      try {
        const customerStartAt = localDateTimeStringToUtc(input.intent.startAt, c.timeZone);
        const customerEndAt = localDateTimeStringToUtc(input.intent.endAt, c.timeZone);
        timeRangeCustomerPeriods.set(c.locationId, { customerStartAt, customerEndAt });
      } catch (err) {
        if (err instanceof LocalToUtcError) {
          throw new PublicSearchError(
            'INVALID_LOCAL_TIME',
            'Une heure locale demandée est inexistante ou ambiguë dans le fuseau du lieu.',
            { cause: err },
          );
        }
        throw err;
      }
    }
  }

  // 2. Charger le contexte pricing en batch pour toutes les locations candidates.
  const pricingContexts = await loadPricingContextsBatch(
    db,
    candidates,
    input.intent,
    input.locale,
    timeRangeCustomerPeriods,
  );

  // 3. Calculer le prix pour chaque candidate et obtenir les bornes exactes de la période.
  const pricedByCandidate = new Map<string, { price: PublicPriceSummary; best: Candidate }>();
  const candidateBlockedPeriods = new Map<string, BlockedPeriod>();

  for (const candidate of candidates) {
    const ctx = pricingContexts.get(candidate.locationId);
    if (!ctx) continue;

    try {
      const priced = computePriceForCandidate(ctx, candidate.variantId);
      if (!priced) continue;

      const period = resolveCandidateBlockedPeriod(input.intent, candidate, priced.best);
      if (!period) continue;

      pricedByCandidate.set(`${candidate.variantId}:${candidate.locationId}`, priced);
      candidateBlockedPeriods.set(`${candidate.variantId}:${candidate.locationId}`, {
        blockedStartAt: period.blockedStartAt,
        blockedEndAt: period.blockedEndAt,
      });
    } catch (err) {
      if (err instanceof FlexiblePricingError) {
        // NO_ELIGIBLE_PLAN, OUTSIDE_OPENING_HOURS, LOCATION_CLOSED, UNSUPPORTED_LOCALE → skip.
        if (
          err.code === 'NO_ELIGIBLE_PLAN' ||
          err.code === 'OUTSIDE_OPENING_HOURS' ||
          err.code === 'LOCATION_CLOSED' ||
          err.code === 'UNSUPPORTED_LOCALE'
        ) {
          continue;
        }
      }
      if (err instanceof LocalToUtcError) {
        throw new PublicSearchError(
          'INVALID_LOCAL_TIME',
          'Une heure locale demandée est inexistante ou ambiguë dans le fuseau du lieu.',
          { cause: err },
        );
      }
      throw new PublicSearchError(
        'PRICING_UNAVAILABLE',
        'Le calcul du prix est temporairement indisponible.',
        { cause: err },
      );
    }
  }

  // 4. Vérifier la disponibilité en batch avec les périodes exactes.
  const availabilityMap = await checkAvailabilityBatch(db, candidates, candidateBlockedPeriods);

  // 5. Filtrer les candidates disponibles + appliquer le gating de publication en batch.
  const availableBeforeGate = candidates.filter((c) =>
    availabilityMap.get(`${c.variantId}:${c.locationId}`),
  );

  if (availableBeforeGate.length === 0) {
    return [];
  }

  const productIds = [...new Set(availableBeforeGate.map((c) => c.productId))];
  const eligibleProductIds = await options.publicationGate.filterEligibleProductIds(db, productIds);
  const availableCandidates = availableBeforeGate.filter((c) =>
    eligibleProductIds.has(c.productId),
  );

  if (availableCandidates.length === 0) {
    return [];
  }

  // 6. Associer le prix précalculé aux candidates disponibles.
  const pricedOffers: Array<{
    candidate: CandidateRow;
    price: PublicPriceSummary;
    best: Candidate;
  }> = [];

  for (const candidate of availableCandidates) {
    const priced = pricedByCandidate.get(`${candidate.variantId}:${candidate.locationId}`);
    if (priced) {
      pricedOffers.push({ candidate, price: priced.price, best: priced.best });
    }
  }

  // 7. Grouper par (publicProductId, publicLocationId) → sélectionner le moins cher.
  const groupedOffers = groupAndSelectBest(pricedOffers, destination, searchArea);

  // 8. Trier par (rawDistanceMeters ASC, publicProductId ASC, publicLocationId ASC).
  groupedOffers.sort((a, b) => {
    if (a.rawDistanceMeters !== b.rawDistanceMeters) {
      return a.rawDistanceMeters - b.rawDistanceMeters;
    }
    if (a.publicProductId < b.publicProductId) return -1;
    if (a.publicProductId > b.publicProductId) return 1;
    if (a.publicLocationId < b.publicLocationId) return -1;
    if (a.publicLocationId > b.publicLocationId) return 1;
    return 0;
  });

  return groupedOffers;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

function validateInput(input: SearchPublicOffersInput): void {
  if (!input.destinationPublicId || !UUID_RE.test(input.destinationPublicId)) {
    throw new PublicSearchError('INVALID_INPUT', 'destinationPublicId est un UUID invalide.');
  }
  if (!input.locale || typeof input.locale !== 'string' || input.locale.trim().length === 0) {
    throw new PublicSearchError('INVALID_INPUT', 'locale est requis.');
  }
  if (!LOCALE_RE.test(canonicalizeLocale(input.locale))) {
    throw new PublicSearchError('INVALID_INPUT', 'locale invalide.');
  }
  if (input.categoryId !== undefined && !UUID_RE.test(input.categoryId)) {
    throw new PublicSearchError('INVALID_INPUT', 'categoryId doit être un UUID valide.');
  }
  if (input.viewport !== undefined && !isValidPublicSearchViewport(input.viewport)) {
    throw new PublicSearchError('INVALID_INPUT', 'viewport invalide.');
  }
  if (!input.intent || (input.intent.kind !== 'TIME_RANGE' && input.intent.kind !== 'DAY_RANGE')) {
    throw new PublicSearchError('INVALID_INPUT', 'intent invalide.');
  }
  if (input.intent.kind === 'TIME_RANGE') {
    validateTimeRange(input.intent.startAt, input.intent.endAt);
  } else {
    validateDayRange(input.intent.startDate, input.intent.endDateExclusive);
  }
  if (input.pageSize !== undefined) {
    if (
      !Number.isSafeInteger(input.pageSize) ||
      input.pageSize < MIN_PAGE_SIZE ||
      input.pageSize > MAX_PAGE_SIZE
    ) {
      throw new PublicSearchError(
        'INVALID_INPUT',
        `pageSize doit être entre ${MIN_PAGE_SIZE} et ${MAX_PAGE_SIZE}.`,
      );
    }
  }
  if (
    input.cursor !== undefined &&
    (typeof input.cursor !== 'string' || input.cursor.length === 0)
  ) {
    throw new PublicSearchError('INVALID_INPUT', 'cursor invalide.');
  }
}

function validateTimeRange(startAt: string, endAt: string): void {
  let start: ReturnType<typeof parseLocalDateTimeString>;
  let end: ReturnType<typeof parseLocalDateTimeString>;
  try {
    start = parseLocalDateTimeString(startAt);
    end = parseLocalDateTimeString(endAt);
  } catch {
    throw new PublicSearchError('INVALID_INPUT', 'TIME_RANGE : format de date/heure invalide.');
  }
  if (localToComparable(start) >= localToComparable(end)) {
    throw new PublicSearchError(
      'INVALID_INPUT',
      'TIME_RANGE : la période doit être strictement positive.',
    );
  }
}

function validateDayRange(startDate: string, endDateExclusive: string): void {
  let start: ReturnType<typeof parseLocalDateTimeString>;
  let end: ReturnType<typeof parseLocalDateTimeString>;
  try {
    start = parseLocalDateTimeString(startDate + 'T00:00:00');
    end = parseLocalDateTimeString(endDateExclusive + 'T00:00:00');
  } catch {
    throw new PublicSearchError('INVALID_INPUT', 'DAY_RANGE : format de date invalide.');
  }
  const startDay = civilDayNumber(start.year, start.month, start.day);
  const endDay = civilDayNumber(end.year, end.month, end.day);
  if (endDay <= startDay) {
    throw new PublicSearchError(
      'INVALID_INPUT',
      'DAY_RANGE : endDateExclusive doit être postérieure à startDate.',
    );
  }
}

function localToComparable(local: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}): number {
  const day = civilDayNumber(local.year, local.month, local.day);
  return day * 24 * 60 + local.hour * 60 + local.minute + local.second / 60;
}

// ─────────────────────────────────────────────────────────────────────────────
// Destination loading
// ─────────────────────────────────────────────────────────────────────────────

interface DestinationInfo {
  centerLongitude: number;
  centerLatitude: number;
  bboxSouth: number;
  bboxWest: number;
  bboxNorth: number;
  bboxEast: number;
}

/** Zone effectivement utilisée par SQL et par le calcul de distance. */
interface SearchArea {
  /** La destination utilise les paliers 10/25/50 km ; le viewport reste explicite. */
  kind: 'DESTINATION_RADIUS' | 'VIEWPORT';
  centerLongitude: number;
  centerLatitude: number;
  bboxSouth: number;
  bboxWest: number;
  bboxNorth: number;
  bboxEast: number;
}

function resolveSearchArea(
  destination: DestinationInfo,
  viewport: SearchPublicOffersInput['viewport'],
): SearchArea {
  if (!viewport) {
    return {
      kind: 'DESTINATION_RADIUS',
      centerLongitude: destination.centerLongitude,
      centerLatitude: destination.centerLatitude,
      bboxSouth: destination.bboxSouth,
      bboxWest: destination.bboxWest,
      bboxNorth: destination.bboxNorth,
      bboxEast: destination.bboxEast,
    };
  }

  const normalized = normalizePublicSearchViewport(viewport);
  const center = publicSearchViewportCenter(normalized);
  return {
    kind: 'VIEWPORT',
    centerLongitude: center.longitude,
    centerLatitude: center.latitude,
    bboxSouth: normalized.south,
    bboxWest: normalized.west,
    bboxNorth: normalized.north,
    bboxEast: normalized.east,
  };
}

async function loadDestination(
  db: DatabaseClient,
  publicId: string,
  locale: string,
): Promise<DestinationInfo> {
  const destRows = await db
    .select({
      id: destinations.id,
      isActive: destinations.isActive,
      deletedAt: destinations.deletedAt,
      countryCode: destinations.countryCode,
      bboxSouth: destinations.bboxSouth,
      bboxWest: destinations.bboxWest,
      bboxNorth: destinations.bboxNorth,
      bboxEast: destinations.bboxEast,
    })
    .from(destinations)
    .where(eq(destinations.publicId, publicId))
    .limit(1);

  if (destRows.length === 0) {
    throw new PublicSearchError('DESTINATION_NOT_FOUND', 'Destination introuvable.');
  }

  const dest = destRows[0]!;

  if (dest.deletedAt !== null) {
    throw new PublicSearchError('DESTINATION_NOT_FOUND', 'Destination introuvable.');
  }

  if (!dest.isActive) {
    throw new PublicSearchError('DESTINATION_INACTIVE', 'Destination inactive.');
  }

  // Vérifier le pays actif.
  const countryRows = await db
    .select({ isActive: countries.isActive })
    .from(countries)
    .where(eq(countries.countryCode, dest.countryCode))
    .limit(1);

  if (countryRows.length === 0 || !countryRows[0]!.isActive) {
    throw new PublicSearchError('COUNTRY_INACTIVE', 'Pays inactive.');
  }

  // Charger le centre de la destination via ST_X/ST_Y.
  const centerRows = await db.execute<{ longitude: number; latitude: number }>(sql`
    SELECT ST_X(center) AS longitude, ST_Y(center) AS latitude
    FROM destinations WHERE id = ${dest.id}::uuid
  `);
  const center = centerRows[0]!;

  // Charger la traduction pour valider la locale.
  const translationRows = await db
    .select({ locale: destinationTranslations.locale })
    .from(destinationTranslations)
    .where(eq(destinationTranslations.destinationId, dest.id));

  const availableLocales = translationRows.map((t) => t.locale);
  try {
    resolveLocale(locale, availableLocales);
  } catch (err) {
    if (err instanceof FlexiblePricingError && err.code === 'UNSUPPORTED_LOCALE') {
      throw new PublicSearchError('INVALID_INPUT', 'Locale non supportée pour cette destination.');
    }
    throw err;
  }

  return {
    centerLongitude: center.longitude,
    centerLatitude: center.latitude,
    bboxSouth: dest.bboxSouth,
    bboxWest: dest.bboxWest,
    bboxNorth: dest.bboxNorth,
    bboxEast: dest.bboxEast,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Category tree resolution
// ─────────────────────────────────────────────────────────────────────────────

async function resolveCategoryTree(db: DatabaseClient, categoryId: string): Promise<string[]> {
  const catRows = await db
    .select({ id: categories.id, isActive: categories.isActive, slug: categories.slug })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1);

  if (catRows.length === 0) {
    throw new PublicSearchError('CATEGORY_NOT_FOUND', 'Catégorie introuvable.');
  }

  if (!catRows[0]!.isActive) {
    throw new PublicSearchError('CATEGORY_INACTIVE', 'Catégorie inactive.');
  }

  if (isHistoricalPaddleCategorySlug(catRows[0]!.slug)) {
    throw new PublicSearchError('CATEGORY_INACTIVE', 'Catégorie inactive.');
  }

  // Récursion bornée via WITH RECURSIVE (anti-cycle défensif, profondeur ≤ 10).
  const descendantRows = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE category_tree AS (
      SELECT id, 0 AS depth FROM categories WHERE id = ${categoryId}::uuid
      UNION ALL
      SELECT c.id, ct.depth + 1
      FROM categories c
      INNER JOIN category_tree ct ON c.parent_id = ct.id
      WHERE c.is_active = true AND ct.depth < ${MAX_CATEGORY_DEPTH}
    )
    SELECT id FROM category_tree
  `);

  return descendantRows.map((r) => r.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate loading (set-based SQL query)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Groupe de candidates DISTINCT sur (publicProductId, publicLocationId).
 *
 * La première requête SQL charge uniquement ces groupes (LIMIT, keyset), sans
 * exploser sur les variantes. Les variantes sont ensuite chargées en batch
 * dans loadCandidateVariantRows, bornées par le même nombre de groupes.
 */
interface CandidateGroup {
  organizationId: string;
  locationId: string;
  productId: string;
  publicProductId: string;
  publicLocationId: string;
  organizationPublicDisplayName: string;
  productName: string;
  locationName: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  postalCode: string | null;
  countryCode: string;
  latitude: number;
  longitude: number;
  rawDistanceMeters: number;
  timeZone: string;
  operatingCurrency: string;
  prepBufferMinutes: number;
  cleanupBufferMinutes: number;
}

/**
 * Charge les groupes (publicProductId, publicLocationId) éligibles en appliquant
 * directement le filtre keyset, le ORDER BY et le LIMIT dans PostgreSQL.
 *
 * Aucun offset n'est utilisé. La condition keyset s'exprime sur le tuple
 * (raw_distance_meters, p.public_id, l.public_id) par row-constructor.
 */
async function loadCandidateGroups(
  db: DatabaseClient,
  searchArea: SearchArea,
  eligibleCategoryIds: string[] | null,
  keyset: KeysetTuple | null,
  limit: number,
): Promise<CandidateGroup[]> {
  const categoryCondition =
    eligibleCategoryIds !== null && eligibleCategoryIds.length > 0
      ? sql`AND p.category_id IN (
        SELECT value::uuid
        FROM jsonb_array_elements_text(${JSON.stringify(eligibleCategoryIds)}::jsonb) AS value
      )`
      : sql``;

  const keysetCondition =
    keyset !== null
      ? sql`AND (el.raw_distance_meters, p.public_id, el.public_id) > (
        ${keyset.rawDistanceMeters},
        CAST(${keyset.publicProductId} AS uuid),
        CAST(${keyset.publicLocationId} AS uuid)
      )`
      : sql``;

  // Filtre spatial via ST_Intersects (frontière incluse) pour utiliser l'index
  // GIST. Sans viewport, la bbox exacte reste prioritaire et les offres hors
  // bbox sont autorisées jusqu'au dernier palier de 50 km.
  const exactBboxCondition =
    searchArea.bboxWest <= searchArea.bboxEast
      ? sql`ST_Intersects(l.geo_point, ST_MakeEnvelope(${searchArea.bboxWest}, ${searchArea.bboxSouth}, ${searchArea.bboxEast}, ${searchArea.bboxNorth}, 4326))`
      : sql`(
            ST_Intersects(l.geo_point, ST_MakeEnvelope(${searchArea.bboxWest}, ${searchArea.bboxSouth}, 180, ${searchArea.bboxNorth}, 4326))
            OR ST_Intersects(l.geo_point, ST_MakeEnvelope(-180, ${searchArea.bboxSouth}, ${searchArea.bboxEast}, ${searchArea.bboxNorth}, 4326))
          )`;
  const spatialCondition =
    searchArea.kind === 'DESTINATION_RADIUS'
      ? sql`AND (
          ${exactBboxCondition}
          OR ST_DWithin(
            l.geo_point::geography,
            ST_SetSRID(ST_MakePoint(${searchArea.centerLongitude}, ${searchArea.centerLatitude}), 4326)::geography,
            50000
          )
        )`
      : sql`AND ${exactBboxCondition}`;

  const rows = await db.execute<{
    organization_id: string;
    location_id: string;
    product_id: string;
    public_product_id: string;
    public_location_id: string;
    organization_public_display_name: string;
    product_name: string;
    location_name: string;
    address_line1: string;
    address_line2: string | null;
    city: string;
    postal_code: string | null;
    country_code: string;
    latitude: number;
    longitude: number;
    raw_distance_meters: number;
    time_zone: string;
    operating_currency: string;
    prep_buffer_minutes: number;
    cleanup_buffer_minutes: number;
  }>(sql`
    WITH eligible_locations AS (
      SELECT
        l.id,
        l.public_id,
        l.organization_id,
        l.name,
        l.address_line1,
        l.address_line2,
        l.city,
        l.postal_code,
        l.country_code,
        l.geo_point,
        l.time_zone,
        l.operating_currency,
        l.prep_buffer_minutes,
        l.cleanup_buffer_minutes,
        ST_X(l.geo_point) AS longitude,
        ST_Y(l.geo_point) AS latitude,
        ST_Distance(
          l.geo_point::geography,
          ST_SetSRID(ST_MakePoint(${searchArea.centerLongitude}, ${searchArea.centerLatitude}), 4326)::geography
        ) AS raw_distance_meters
      FROM locations l
      INNER JOIN organizations o ON l.organization_id = o.id
      INNER JOIN countries c ON l.country_code = c.country_code
      WHERE l.is_publicly_listed = true
        AND l.pickup_enabled = true
        AND l.geo_point IS NOT NULL
        AND l.deleted_at IS NULL
        -- Filtre opérationnel EUR imposé par le contrat G7D-A (MVP France). Le support multi-devise sortira via ADR dédiée.
        AND l.operating_currency = 'EUR'
        AND o.status = 'ACTIVE'
        AND o.deleted_at IS NULL
        AND o.public_display_name IS NOT NULL
        AND btrim(o.public_display_name) <> ''
        AND c.is_active = true
        ${spatialCondition}
    )
    SELECT
      el.organization_id,
      el.id AS location_id,
      p.id AS product_id,
      p.public_id AS public_product_id,
      el.public_id AS public_location_id,
      o.public_display_name AS organization_public_display_name,
      p.name AS product_name,
      el.name AS location_name,
      el.address_line1,
      el.address_line2,
      el.city,
      el.postal_code,
      el.country_code,
      el.latitude,
      el.longitude,
      el.raw_distance_meters,
      el.time_zone,
      el.operating_currency,
      el.prep_buffer_minutes,
      el.cleanup_buffer_minutes
    FROM eligible_locations el
    INNER JOIN organizations o ON el.organization_id = o.id
    INNER JOIN products p ON p.organization_id = el.organization_id
    INNER JOIN categories category ON category.id = p.category_id
    WHERE p.publication_status = 'PUBLISHED'
      AND p.deleted_at IS NULL
      AND p.public_id IS NOT NULL
      AND category.slug NOT IN (
        ${PADDLE_CATEGORY_CONTRACT.historicalStorageSlugs[0]}
      )
      AND EXISTS (
        SELECT 1
        FROM product_variants pv
        INNER JOIN inventory_items ii ON ii.product_variant_id = pv.id
        WHERE pv.product_id = p.id
          AND pv.is_active = true
          AND pv.deleted_at IS NULL
          AND ii.current_location_id = el.id
          AND ii.organization_id = p.organization_id
          AND ii.status = 'ACTIVE'
          AND ii.deleted_at IS NULL
          AND ii.condition IN ('NEW', 'GOOD', 'FAIR')
      )
      ${categoryCondition}
      ${keysetCondition}
    ORDER BY el.raw_distance_meters ASC, p.public_id ASC, el.public_id ASC
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    organizationId: r.organization_id,
    locationId: r.location_id,
    productId: r.product_id,
    publicProductId: r.public_product_id,
    publicLocationId: r.public_location_id,
    organizationPublicDisplayName: r.organization_public_display_name,
    productName: r.product_name,
    locationName: r.location_name,
    addressLine1: r.address_line1,
    addressLine2: r.address_line2,
    city: r.city,
    postalCode: r.postal_code,
    countryCode: r.country_code,
    latitude: r.latitude,
    longitude: r.longitude,
    rawDistanceMeters: r.raw_distance_meters,
    timeZone: r.time_zone,
    operatingCurrency: r.operating_currency,
    prepBufferMinutes: r.prep_buffer_minutes,
    cleanupBufferMinutes: r.cleanup_buffer_minutes,
  }));
}

/**
 * Charge les variantes/plans pour les groupes sélectionnés en une seule requête
 * ensembliste. Le nombre de lignes retournées est le nombre de (variante ×
 * groupe) éligibles, pas plus que le LIMIT initial de groupes.
 */
async function loadCandidateVariantRows(
  db: DatabaseClient,
  groups: CandidateGroup[],
): Promise<CandidateRow[]> {
  if (groups.length === 0) {
    return [];
  }

  const groupJson = JSON.stringify(
    groups.map((g) => ({
      product_id: g.productId,
      location_id: g.locationId,
      raw_distance_meters: g.rawDistanceMeters,
    })),
  );

  const rows = await db.execute<{
    organization_id: string;
    location_id: string;
    product_id: string;
    variant_id: string;
    public_product_id: string;
    public_location_id: string;
    organization_public_display_name: string;
    product_name: string;
    location_name: string;
    address_line1: string;
    address_line2: string | null;
    city: string;
    postal_code: string | null;
    country_code: string;
    latitude: number;
    longitude: number;
    raw_distance_meters: number;
    time_zone: string;
    operating_currency: string;
    prep_buffer_minutes: number;
    cleanup_buffer_minutes: number;
  }>(sql`
    WITH groups AS (
      SELECT
        (g->>'product_id')::uuid AS product_id,
        (g->>'location_id')::uuid AS location_id,
        (g->>'raw_distance_meters')::double precision AS raw_distance_meters
      FROM jsonb_array_elements(${groupJson}::jsonb) AS g
    )
    SELECT
      p.organization_id,
      l.id AS location_id,
      p.id AS product_id,
      pv.id AS variant_id,
      p.public_id AS public_product_id,
      l.public_id AS public_location_id,
      o.public_display_name AS organization_public_display_name,
      p.name AS product_name,
      l.name AS location_name,
      l.address_line1,
      l.address_line2,
      l.city,
      l.postal_code,
      l.country_code,
      ST_X(l.geo_point) AS longitude,
      ST_Y(l.geo_point) AS latitude,
      g.raw_distance_meters,
      l.time_zone,
      l.operating_currency,
      l.prep_buffer_minutes,
      l.cleanup_buffer_minutes
    FROM groups g
    INNER JOIN products p ON p.id = g.product_id
    INNER JOIN locations l ON l.id = g.location_id
    INNER JOIN organizations o ON o.id = p.organization_id
    INNER JOIN product_variants pv ON pv.product_id = p.id
    WHERE pv.is_active = true
      AND pv.deleted_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM inventory_items ii
        WHERE ii.product_variant_id = pv.id
          AND ii.current_location_id = l.id
          AND ii.organization_id = p.organization_id
          AND ii.status = 'ACTIVE'
          AND ii.deleted_at IS NULL
          AND ii.condition IN ('NEW', 'GOOD', 'FAIR')
      )
    ORDER BY g.raw_distance_meters ASC, p.public_id ASC, l.public_id ASC, pv.id ASC
  `);

  return rows.map((r) => ({
    organizationId: r.organization_id,
    locationId: r.location_id,
    productId: r.product_id,
    variantId: r.variant_id,
    publicProductId: r.public_product_id,
    publicLocationId: r.public_location_id,
    organizationPublicDisplayName: r.organization_public_display_name,
    productName: r.product_name,
    locationName: r.location_name,
    addressLine1: r.address_line1,
    addressLine2: r.address_line2,
    city: r.city,
    postalCode: r.postal_code,
    countryCode: r.country_code,
    latitude: r.latitude,
    longitude: r.longitude,
    rawDistanceMeters: r.raw_distance_meters,
    timeZone: r.time_zone,
    operatingCurrency: r.operating_currency,
    prepBufferMinutes: r.prep_buffer_minutes,
    cleanupBufferMinutes: r.cleanup_buffer_minutes,
  }));
}

/**
 * Charge les candidates du prochain batch keyset avec lookahead SQL.
 *
 * 1. Sélectionne d'abord les groupes DISTINCT (publicProductId, publicLocationId)
 *    avec la condition keyset, ORDER BY et LIMIT = scanCapacity + 1.
 *    Le groupe supplémentaire (le scanCapacity+1-ième) sert UNIQUEMENT de preuve
 *    qu'une suite existe après le lot traité. Il n'est JAMAIS inclus dans les
 *    candidates ni dans lastScanned.
 * 2. Traite uniquement les `scanCapacity` premiers groupes (slice sur les groupes
 *    AVANT de charger les variantes — exception autorisée à la règle "pas de
 *    slice de pagination" car ce slice segmente le lot SQL, ne pagine pas les
 *    résultats finaux).
 * 3. Charge en batch toutes les variantes éligibles pour les groupes traités.
 * 4. Retourne :
 *    - candidates : les CandidateRow des groupes traités uniquement.
 *    - lastScanned : le tuple du DERNIER groupe TRAITÉ (le scanCapacity-ième),
 *      pas du lookahead.
 *    - hasMoreGroupsAfterBatch : true si un lookahead a été trouvé (un
 *      scanCapacity+1-ième groupe existe dans PostgreSQL).
 *    - sourceExhausted : true si aucun lookahead et 0..scanCapacity groupes
 *      (la source PostgreSQL est réellement épuisée).
 */
async function loadCandidates(
  db: DatabaseClient,
  searchArea: SearchArea,
  eligibleCategoryIds: string[] | null,
  keyset: KeysetTuple | null,
  scanCapacity: number,
): Promise<{
  candidates: CandidateRow[];
  lastScanned: KeysetTuple | null;
  hasMoreGroupsAfterBatch: boolean;
  sourceExhausted: boolean;
}> {
  const groups = await loadCandidateGroups(
    db,
    searchArea,
    eligibleCategoryIds,
    keyset,
    scanCapacity + 1,
  );
  if (groups.length === 0) {
    return {
      candidates: [],
      lastScanned: null,
      hasMoreGroupsAfterBatch: false,
      sourceExhausted: true,
    };
  }

  const hasMoreGroupsAfterBatch = groups.length > scanCapacity;
  // Slice autorisé : segmente le lot SQL (lookahead), ne pagine pas les résultats finaux.
  const treatedGroups = hasMoreGroupsAfterBatch ? groups.slice(0, scanCapacity) : groups;

  const candidates = await loadCandidateVariantRows(db, treatedGroups);
  const lastTreatedGroup = treatedGroups[treatedGroups.length - 1]!;

  return {
    candidates,
    lastScanned: {
      rawDistanceMeters: lastTreatedGroup.rawDistanceMeters,
      publicProductId: lastTreatedGroup.publicProductId,
      publicLocationId: lastTreatedGroup.publicLocationId,
    },
    hasMoreGroupsAfterBatch,
    sourceExhausted: !hasMoreGroupsAfterBatch,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Period resolution per candidate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Résout la période exacte (client et bloquée avec buffers) pour une candidate.
 *
 * TIME_RANGE : utilise les bornes locales demandées converties par le fuseau IANA de la location.
 * DAY_RANGE : utilise les dayRangeBoundaries du plan DAILY retenu par computeQuote.
 * Aucune approximation 00:00→23:59:59.
 *
 * @throws LocalToUtcError si l'heure locale est inexistante ou ambiguë.
 */
function resolveCandidateBlockedPeriod(
  intent: PublicSearchIntent,
  candidate: CandidateRow,
  best: Candidate,
): { customerStartAt: Date; customerEndAt: Date; blockedStartAt: Date; blockedEndAt: Date } | null {
  if (intent.kind === 'TIME_RANGE') {
    const customerStartAt = localDateTimeStringToUtc(intent.startAt, candidate.timeZone);
    const customerEndAt = localDateTimeStringToUtc(intent.endAt, candidate.timeZone);
    const blockedStartAt = new Date(
      customerStartAt.getTime() - candidate.prepBufferMinutes * 60 * 1000,
    );
    const blockedEndAt = new Date(
      customerEndAt.getTime() + candidate.cleanupBufferMinutes * 60 * 1000,
    );
    return { customerStartAt, customerEndAt, blockedStartAt, blockedEndAt };
  }

  // DAY_RANGE : bornes exactes du plan DAILY retenu.
  const boundaries = best.dayRangeBoundaries;
  if (!boundaries) return null;

  const startParts = parseDateString(boundaries.firstDay.localDate);
  const startTimeParts = parseTimeString(boundaries.firstDay.startTime);
  const customerStartAt = localDateTimeToUtc(
    {
      year: startParts.year,
      month: startParts.month,
      day: startParts.day,
      hour: startTimeParts.hour,
      minute: startTimeParts.minute,
      second: 0,
    },
    candidate.timeZone,
  );

  const endParts = parseDateString(boundaries.lastDay.localDate);
  const endTimeParts = parseTimeString(boundaries.lastDay.endTime);
  const customerEndAt = localDateTimeToUtc(
    {
      year: endParts.year,
      month: endParts.month,
      day: endParts.day,
      hour: endTimeParts.hour,
      minute: endTimeParts.minute,
      second: 0,
    },
    candidate.timeZone,
  );

  const blockedStartAt = new Date(
    customerStartAt.getTime() - candidate.prepBufferMinutes * 60 * 1000,
  );
  const blockedEndAt = new Date(
    customerEndAt.getTime() + candidate.cleanupBufferMinutes * 60 * 1000,
  );
  return { customerStartAt, customerEndAt, blockedStartAt, blockedEndAt };
}

/** Parse une heure HH:MM:SS. */
function parseTimeString(timeStr: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(timeStr);
  if (!match) {
    throw new PublicSearchError('INVALID_INPUT', 'Format de heure invalide.');
  }
  return {
    hour: parseInt(match[1]!, 10),
    minute: parseInt(match[2]!, 10),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Availability checking (batch)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vérifie la disponibilité de chaque candidate en batch.
 *
 * Pour chaque (variantId, locationId), on vérifie qu'au moins un exemplaire
 * n'a AUCUN bloc ACTIVE/PAYMENT_PROCESSING chevauchant la période bloquée
 * (customerStartAt - prepBuffer, customerEndAt + cleanupBuffer).
 *
 * Les blocs MAINTENANCE avec status ACTIVE sont inclus dans le filtre
 * (status IN ('ACTIVE', 'PAYMENT_PROCESSING') capture les maintenances actives).
 *
 * On n'expose jamais la quantité disponible, le nombre d'exemplaires,
 * les IDs d'inventaire, les SKU ou les détails des blocs.
 */
interface BlockedPeriod {
  blockedStartAt: Date;
  blockedEndAt: Date;
}

async function checkAvailabilityBatch(
  db: DatabaseClient,
  candidates: CandidateRow[],
  candidateBlockedPeriods: Map<string, BlockedPeriod>,
): Promise<Map<string, boolean>> {
  const availabilityMap = new Map<string, boolean>();

  interface AvailabilityParam {
    organization_id: string;
    product_variant_id: string;
    location_id: string;
    blocked_start_at: string;
    blocked_end_at: string;
  }

  const params: AvailabilityParam[] = [];
  for (const c of candidates) {
    const resolved = candidateBlockedPeriods.get(`${c.variantId}:${c.locationId}`);
    if (!resolved) continue;
    params.push({
      organization_id: c.organizationId,
      product_variant_id: c.variantId,
      location_id: c.locationId,
      blocked_start_at: resolved.blockedStartAt.toISOString(),
      blocked_end_at: resolved.blockedEndAt.toISOString(),
    });
  }

  if (params.length === 0) {
    return availabilityMap;
  }

  const rows = await db.execute<{
    organization_id: string;
    product_variant_id: string;
    location_id: string;
    available: boolean;
  }>(sql`
    WITH params AS (
      SELECT
        (p->>'organization_id')::uuid AS organization_id,
        (p->>'product_variant_id')::uuid AS product_variant_id,
        (p->>'location_id')::uuid AS location_id,
        (p->>'blocked_start_at')::timestamptz AS blocked_start_at,
        (p->>'blocked_end_at')::timestamptz AS blocked_end_at
      FROM jsonb_array_elements(${JSON.stringify(params)}::jsonb) AS p
    )
    SELECT
      params.organization_id,
      params.product_variant_id,
      params.location_id,
      EXISTS (
        SELECT 1
        FROM inventory_items ii
        WHERE ii.organization_id = params.organization_id
          AND ii.product_variant_id = params.product_variant_id
          AND ii.current_location_id = params.location_id
          AND ii.status = 'ACTIVE'
          AND ii.deleted_at IS NULL
          AND ii.condition IN ('NEW', 'GOOD', 'FAIR')
          AND NOT EXISTS (
            SELECT 1 FROM inventory_blocks ib
            WHERE ib.inventory_item_id = ii.id
              AND ib.deleted_at IS NULL
              AND ib.status IN ('ACTIVE', 'PAYMENT_PROCESSING')
              AND tstzrange(ib.blocked_start_at, ib.blocked_end_at) && tstzrange(params.blocked_start_at, params.blocked_end_at)
          )
      ) AS available
    FROM params
  `);

  for (const row of rows) {
    availabilityMap.set(`${row.product_variant_id}:${row.location_id}`, row.available);
  }

  return availabilityMap;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pricing context loading (batch)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Charge les contextes de pricing en batch pour toutes les locations candidates.
 *
 * Appelle resolve_effective_pricing_plans pour toutes les locations en une seule
 * requête ensembliste (CROSS JOIN LATERAL), puis charge en batch les fenêtres,
 * paliers et traductions pour tous les plan IDs retournés. Les horaires
 * d'ouverture sont chargés en batch.
 */
async function loadPricingContextsBatch(
  db: DatabaseClient,
  candidates: CandidateRow[],
  intent: PublicSearchIntent,
  locale: string,
  timeRangeCustomerPeriods: Map<string, { customerStartAt: Date; customerEndAt: Date }>,
): Promise<Map<string, PricingContext>> {
  const contexts = new Map<string, PricingContext>();

  const locationIds = [...new Set(candidates.map((c) => c.locationId))];

  // Une seule requête CTE : tous les location_id en jsonb_array_elements_text,
  // puis CROSS JOIN LATERAL resolve_effective_pricing_plans(location_id).
  const allPlans: Array<{ locationId: string; plan: ResolvedPlan }> = [];
  const locationOrgMap = new Map<string, string>();
  const locationCurrencyMap = new Map<string, string>();
  const locationTimeZoneMap = new Map<string, string>();

  for (const locationId of locationIds) {
    const candidate = candidates.find((c) => c.locationId === locationId)!;
    locationOrgMap.set(locationId, candidate.organizationId);
    locationCurrencyMap.set(locationId, candidate.operatingCurrency);
    locationTimeZoneMap.set(locationId, candidate.timeZone);
  }

  if (locationIds.length > 0) {
    const planRows = await db.execute<{
      candidate_location_id: string;
      id: string;
      organization_id: string;
      product_variant_id: string;
      location_id: string | null;
      plan_type: 'HOURLY' | 'FIXED_DURATION' | 'DAILY';
      currency: string;
      price_amount_minor: string | number;
      min_duration_minutes: number | null;
      max_duration_minutes: number | null;
      billing_increment_minutes: number | null;
      included_duration_minutes: number | null;
      internal_label: string | null;
      priority: number;
      lifecycle_state: string;
      version: number;
    }>(sql`
      WITH locs AS (
        SELECT value::uuid AS location_id
        FROM jsonb_array_elements_text(${JSON.stringify(locationIds)}::jsonb) AS value
      )
      SELECT
        locs.location_id AS candidate_location_id,
        p.*
      FROM locs
      CROSS JOIN LATERAL resolve_effective_pricing_plans(locs.location_id) AS p
    `);

    for (const row of planRows) {
      const plan: ResolvedPlan = {
        id: row.id,
        organizationId: row.organization_id,
        productVariantId: row.product_variant_id,
        locationId: row.location_id,
        planType: row.plan_type,
        currency: row.currency,
        priceAmountMinor:
          typeof row.price_amount_minor === 'string'
            ? parseInt(row.price_amount_minor, 10)
            : row.price_amount_minor,
        minDurationMinutes: row.min_duration_minutes,
        maxDurationMinutes: row.max_duration_minutes,
        billingIncrementMinutes: row.billing_increment_minutes,
        includedDurationMinutes: row.included_duration_minutes,
        internalLabel: row.internal_label,
        priority: row.priority,
        version: row.version,
      };
      allPlans.push({ locationId: row.candidate_location_id, plan });
    }
  }

  // Collecter tous les plan IDs.
  const allPlanIds = [...new Set(allPlans.map((p) => p.plan.id))];

  // Charger les fenêtres en batch.
  const windowRows =
    allPlanIds.length > 0
      ? await db
          .select({
            pricingPlanId: pricingPlanWindows.pricingPlanId,
            weekdayMask: pricingPlanWindows.weekdayMask,
            startTime: pricingPlanWindows.startTime,
            endTime: pricingPlanWindows.endTime,
          })
          .from(pricingPlanWindows)
          .where(inArray(pricingPlanWindows.pricingPlanId, allPlanIds))
      : [];

  const windows: ResolvedWindow[] = windowRows.map((r) => ({
    pricingPlanId: r.pricingPlanId,
    weekdayMask: r.weekdayMask,
    startTime: typeof r.startTime === 'string' ? r.startTime : String(r.startTime),
    endTime: typeof r.endTime === 'string' ? r.endTime : String(r.endTime),
  }));

  // Charger les paliers en batch.
  const tierRows =
    allPlanIds.length > 0
      ? await db
          .select({
            pricingPlanId: multiDayDiscountTiers.pricingPlanId,
            thresholdDays: multiDayDiscountTiers.thresholdDays,
            discountPercent: multiDayDiscountTiers.discountPercent,
          })
          .from(multiDayDiscountTiers)
          .where(inArray(multiDayDiscountTiers.pricingPlanId, allPlanIds))
      : [];

  const tiers: ResolvedTier[] = tierRows.map((r) => ({
    pricingPlanId: r.pricingPlanId,
    thresholdDays: r.thresholdDays,
    discountPercent: r.discountPercent,
  }));

  // Charger les traductions en batch.
  const translationRows =
    allPlanIds.length > 0
      ? await db
          .select({
            pricingPlanId: pricingPlanTranslations.pricingPlanId,
            locale: pricingPlanTranslations.locale,
            publicLabel: pricingPlanTranslations.publicLabel,
          })
          .from(pricingPlanTranslations)
          .where(inArray(pricingPlanTranslations.pricingPlanId, allPlanIds))
      : [];

  const translations: ResolvedTranslation[] = translationRows.map((r) => ({
    pricingPlanId: r.pricingPlanId,
    locale: r.locale,
    publicLabel: r.publicLabel,
  }));

  // Charger les horaires d'ouverture en batch.
  const openingHourRows = await db
    .select({
      locationId: locationOpeningHours.locationId,
      weekday: locationOpeningHours.weekday,
      openTime: locationOpeningHours.openTime,
      closeTime: locationOpeningHours.closeTime,
    })
    .from(locationOpeningHours)
    .where(inArray(locationOpeningHours.locationId, locationIds));

  const openingHoursByLocation = new Map<string, OpeningHour[]>();
  for (const r of openingHourRows) {
    const arr = openingHoursByLocation.get(r.locationId) ?? [];
    arr.push({
      weekday: r.weekday,
      openTime: typeof r.openTime === 'string' ? r.openTime : String(r.openTime),
      closeTime: typeof r.closeTime === 'string' ? r.closeTime : String(r.closeTime),
    });
    openingHoursByLocation.set(r.locationId, arr);
  }

  // Charger les exceptions de calendrier en batch (Chantier 15.1).
  const exceptionRows = await db
    .select()
    .from(locationScheduleExceptions)
    .where(inArray(locationScheduleExceptions.locationId, locationIds));

  const scheduleExceptionsByLocation = new Map<
    string,
    import('../identity/types').LocationScheduleExceptionRecord[]
  >();
  for (const r of exceptionRows) {
    const arr = scheduleExceptionsByLocation.get(r.locationId) ?? [];
    arr.push({
      id: r.id,
      organizationId: r.organizationId,
      locationId: r.locationId,
      localDate: r.localDate,
      kind: r.kind,
      openTime: r.openTime,
      closeTime: r.closeTime,
      reason: r.reason,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
    scheduleExceptionsByLocation.set(r.locationId, arr);
  }

  // Construire le contexte pricing pour chaque location.
  for (const locationId of locationIds) {
    const orgId = locationOrgMap.get(locationId)!;
    const currency = locationCurrencyMap.get(locationId)!;
    const timeZone = locationTimeZoneMap.get(locationId)!;
    const timeRangeResolved = timeRangeCustomerPeriods.get(locationId);

    const locationPlans = allPlans.filter((p) => p.locationId === locationId).map((p) => p.plan);

    const resolvedIntent: ResolvedFlexiblePricingIntent =
      intent.kind === 'TIME_RANGE'
        ? {
            kind: 'TIME_RANGE',
            startAt: timeRangeResolved!.customerStartAt,
            endAt: timeRangeResolved!.customerEndAt,
          }
        : {
            kind: 'DAY_RANGE',
            startDate: intent.startDate,
            endDateExclusive: intent.endDateExclusive,
          };

    const locationCandidates = candidates.filter((c) => c.locationId === locationId);
    const variants = new Map<string, { productId: string; organizationId: string }>();
    for (const c of locationCandidates) {
      variants.set(c.variantId, { productId: c.productId, organizationId: c.organizationId });
    }

    const openingHours = openingHoursByLocation.get(locationId) ?? [];
    const scheduleExceptions = scheduleExceptionsByLocation.get(locationId) ?? [];

    contexts.set(locationId, {
      organizationId: orgId,
      locationId,
      currency,
      timeZone,
      intent: resolvedIntent,
      plans: locationPlans,
      windows,
      tiers,
      translations,
      openingHours,
      scheduleExceptions,
      variants,
      lines: locationCandidates.map((c) => ({ variantId: c.variantId, quantity: 1 })),
      locale,
    });
  }

  return contexts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Price computation for a single candidate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calcule le prix pour une candidate (variante + location) en réutilisant
 * le moteur pricing pur (generateCandidates + calculateAmount + validateGrid
 * + selectBestCandidate).
 *
 * On ne recopie pas une seconde logique de pricing — on réutilise le moteur
 * existant. Aucun fallback vers daily_price_amount_minor.
 *
 * @returns le résumé public du prix, ou null si aucun plan éligible.
 */
export function computePriceForCandidate(
  context: PricingContext,
  variantId: string,
): { price: PublicPriceSummary; best: Candidate } | null {
  // Gate de réservabilité (Chantier 15.2) : valider les horaires d'ouverture et exceptions.
  isWithinOpeningHours(
    context.intent,
    context.timeZone,
    context.openingHours,
    context.scheduleExceptions,
  );

  let candidates = generateCandidates(variantId, 1, context);
  if (candidates.length === 0) {
    if (context.intent.kind === 'DAY_RANGE') {
      const variantPlans = context.plans.filter(
        (p) =>
          p.productVariantId === variantId &&
          p.currency === context.currency &&
          p.planType === 'DAILY',
      );
      for (const plan of variantPlans) {
        const firstDayWeekday = getWeekdayFromDate(
          new Date(context.intent.startDate + 'T12:00:00.000Z'),
          context.timeZone,
        );
        const endParts = parseDateString(context.intent.endDateExclusive);
        const endDayNum = civilDayNumber(endParts.year, endParts.month, endParts.day);
        const lastDayNum = endDayNum - 1;
        const lastDayDate = civilDayNumberToDate(lastDayNum);
        const lastDayWeekday = getWeekdayFromDate(
          new Date(lastDayDate + 'T12:00:00.000Z'),
          context.timeZone,
        );

        const rawFirst = findDayRangeWindow(plan.id, context.windows, firstDayWeekday, []);
        const rawLast = findDayRangeWindow(plan.id, context.windows, lastDayWeekday, []);
        if (rawFirst && rawLast) {
          validateDayRangeBoundariesAgainstSchedule(
            {
              kind: 'DAY_RANGE_BOUNDARIES',
              firstDay: {
                localDate: context.intent.startDate,
                weekdayMask: rawFirst.weekdayMask,
                startTime: rawFirst.startTime,
                endTime: rawFirst.endTime,
              },
              lastDay: {
                localDate: lastDayDate,
                weekdayMask: rawLast.weekdayMask,
                startTime: rawLast.startTime,
                endTime: rawLast.endTime,
              },
            },
            context.openingHours,
            context.scheduleExceptions,
            context.locationId,
          );
        }
      }
    }
    return null;
  }

  // Filtrer les candidats incompatibles avec le planning effectif (Chantier 15.2.1 Requirement 10).
  const compatibleCandidates = candidates.filter((c) => {
    if (!c.dayRangeBoundaries) return true;
    return isDayRangeBoundariesCompatibleWithSchedule(
      c.dayRangeBoundaries,
      context.openingHours,
      context.scheduleExceptions,
      context.locationId,
    );
  });

  if (compatibleCandidates.length === 0) {
    const firstDaily = candidates.find((c) => c.dayRangeBoundaries !== null);
    if (firstDaily?.dayRangeBoundaries) {
      validateDayRangeBoundariesAgainstSchedule(
        firstDaily.dayRangeBoundaries,
        context.openingHours,
        context.scheduleExceptions,
        context.locationId,
      );
    }
    return null;
  }

  candidates = compatibleCandidates;

  candidates = candidates.map((c) => calculateAmount(c, context.tiers));
  validateGrid(candidates);
  const best = selectBestCandidate(candidates);

  // Valider les bornes effectives du candidat DAY_RANGE (Chantier 15.2.1).
  if (best.dayRangeBoundaries !== null) {
    validateDayRangeBoundariesAgainstSchedule(
      best.dayRangeBoundaries,
      context.openingHours,
      context.scheduleExceptions,
      context.locationId,
    );
  }

  // Résoudre le libellé public.
  const availableLocales = collectAvailableLocales(context.translations);
  const resolvedLocale = resolveLocale(context.locale, availableLocales);
  const publicLabel = getTranslation(best.plan.id, resolvedLocale, context.translations);
  const marketplaceFeeSnapshot = calculateMarketplaceFeeSnapshotFromPricing({
    subtotalAmountMinor: best.lineTotalAmountMinor,
    mandatoryFeesAmountMinor: 0,
  });

  // Calculer la durée demandée en minutes.
  // Pour DAY_RANGE, la durée en minutes n'a pas de sens métier ; on l'omet.
  const requestedDurationMinutes =
    best.plan.planType === 'DAILY' ? null : best.requestedDurationMinutes;

  let price: PublicPriceSummary;
  switch (best.plan.planType) {
    case 'HOURLY':
      price = {
        currency: 'EUR',
        marketplaceFeeBaseAmountMinor: marketplaceFeeSnapshot.marketplaceFeeBaseAmountMinor,
        customerServiceFeeAmountMinor: marketplaceFeeSnapshot.customerServiceFeeAmountMinor,
        customerTotalAmountMinor: marketplaceFeeSnapshot.customerTotalAmountMinor,
        marketplaceFeeRuleVersion: marketplaceFeeSnapshot.ruleVersion,
        totalAmountMinor: marketplaceFeeSnapshot.customerTotalAmountMinor,
        planType: 'HOURLY',
        publicLabel,
        requestedDurationMinutes,
        billedDurationMinutes: best.billedDurationMinutes,
        billedDays: null,
        discountPercent: null,
      };
      break;
    case 'FIXED_DURATION':
      price = {
        currency: 'EUR',
        marketplaceFeeBaseAmountMinor: marketplaceFeeSnapshot.marketplaceFeeBaseAmountMinor,
        customerServiceFeeAmountMinor: marketplaceFeeSnapshot.customerServiceFeeAmountMinor,
        customerTotalAmountMinor: marketplaceFeeSnapshot.customerTotalAmountMinor,
        marketplaceFeeRuleVersion: marketplaceFeeSnapshot.ruleVersion,
        totalAmountMinor: marketplaceFeeSnapshot.customerTotalAmountMinor,
        planType: 'FIXED_DURATION',
        publicLabel,
        requestedDurationMinutes,
        billedDurationMinutes: null,
        billedDays: null,
        discountPercent: null,
      };
      break;
    case 'DAILY':
      price = {
        currency: 'EUR',
        marketplaceFeeBaseAmountMinor: marketplaceFeeSnapshot.marketplaceFeeBaseAmountMinor,
        customerServiceFeeAmountMinor: marketplaceFeeSnapshot.customerServiceFeeAmountMinor,
        customerTotalAmountMinor: marketplaceFeeSnapshot.customerTotalAmountMinor,
        marketplaceFeeRuleVersion: marketplaceFeeSnapshot.ruleVersion,
        totalAmountMinor: marketplaceFeeSnapshot.customerTotalAmountMinor,
        planType: 'DAILY',
        publicLabel,
        requestedDurationMinutes,
        billedDurationMinutes: null,
        billedDays: best.billedDays,
        discountPercent: best.discountPercent,
      };
      break;
  }
  return { price, best };
}

function collectAvailableLocales(translations: ResolvedTranslation[]): string[] {
  const locales = new Set<string>();
  for (const t of translations) {
    locales.add(t.locale);
  }
  return [...locales];
}

// ─────────────────────────────────────────────────────────────────────────────
// Grouping and selection
// ─────────────────────────────────────────────────────────────────────────────

interface GroupedOffer {
  publicProductId: string;
  publicLocationId: string;
  organizationPublicDisplayName: string;
  productName: string;
  locationName: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  postalCode: string | null;
  countryCode: string;
  latitude: number;
  longitude: number;
  rawDistanceMeters: number;
  geographicMatch: PublicSearchGeographicMatch;
  price: PublicPriceSummary;
}

/**
 * Groupe les offres par (publicProductId, publicLocationId) et sélectionne
 * l'offre au total le moins cher pour chaque groupe.
 *
 * Si plusieurs variantes sont disponibles pour le même couple produit/location,
 * on sélectionne l'offre au total le moins cher.
 *
 * NOTE sur le checkout futur : le checkout pourra résoudre côté serveur l'offre
 * retenue sans faire confiance à un ID interne fourni par le client en
 * re-calculant le prix pour toutes les variantes du produit à la location
 * demandée et en sélectionnant la même offre via les mêmes tie-breakers.
 * Le client fournit uniquement (publicProductId, publicLocationId, intent) ;
 * le serveur re-resoud la variante et le plan. Aucun ID interne de variante
 * ou de plan n'est exposé ni trusté depuis le client.
 */
function groupAndSelectBest(
  pricedOffers: Array<{ candidate: CandidateRow; price: PublicPriceSummary; best: Candidate }>,
  destination: DestinationInfo,
  searchArea: SearchArea,
): GroupedOffer[] {
  const groups = new Map<
    string,
    Array<{ candidate: CandidateRow; price: PublicPriceSummary; best: Candidate }>
  >();

  for (const offer of pricedOffers) {
    const key = `${offer.candidate.publicProductId}:${offer.candidate.publicLocationId}`;
    const arr = groups.get(key) ?? [];
    arr.push(offer);
    groups.set(key, arr);
  }

  const result: GroupedOffer[] = [];

  for (const group of groups.values()) {
    group.sort((a, b) => {
      const cmp = compareCandidates(a.best, b.best);
      if (cmp !== 0) return cmp;
      if (a.candidate.variantId < b.candidate.variantId) return -1;
      if (a.candidate.variantId > b.candidate.variantId) return 1;
      return 0;
    });
    const best = group[0]!;

    result.push({
      publicProductId: best.candidate.publicProductId,
      publicLocationId: best.candidate.publicLocationId,
      organizationPublicDisplayName: best.candidate.organizationPublicDisplayName,
      productName: best.candidate.productName,
      locationName: best.candidate.locationName,
      addressLine1: best.candidate.addressLine1,
      addressLine2: best.candidate.addressLine2,
      city: best.candidate.city,
      postalCode: best.candidate.postalCode,
      countryCode: best.candidate.countryCode,
      latitude: best.candidate.latitude,
      longitude: best.candidate.longitude,
      rawDistanceMeters: best.candidate.rawDistanceMeters,
      geographicMatch: classifyPublicSearchGeographicMatch({
        latitude: best.candidate.latitude,
        longitude: best.candidate.longitude,
        destinationBbox: {
          south: destination.bboxSouth,
          west: destination.bboxWest,
          north: destination.bboxNorth,
          east: destination.bboxEast,
        },
        rawDistanceMeters: best.candidate.rawDistanceMeters,
        areaKind: searchArea.kind,
      }),
      price: best.price,
    });
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyset pagination helpers (no findKeysetIndex, no in-memory slice of results).
// The keyset condition and LIMIT are applied directly in PostgreSQL.
// The only authorized slice is in loadCandidates (groups.slice) which segments
// the SQL lookahead batch, not the final paginated results.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compare deux tuples keyset dans l'ordre (rawDistanceMeters ASC, publicProductId
 * ASC, publicLocationId ASC). Retourne < 0 si a < b, 0 si égal, > 0 si a > b.
 *
 * Utilisé pour déterminer si le dernier élément retourné précède le dernier
 * groupe traité du lot (cas C/D du nextCursor).
 */
function compareKeyset(a: KeysetTuple, b: KeysetTuple): number {
  if (a.rawDistanceMeters !== b.rawDistanceMeters) {
    return a.rawDistanceMeters - b.rawDistanceMeters;
  }
  if (a.publicProductId < b.publicProductId) return -1;
  if (a.publicProductId > b.publicProductId) return 1;
  if (a.publicLocationId < b.publicLocationId) return -1;
  if (a.publicLocationId > b.publicLocationId) return 1;
  return 0;
}
