import { describe, it, expect } from 'vitest';
import { computeQuote } from './quote-engine';
import { computePriceForCandidate } from '../public-search/search-offers';
import type {
  PricingContext,
  ResolvedPlan,
  ResolvedWindow,
  ResolvedTranslation,
  OpeningHour,
} from './types';
import type { LocationScheduleExceptionRecord } from '../identity/types';

describe('Search & Checkout decision parity for DAY_RANGE and schedule exceptions (Chantier 15.2.1)', () => {
  const ORG_ID = 'org-parity-1';
  const LOCATION_ID = 'loc-parity-1';
  const VARIANT_ID = 'variant-parity-1';
  const CURRENCY = 'EUR';
  const TIME_ZONE = 'Europe/Paris';

  const WEEKDAY_OPENING_HOURS: OpeningHour[] = [
    { weekday: 0, openTime: '09:00:00', closeTime: '18:00:00' }, // Lundi
    { weekday: 1, openTime: '09:00:00', closeTime: '18:00:00' }, // Mardi
    { weekday: 2, openTime: '09:00:00', closeTime: '18:00:00' }, // Mercredi
    { weekday: 3, openTime: '09:00:00', closeTime: '18:00:00' }, // Jeudi
    { weekday: 4, openTime: '09:00:00', closeTime: '18:00:00' }, // Vendredi
  ];

  const planStandard: ResolvedPlan = {
    id: 'plan-std-daily',
    organizationId: ORG_ID,
    productVariantId: VARIANT_ID,
    locationId: null,
    planType: 'DAILY',
    currency: CURRENCY,
    priceAmountMinor: 4000,
    minDurationMinutes: null,
    maxDurationMinutes: null,
    billingIncrementMinutes: null,
    includedDurationMinutes: null,
    internalLabel: 'Standard 09h-18h',
    priority: 0,
    version: 1,
  };

  const windowStandard: ResolvedWindow = {
    pricingPlanId: 'plan-std-daily',
    weekdayMask: 127,
    startTime: '09:00:00',
    endTime: '18:00:00',
  };

  const translations: ResolvedTranslation[] = [
    { pricingPlanId: 'plan-std-daily', locale: 'fr', publicLabel: 'Tarif Standard' },
    { pricingPlanId: 'plan-special-daily', locale: 'fr', publicLabel: 'Tarif Spécial' },
    { pricingPlanId: 'plan-extended-daily', locale: 'fr', publicLabel: 'Tarif Étendu' },
    { pricingPlanId: 'plan-multi-win-daily', locale: 'fr', publicLabel: 'Tarif Multi-Fenêtres' },
  ];

  function makeContext(
    intent: { startDate: string; endDateExclusive: string },
    plans: ResolvedPlan[] = [planStandard],
    windows: ResolvedWindow[] = [windowStandard],
    scheduleExceptions: LocationScheduleExceptionRecord[] = [],
  ): PricingContext {
    return {
      organizationId: ORG_ID,
      locationId: LOCATION_ID,
      currency: CURRENCY,
      timeZone: TIME_ZONE,
      intent: {
        kind: 'DAY_RANGE',
        startDate: intent.startDate,
        endDateExclusive: intent.endDateExclusive,
      },
      plans,
      windows,
      tiers: [],
      translations,
      openingHours: WEEKDAY_OPENING_HOURS,
      scheduleExceptions,
      variants: new Map([[VARIANT_ID, { productId: 'prod-parity-1', organizationId: ORG_ID }]]),
      lines: [{ variantId: VARIANT_ID, quantity: 1 }],
      locale: 'fr',
    };
  }

  it('1. Cas standard ouvert : Search et Checkout acceptent et calculent le même prix', () => {
    const ctx = makeContext({
      startDate: '2026-08-24', // Lundi
      endDateExclusive: '2026-08-28', // Vendredi (4 jours)
    });

    const quoteResult = computeQuote(ctx);
    const searchResult = computePriceForCandidate(ctx, VARIANT_ID);

    expect(searchResult).not.toBeNull();
    expect(quoteResult.totalAmountMinor).toBe(16000); // 4 * 4000
    expect(searchResult!.price.totalAmountMinor).toBe(quoteResult.totalAmountMinor);
    expect(searchResult!.best.plan.id).toBe(quoteResult.lines[0]!.pricingPlanId);
  });

  it('2. CLOSED premier jour : Search et Checkout rejettent tous les deux', () => {
    const exceptions: LocationScheduleExceptionRecord[] = [
      {
        id: 'ex-close-1',
        organizationId: ORG_ID,
        locationId: LOCATION_ID,
        localDate: '2026-08-24', // Lundi fermé
        kind: 'CLOSED',
        openTime: null,
        closeTime: null,
        reason: 'Fermeture exceptionnelle',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const ctx = makeContext(
      { startDate: '2026-08-24', endDateExclusive: '2026-08-28' },
      [planStandard],
      [windowStandard],
      exceptions,
    );

    // Checkout lève LOCATION_CLOSED
    expect(() => computeQuote(ctx)).toThrow(
      expect.objectContaining({ code: 'LOCATION_CLOSED' }),
    );

    // Search lève FlexiblePricingError('LOCATION_CLOSED') qui est capturé par processCandidateBatch
    expect(() => computePriceForCandidate(ctx, VARIANT_ID)).toThrow(
      expect.objectContaining({ code: 'LOCATION_CLOSED' }),
    );
  });

  it('3. CLOSED dernier jour : Search et Checkout rejettent tous les deux', () => {
    const exceptions: LocationScheduleExceptionRecord[] = [
      {
        id: 'ex-close-last',
        organizationId: ORG_ID,
        locationId: LOCATION_ID,
        localDate: '2026-08-27', // Jeudi (dernier jour)
        kind: 'CLOSED',
        openTime: null,
        closeTime: null,
        reason: 'Fermeture exceptionnelle',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const ctx = makeContext(
      { startDate: '2026-08-24', endDateExclusive: '2026-08-28' },
      [planStandard],
      [windowStandard],
      exceptions,
    );

    expect(() => computeQuote(ctx)).toThrow(
      expect.objectContaining({ code: 'LOCATION_CLOSED' }),
    );
    expect(() => computePriceForCandidate(ctx, VARIANT_ID)).toThrow(
      expect.objectContaining({ code: 'LOCATION_CLOSED' }),
    );
  });

  it('4. OPEN_INTERVAL premier jour incompatible avec startTime : Search et Checkout rejettent', () => {
    const exceptions: LocationScheduleExceptionRecord[] = [
      {
        id: 'ex-interval-1',
        organizationId: ORG_ID,
        locationId: LOCATION_ID,
        localDate: '2026-08-24', // Lundi ouvert seulement 12h-15h
        kind: 'OPEN_INTERVAL',
        openTime: '12:00:00',
        closeTime: '15:00:00',
        reason: 'Horaires réduits',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const ctx = makeContext(
      { startDate: '2026-08-24', endDateExclusive: '2026-08-28' },
      [planStandard], // Plan Standard avec startTime 09:00:00
      [windowStandard],
      exceptions,
    );

    // Checkout rejette avec OUTSIDE_OPENING_HOURS
    expect(() => computeQuote(ctx)).toThrow(
      expect.objectContaining({ code: 'OUTSIDE_OPENING_HOURS' }),
    );

    // Search rejette avec OUTSIDE_OPENING_HOURS
    expect(() => computePriceForCandidate(ctx, VARIANT_ID)).toThrow(
      expect.objectContaining({ code: 'OUTSIDE_OPENING_HOURS' }),
    );
  });

  it('5. OPEN_INTERVAL dernier jour incompatible avec endTime : Search et Checkout rejettent', () => {
    const exceptions: LocationScheduleExceptionRecord[] = [
      {
        id: 'ex-interval-end',
        organizationId: ORG_ID,
        locationId: LOCATION_ID,
        localDate: '2026-08-27', // Jeudi fermé plus tôt (09h-16h)
        kind: 'OPEN_INTERVAL',
        openTime: '09:00:00',
        closeTime: '16:00:00',
        reason: 'Fermeture anticipée',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const ctx = makeContext(
      { startDate: '2026-08-24', endDateExclusive: '2026-08-28' },
      [planStandard], // Plan Standard avec endTime 18:00:00
      [windowStandard],
      exceptions,
    );

    expect(() => computeQuote(ctx)).toThrow(
      expect.objectContaining({ code: 'OUTSIDE_OPENING_HOURS' }),
    );
    expect(() => computePriceForCandidate(ctx, VARIANT_ID)).toThrow(
      expect.objectContaining({ code: 'OUTSIDE_OPENING_HOURS' }),
    );
  });

  it('6. OPEN_INTERVAL compatible (heures étendues) : Search et Checkout réussissent avec le même montant', () => {
    const exceptions: LocationScheduleExceptionRecord[] = [
      {
        id: 'ex-interval-wide',
        organizationId: ORG_ID,
        locationId: LOCATION_ID,
        localDate: '2026-08-24',
        kind: 'OPEN_INTERVAL',
        openTime: '08:00:00',
        closeTime: '20:00:00',
        reason: 'Nocturne',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const ctx = makeContext(
      { startDate: '2026-08-24', endDateExclusive: '2026-08-28' },
      [planStandard],
      [windowStandard],
      exceptions,
    );

    const quoteResult = computeQuote(ctx);
    const searchResult = computePriceForCandidate(ctx, VARIANT_ID);

    expect(searchResult).not.toBeNull();
    expect(quoteResult.totalAmountMinor).toBe(16000);
    expect(searchResult!.price.totalAmountMinor).toBe(quoteResult.totalAmountMinor);
  });

  it('7. Jour intermédiaire CLOSED : Search et Checkout acceptent tous les deux', () => {
    const exceptions: LocationScheduleExceptionRecord[] = [
      {
        id: 'ex-mid-closed',
        organizationId: ORG_ID,
        locationId: LOCATION_ID,
        localDate: '2026-08-25', // Mardi fermé
        kind: 'CLOSED',
        openTime: null,
        closeTime: null,
        reason: 'Fermeture exceptionnelle',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const ctx = makeContext(
      { startDate: '2026-08-24', endDateExclusive: '2026-08-28' },
      [planStandard],
      [windowStandard],
      exceptions,
    );

    const quoteResult = computeQuote(ctx);
    const searchResult = computePriceForCandidate(ctx, VARIANT_ID);

    expect(searchResult).not.toBeNull();
    expect(quoteResult.totalAmountMinor).toBe(16000);
    expect(searchResult!.price.totalAmountMinor).toBe(quoteResult.totalAmountMinor);
  });

  it('8. Multiples candidats : le candidat compatible est sélectionné sans rejet arbitraire (Requirement 10)', () => {
    // Plan 1 : Standard 09h-18h pour 30€ (incompatible avec l'exception 12h-15h)
    const plan1: ResolvedPlan = {
      ...planStandard,
      id: 'plan-std-daily',
      priceAmountMinor: 3000,
    };
    const window1: ResolvedWindow = {
      pricingPlanId: 'plan-std-daily',
      weekdayMask: 127,
      startTime: '09:00:00',
      endTime: '18:00:00',
    };

    // Plan 2 : Spécial 12h-15h pour 50€ (compatible avec l'exception 12h-15h)
    const plan2: ResolvedPlan = {
      id: 'plan-special-daily',
      organizationId: ORG_ID,
      productVariantId: VARIANT_ID,
      locationId: null,
      planType: 'DAILY',
      currency: CURRENCY,
      priceAmountMinor: 5000,
      minDurationMinutes: null,
      maxDurationMinutes: null,
      billingIncrementMinutes: null,
      includedDurationMinutes: null,
      internalLabel: 'Spécial 12h-15h',
      priority: 0,
      version: 1,
    };
    const window2: ResolvedWindow = {
      pricingPlanId: 'plan-special-daily',
      weekdayMask: 127,
      startTime: '12:00:00',
      endTime: '15:00:00',
    };

    const exceptions: LocationScheduleExceptionRecord[] = [
      {
        id: 'ex-interval-afternoon',
        organizationId: ORG_ID,
        locationId: LOCATION_ID,
        localDate: '2026-08-24', // Lundi ouvert seulement 12h-15h
        kind: 'OPEN_INTERVAL',
        openTime: '12:00:00',
        closeTime: '15:00:00',
        reason: 'Après-midi seulement',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const ctx = makeContext(
      { startDate: '2026-08-24', endDateExclusive: '2026-08-25' }, // 1 jour
      [plan1, plan2],
      [window1, window2],
      exceptions,
    );

    // Checkout sélectionne Plan 2 (compatible) sans rejeter à cause de Plan 1
    const quoteResult = computeQuote(ctx);
    expect(quoteResult.lines[0]!.pricingPlanId).toBe('plan-special-daily');
    expect(quoteResult.totalAmountMinor).toBe(5000);

    // Search fait exactement le même choix
    const searchResult = computePriceForCandidate(ctx, VARIANT_ID);
    expect(searchResult).not.toBeNull();
    expect(searchResult!.best.plan.id).toBe('plan-special-daily');
    expect(searchResult!.price.totalAmountMinor).toBe(5000);
  });

  it('9. Régression : horaires hebdo 09:00–18:00 + OPEN_INTERVAL 08:00–20:00 + fenêtre DAILY 08:00–20:00 => succès Search & Checkout', () => {
    const planExtended: ResolvedPlan = {
      ...planStandard,
      id: 'plan-extended-daily',
      internalLabel: 'Daily 08h-20h',
    };
    const windowExtended: ResolvedWindow = {
      pricingPlanId: 'plan-extended-daily',
      weekdayMask: 127,
      startTime: '08:00:00',
      endTime: '20:00:00',
    };

    const exceptions: LocationScheduleExceptionRecord[] = [
      {
        id: 'ex-interval-extended',
        organizationId: ORG_ID,
        locationId: LOCATION_ID,
        localDate: '2026-08-24', // Lundi exception 08h-20h
        kind: 'OPEN_INTERVAL',
        openTime: '08:00:00',
        closeTime: '20:00:00',
        reason: 'Journée prolongée',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const ctx = makeContext(
      { startDate: '2026-08-24', endDateExclusive: '2026-08-25' }, // 1 jour
      [planExtended],
      [windowExtended],
      exceptions,
    );

    // Checkout doit réussir et sélectionner la fenêtre 08:00-20:00
    const quoteResult = computeQuote(ctx);
    expect(quoteResult.totalAmountMinor).toBe(4000);
    expect(quoteResult.lines[0]!.pricingPlanId).toBe('plan-extended-daily');
    expect(quoteResult.lines[0]!.windowSnapshot).toEqual({
      kind: 'DAY_RANGE_BOUNDARIES',
      firstDay: {
        localDate: '2026-08-24',
        weekdayMask: 127,
        startTime: '08:00:00',
        endTime: '20:00:00',
      },
      lastDay: {
        localDate: '2026-08-24',
        weekdayMask: 127,
        startTime: '08:00:00',
        endTime: '20:00:00',
      },
    });

    // Search doit également trouver et pricer l'offre
    const searchResult = computePriceForCandidate(ctx, VARIANT_ID);
    expect(searchResult).not.toBeNull();
    expect(searchResult!.price.totalAmountMinor).toBe(4000);
    expect(searchResult!.best.plan.id).toBe('plan-extended-daily');
  });

  it('10. Régression : même plan DAILY avec une grande fenêtre incompatible et une plus petite fenêtre compatible avec l’OPEN_INTERVAL => la fenêtre compatible est retenue', () => {
    const planMultiWindows: ResolvedPlan = {
      ...planStandard,
      id: 'plan-multi-win-daily',
      internalLabel: 'Daily multi-fenêtres',
    };

    // Le même plan a DEUX fenêtres pour le lundi :
    // 1. Grande fenêtre 08:00–20:00 (incompatible avec l'OPEN_INTERVAL 12:00–15:00)
    const windowLarge: ResolvedWindow = {
      pricingPlanId: 'plan-multi-win-daily',
      weekdayMask: 127,
      startTime: '08:00:00',
      endTime: '20:00:00',
    };
    // 2. Petite fenêtre 12:00–15:00 (compatible avec l'OPEN_INTERVAL 12:00–15:00)
    const windowSmall: ResolvedWindow = {
      pricingPlanId: 'plan-multi-win-daily',
      weekdayMask: 127,
      startTime: '12:00:00',
      endTime: '15:00:00',
    };

    const exceptions: LocationScheduleExceptionRecord[] = [
      {
        id: 'ex-interval-afternoon-only',
        organizationId: ORG_ID,
        locationId: LOCATION_ID,
        localDate: '2026-08-24', // Lundi 12h-15h seulement
        kind: 'OPEN_INTERVAL',
        openTime: '12:00:00',
        closeTime: '15:00:00',
        reason: 'Ouverture partielle après-midi',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const ctx = makeContext(
      { startDate: '2026-08-24', endDateExclusive: '2026-08-25' }, // 1 jour
      [planMultiWindows],
      [windowLarge, windowSmall],
      exceptions,
    );

    // findDayRangeWindow doit retenir la fenêtre compatible windowSmall (12:00-15:00), sans éliminer le plan
    const quoteResult = computeQuote(ctx);
    expect(quoteResult.totalAmountMinor).toBe(4000);
    expect(quoteResult.lines[0]!.pricingPlanId).toBe('plan-multi-win-daily');
    expect(quoteResult.lines[0]!.windowSnapshot).toEqual({
      kind: 'DAY_RANGE_BOUNDARIES',
      firstDay: {
        localDate: '2026-08-24',
        weekdayMask: 127,
        startTime: '12:00:00',
        endTime: '15:00:00',
      },
      lastDay: {
        localDate: '2026-08-24',
        weekdayMask: 127,
        startTime: '12:00:00',
        endTime: '15:00:00',
      },
    });

    // Search fait exactement la même sélection
    const searchResult = computePriceForCandidate(ctx, VARIANT_ID);
    expect(searchResult).not.toBeNull();
    expect(searchResult!.price.totalAmountMinor).toBe(4000);
    expect(searchResult!.best.plan.id).toBe('plan-multi-win-daily');
  });
});
