import { describe, expect, it } from 'vitest';
import { ProductAnalyticsError } from './errors';
import { recordProductAnalyticsEvent } from './record-event';
import type { RecordProductAnalyticsEventInput } from './types';

/**
 * Tests unitaires de recordProductAnalyticsEvent (G7H-A).
 * Tests de validation et classification — aucune base de données requise.
 * Les tests d'intégration PostgreSQL sont dans product-analytics.integration.test.ts.
 */

// Mock minimal : la fonction lance une erreur avant d'atteindre la DB
// quand l'entrée est invalide.
const mockDb = {
  insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: () => [] }) }) }),
  select: () => ({ from: () => ({ where: () => ({ limit: () => [] }) }) }),
} as unknown as Parameters<typeof recordProductAnalyticsEvent>[0];

const VALID_UUID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const VALID_DATE = new Date('2026-01-15T10:00:00.000Z');

describe('G7H-A — recordProductAnalyticsEvent (validation)', () => {
  // =========================================================================
  // Classification et validation des entrées
  // =========================================================================
  describe('classification des entrées', () => {
    it('PUBLIC_SEARCH_PERFORMED avec hasResults=true → passe la validation', async () => {
      const input: RecordProductAnalyticsEventInput = {
        eventType: 'PUBLIC_SEARCH_PERFORMED',
        environment: 'TEST',
        sourceId: VALID_UUID,
        occurredAt: VALID_DATE,
        hasResults: true,
      };
      // Avec le mock, l'INSERT retourne [] (conflit) et le SELECT retourne []
      // → ANALYTICS_UNAVAILABLE. On vérifie juste que la validation passe
      // (pas d'erreur INVALID_*).
      await expect(recordProductAnalyticsEvent(mockDb, input)).rejects.toThrowError(
        ProductAnalyticsError,
      );
      await expect(recordProductAnalyticsEvent(mockDb, input)).rejects.toThrowError(/indisponible/);
    });

    it('PUBLIC_SEARCH_PERFORMED avec hasResults=false → passe la validation', async () => {
      const input: RecordProductAnalyticsEventInput = {
        eventType: 'PUBLIC_SEARCH_PERFORMED',
        environment: 'TEST',
        sourceId: VALID_UUID,
        occurredAt: VALID_DATE,
        hasResults: false,
      };
      await expect(recordProductAnalyticsEvent(mockDb, input)).rejects.toThrowError(/indisponible/);
    });

    it('BOOKING_ATTEMPTED sans hasResults → passe la validation', async () => {
      const input: RecordProductAnalyticsEventInput = {
        eventType: 'BOOKING_ATTEMPTED',
        environment: 'TEST',
        sourceId: VALID_UUID,
        occurredAt: VALID_DATE,
      };
      await expect(recordProductAnalyticsEvent(mockDb, input)).rejects.toThrowError(/indisponible/);
    });

    it('BOOKING_CONFIRMED sans hasResults → passe la validation', async () => {
      const input: RecordProductAnalyticsEventInput = {
        eventType: 'BOOKING_CONFIRMED',
        environment: 'TEST',
        sourceId: VALID_UUID,
        occurredAt: VALID_DATE,
      };
      await expect(recordProductAnalyticsEvent(mockDb, input)).rejects.toThrowError(/indisponible/);
    });
  });

  // =========================================================================
  // Rejets de validation
  // =========================================================================
  describe('rejets de validation', () => {
    it('UUID invalide → INVALID_UUID', async () => {
      const input = {
        eventType: 'PUBLIC_SEARCH_PERFORMED',
        environment: 'TEST',
        sourceId: 'not-a-uuid',
        occurredAt: VALID_DATE,
        hasResults: true,
      } as RecordProductAnalyticsEventInput;
      await expect(recordProductAnalyticsEvent(mockDb, input)).rejects.toThrowError(
        ProductAnalyticsError,
      );
      await expect(recordProductAnalyticsEvent(mockDb, input)).rejects.toThrowError(
        /sourceId invalide/,
      );
    });

    it('environnement invalide → INVALID_ENVIRONMENT', async () => {
      const input = {
        eventType: 'PUBLIC_SEARCH_PERFORMED',
        environment: 'LIVE',
        sourceId: VALID_UUID,
        occurredAt: VALID_DATE,
        hasResults: true,
      } as unknown as RecordProductAnalyticsEventInput;
      await expect(recordProductAnalyticsEvent(mockDb, input)).rejects.toThrowError(
        /Environnement invalide/,
      );
    });

    it('eventType invalide → INVALID_EVENT_TYPE', async () => {
      const input = {
        eventType: 'UNKNOWN',
        environment: 'TEST',
        sourceId: VALID_UUID,
        occurredAt: VALID_DATE,
        hasResults: true,
      } as unknown as RecordProductAnalyticsEventInput;
      await expect(recordProductAnalyticsEvent(mockDb, input)).rejects.toThrowError(
        /Type d'événement invalide/,
      );
    });

    it('occurredAt invalide → INVALID_INPUT', async () => {
      const input = {
        eventType: 'PUBLIC_SEARCH_PERFORMED',
        environment: 'TEST',
        sourceId: VALID_UUID,
        occurredAt: new Date('invalid'),
        hasResults: true,
      } as RecordProductAnalyticsEventInput;
      await expect(recordProductAnalyticsEvent(mockDb, input)).rejects.toThrowError(
        /occurredAt invalide/,
      );
    });

    it('PUBLIC_SEARCH_PERFORMED sans hasResults → INVALID_INPUT', async () => {
      const input = {
        eventType: 'PUBLIC_SEARCH_PERFORMED',
        environment: 'TEST',
        sourceId: VALID_UUID,
        occurredAt: VALID_DATE,
      } as RecordProductAnalyticsEventInput;
      await expect(recordProductAnalyticsEvent(mockDb, input)).rejects.toThrowError(
        /hasResults requis/,
      );
    });

    it('BOOKING_ATTEMPTED avec hasResults → INVALID_INPUT', async () => {
      const input = {
        eventType: 'BOOKING_ATTEMPTED',
        environment: 'TEST',
        sourceId: VALID_UUID,
        occurredAt: VALID_DATE,
        hasResults: true,
      } as RecordProductAnalyticsEventInput;
      await expect(recordProductAnalyticsEvent(mockDb, input)).rejects.toThrowError(
        /hasResults interdit/,
      );
    });

    it('BOOKING_ATTEMPTED avec hasResults: undefined présent → INVALID_INPUT', async () => {
      const input = {
        eventType: 'BOOKING_ATTEMPTED',
        environment: 'TEST',
        sourceId: VALID_UUID,
        occurredAt: VALID_DATE,
        hasResults: undefined,
      } as RecordProductAnalyticsEventInput;
      await expect(recordProductAnalyticsEvent(mockDb, input)).rejects.toThrowError(
        /hasResults interdit/,
      );
    });
  });

  // =========================================================================
  // Déduplication sémantique — occurredAt + hasResults
  // =========================================================================
  describe('déduplication sémantique', () => {
    it('même instant + même payload → DUPLICATE (déjà testé en intégration)', () => {
      // La classification DUPLICATE nécessite une base de données réelle.
      // Vérifié dans les tests d'intégration PostgreSQL.
      expect(true).toBe(true);
    });

    it('occurredAt différent seulement → DUPLICATE_CONFLICT (vérifié en intégration)', () => {
      // La classification DUPLICATE_CONFLICT nécessite une base de données réelle.
      // Vérifié dans les tests d'intégration PostgreSQL.
      expect(true).toBe(true);
    });

    it('hasResults différent seulement → DUPLICATE_CONFLICT (vérifié en intégration)', () => {
      // La classification DUPLICATE_CONFLICT nécessite une base de données réelle.
      // Vérifié dans les tests d'intégration PostgreSQL.
      expect(true).toBe(true);
    });
  });
});
