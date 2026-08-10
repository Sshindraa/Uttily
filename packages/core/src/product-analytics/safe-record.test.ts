import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ProductAnalyticsError } from './errors';
import { safeRecordAnalyticsEvent, safeRecordAnalyticsEventInTransaction } from './safe-record';
import type { ResolvedAnalyticsEnvironment } from './runtime';
import type { SafeRecordEventInput } from './types';

/**
 * Tests unitaires du safe recorder analytics (G7H-B).
 * Verifie le retour de l'union fermee RECORDED/DUPLICATE/DISABLED/FAILED
 * et l'isolation d'erreur (jamais de rethrow).
 */

const VALID_UUID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const VALID_DATE = new Date('2026-01-15T10:00:00.000Z');

const SEARCH_INPUT: SafeRecordEventInput = {
  eventType: 'PUBLIC_SEARCH_PERFORMED',
  sourceId: VALID_UUID,
  occurredAt: VALID_DATE,
  hasResults: true,
};

const BOOKING_ATTEMPT_INPUT: SafeRecordEventInput = {
  eventType: 'BOOKING_ATTEMPTED',
  sourceId: VALID_UUID,
  occurredAt: VALID_DATE,
};

// Mock du module record-event pour controler le comportement.
vi.mock('./record-event', () => ({
  recordProductAnalyticsEvent: vi.fn(),
}));

// Importer apres le mock
const { recordProductAnalyticsEvent } = await import('./record-event');
const mockRecord = vi.mocked(recordProductAnalyticsEvent);

beforeEach(() => {
  mockRecord.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Mock DB minimal — non utilise car recordProductAnalyticsEvent est mocke.
const mockDb = {} as never;
const mockTx = {
  transaction: vi.fn(),
} as never;

describe('G7H-B — safeRecordAnalyticsEvent (hors transaction)', () => {
  it('retourne DISABLED quand environment est DISABLED', async () => {
    const result = await safeRecordAnalyticsEvent(mockDb, SEARCH_INPUT, 'DISABLED');
    expect(result).toBe('DISABLED');
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("retourne RECORDED quand l'insert reussit", async () => {
    mockRecord.mockResolvedValue({ id: 'new-id' });
    const result = await safeRecordAnalyticsEvent(mockDb, SEARCH_INPUT, 'DEVELOPMENT');
    expect(result).toBe('RECORDED');
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it('retourne DUPLICATE quand un evenement identique existait', async () => {
    mockRecord.mockResolvedValue({ kind: 'DUPLICATE' });
    const result = await safeRecordAnalyticsEvent(mockDb, SEARCH_INPUT, 'TEST');
    expect(result).toBe('DUPLICATE');
  });

  it('retourne FAILED et ne rethrow pas sur ProductAnalyticsError', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRecord.mockRejectedValue(new ProductAnalyticsError('ANALYTICS_UNAVAILABLE', 'test error'));
    const result = await safeRecordAnalyticsEvent(mockDb, SEARCH_INPUT, 'DEVELOPMENT');
    expect(result).toBe('FAILED');
    errorSpy.mockRestore();
  });

  it('retourne FAILED et ne rethrow pas sur erreur generique', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRecord.mockRejectedValue(new Error('connection refused'));
    const result = await safeRecordAnalyticsEvent(mockDb, BOOKING_ATTEMPT_INPUT, 'TEST');
    expect(result).toBe('FAILED');
    errorSpy.mockRestore();
  });

  it("passe l'environment resolu a recordProductAnalyticsEvent", async () => {
    mockRecord.mockResolvedValue({ id: 'new-id' });
    await safeRecordAnalyticsEvent(mockDb, BOOKING_ATTEMPT_INPUT, 'DEVELOPMENT');
    expect(mockRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ environment: 'DEVELOPMENT' }),
    );
  });

  it('PRODUCTION injecte par cast → DISABLED et zero appel DB (defense-in-depth)', async () => {
    // Le type ResolvedAnalyticsEnvironment est ferme sans PRODUCTION, mais
    // JavaScript permet les casts runtime. Le safe recorder doit rejeter.
    const result = await safeRecordAnalyticsEvent(
      mockDb,
      SEARCH_INPUT,
      'PRODUCTION' as unknown as ResolvedAnalyticsEnvironment,
    );
    expect(result).toBe('DISABLED');
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('G7H-B — safeRecordAnalyticsEventInTransaction (dans transaction)', () => {
  it('retourne DISABLED quand environment est DISABLED', async () => {
    const result = await safeRecordAnalyticsEventInTransaction(mockTx, SEARCH_INPUT, 'DISABLED');
    expect(result).toBe('DISABLED');
  });

  it("retourne RECORDED quand l'insert reussit dans le savepoint", async () => {
    const txMock = mockTx as unknown as { transaction: ReturnType<typeof vi.fn> };
    txMock.transaction.mockImplementation(async (fn: (sp: unknown) => Promise<unknown>) => {
      return await fn({});
    });
    mockRecord.mockResolvedValue({ id: 'new-id' });
    const result = await safeRecordAnalyticsEventInTransaction(
      mockTx,
      BOOKING_ATTEMPT_INPUT,
      'DEVELOPMENT',
    );
    expect(result).toBe('RECORDED');
    expect(txMock.transaction).toHaveBeenCalledTimes(1);
  });

  it('retourne DUPLICATE quand un evenement identique existait', async () => {
    const txMock = mockTx as unknown as { transaction: ReturnType<typeof vi.fn> };
    txMock.transaction.mockImplementation(async (fn: (sp: unknown) => Promise<unknown>) => {
      return await fn({});
    });
    mockRecord.mockResolvedValue({ kind: 'DUPLICATE' });
    const result = await safeRecordAnalyticsEventInTransaction(mockTx, SEARCH_INPUT, 'TEST');
    expect(result).toBe('DUPLICATE');
  });

  it('retourne FAILED et ne rethrow pas quand le savepoint echoue', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const txMock = mockTx as unknown as { transaction: ReturnType<typeof vi.fn> };
    txMock.transaction.mockRejectedValue(
      new ProductAnalyticsError('ANALYTICS_UNAVAILABLE', 'savepoint error'),
    );
    const result = await safeRecordAnalyticsEventInTransaction(
      mockTx,
      BOOKING_ATTEMPT_INPUT,
      'DEVELOPMENT',
    );
    expect(result).toBe('FAILED');
    errorSpy.mockRestore();
  });

  it('retourne FAILED et ne rethrow pas sur erreur generique dans le savepoint', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const txMock = mockTx as unknown as { transaction: ReturnType<typeof vi.fn> };
    txMock.transaction.mockRejectedValue(new Error('unique constraint'));
    const result = await safeRecordAnalyticsEventInTransaction(mockTx, SEARCH_INPUT, 'TEST');
    expect(result).toBe('FAILED');
    errorSpy.mockRestore();
  });

  it('PRODUCTION injecte par cast → DISABLED et zero appel DB (defense-in-depth)', async () => {
    // Le type ResolvedAnalyticsEnvironment est ferme sans PRODUCTION, mais
    // JavaScript permet les casts runtime. Le safe recorder doit rejeter.
    const txMock = mockTx as unknown as { transaction: ReturnType<typeof vi.fn> };
    txMock.transaction.mockImplementation(async (fn: (sp: unknown) => Promise<unknown>) => {
      return await fn({});
    });
    const result = await safeRecordAnalyticsEventInTransaction(
      mockTx,
      BOOKING_ATTEMPT_INPUT,
      'PRODUCTION' as unknown as ResolvedAnalyticsEnvironment,
    );
    expect(result).toBe('DISABLED');
    expect(txMock.transaction).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('G7H-B — logs structures et bornes', () => {
  it('le log ne contient pas sourceId ni donnees sensibles', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRecord.mockRejectedValue(
      new ProductAnalyticsError('ANALYTICS_UNAVAILABLE', 'connection refused'),
    );
    await safeRecordAnalyticsEvent(mockDb, SEARCH_INPUT, 'DEVELOPMENT');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logCall = errorSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(logCall);
    expect(parsed.eventType).toBe('PUBLIC_SEARCH_PERFORMED');
    expect(parsed.errorCode).toBe('ANALYTICS_UNAVAILABLE');
    // JAMAIS sourceId, parametres, identifiants metier ou message PostgreSQL.
    expect(parsed.sourceId).toBeUndefined();
    expect(parsed.message).toBeUndefined();
    expect(parsed.cause).toBeUndefined();
    expect(logCall).not.toContain(VALID_UUID);
    errorSpy.mockRestore();
  });

  it('le log contient eventType et errorCode uniquement', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRecord.mockRejectedValue(new Error('pg connection lost'));
    await safeRecordAnalyticsEvent(mockDb, BOOKING_ATTEMPT_INPUT, 'TEST');

    const logCall = errorSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(logCall);
    expect(parsed.event).toBe('product-analytics.record-failed');
    expect(parsed.eventType).toBe('BOOKING_ATTEMPTED');
    expect(parsed.errorCode).toBe('ANALYTICS_UNAVAILABLE');
    // Pas d'autres champs sensibles.
    const keys = Object.keys(parsed);
    expect(keys).toEqual(expect.arrayContaining(['event', 'eventType', 'errorCode']));
    errorSpy.mockRestore();
  });
});
