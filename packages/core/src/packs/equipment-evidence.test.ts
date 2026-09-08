import { describe, it, expect } from 'vitest';
import {
  hasSufficientEvidence,
  isSafetyCriticalAccessory,
  validateSafetyAttributeCompatibility,
} from './equipment-evidence';
import { isVehicleCompatibleWithAccessory } from './compatibility-graph';

describe('Equipment Evidence & Safety Compatibility (ADR-042)', () => {
  it('respecte la hiérarchie ordonnée des niveaux de preuve', () => {
    expect(hasSufficientEvidence('SOURCE_VERIFIED', 'HUMAN_CONFIRMED')).toBe(true);
    expect(hasSufficientEvidence('HUMAN_CONFIRMED', 'HUMAN_CONFIRMED')).toBe(true);
    expect(hasSufficientEvidence('HUMAN_CONFIRMED', 'SOURCE_VERIFIED')).toBe(false);
    expect(hasSufficientEvidence('AI_OBSERVED', 'HUMAN_CONFIRMED')).toBe(false);
    expect(hasSufficientEvidence(undefined, 'AI_OBSERVED')).toBe(false);
  });

  it('identifie les accessoires safety-critical (remorque et siège enfant)', () => {
    expect(isSafetyCriticalAccessory('CHILD_TRAILER')).toBe(true);
    expect(isSafetyCriticalAccessory('CHILD_SEAT')).toBe(true);
    expect(isSafetyCriticalAccessory('HELMET')).toBe(false);
    expect(isSafetyCriticalAccessory('PADDLE')).toBe(false);
    expect(isSafetyCriticalAccessory('LIFE_JACKET')).toBe(false);
  });

  it('interdit la compatibilité safety-critical sur une simple observation AI_OBSERVED', () => {
    const verdict = validateSafetyAttributeCompatibility({
      accessoryType: 'CHILD_TRAILER',
      attributeKey: 'hasTrailerHitch',
      attributeEvidence: {
        key: 'hasTrailerHitch',
        value: true,
        evidenceLevel: 'AI_OBSERVED',
        inferenceId: 'inf-test-123',
      },
    });

    expect(verdict.isCompatible).toBe(false);
    expect(verdict.reason).toContain('AI_OBSERVED');
    expect(verdict.reason).toContain('HUMAN_CONFIRMED');
    expect(verdict.reason).toContain('CHILD_TRAILER');
  });

  it('autorise la compatibilité safety-critical dès lors que le loueur l’a confirmée (HUMAN_CONFIRMED)', () => {
    const verdict = validateSafetyAttributeCompatibility({
      accessoryType: 'CHILD_TRAILER',
      attributeKey: 'hasTrailerHitch',
      attributeEvidence: {
        key: 'hasTrailerHitch',
        value: true,
        evidenceLevel: 'HUMAN_CONFIRMED',
        confirmedBy: 'org-bike-rental-1',
        confirmedAt: '2026-09-07T12:00:00Z',
      },
    });

    expect(verdict.isCompatible).toBe(true);
    expect(verdict.effectiveEvidenceLevel).toBe('HUMAN_CONFIRMED');
  });

  it('autorise la compatibilité safety-critical sur certification constructeur (SOURCE_VERIFIED)', () => {
    const verdict = validateSafetyAttributeCompatibility({
      accessoryType: 'CHILD_SEAT',
      attributeKey: 'hasChildSeatCompatibleMount',
      isManufacturerCertified: true,
    });

    expect(verdict.isCompatible).toBe(true);
    expect(verdict.effectiveEvidenceLevel).toBe('SOURCE_VERIFIED');
  });

  it('tolère le niveau AI_OBSERVED pour des accessoires non safety-critical', () => {
    const verdict = validateSafetyAttributeCompatibility({
      accessoryType: 'HELMET',
      attributeKey: 'hasLuggageRack',
      attributeEvidence: {
        key: 'hasLuggageRack',
        value: true,
        evidenceLevel: 'AI_OBSERVED',
      },
    });

    expect(verdict.isCompatible).toBe(true);
    expect(verdict.effectiveEvidenceLevel).toBe('AI_OBSERVED');
  });

  it('isVehicleCompatibleWithAccessory rejette un attelage remorque si l’attribut est uniquement AI_OBSERVED', () => {
    const result = isVehicleCompatibleWithAccessory({
      accessoryType: 'CHILD_TRAILER',
      vehicleCategorySlug: 'bike',
      vehicleSubtype: 'electric_trekking',
      vehicleAttributes: {
        hasTrailerHitch: true,
        evidence: {
          hasTrailerHitch: {
            key: 'hasTrailerHitch',
            evidenceLevel: 'AI_OBSERVED',
          },
        },
      },
    });

    expect(result.compatible).toBe(false);
    expect(result.reason).toContain('AI_OBSERVED');
    expect(result.reason).toContain('HUMAN_CONFIRMED');
  });

  it('isVehicleCompatibleWithAccessory accepte un attelage remorque si l’attribut est HUMAN_CONFIRMED', () => {
    const result = isVehicleCompatibleWithAccessory({
      accessoryType: 'CHILD_TRAILER',
      vehicleCategorySlug: 'bike',
      vehicleSubtype: 'electric_trekking',
      vehicleAttributes: {
        hasTrailerHitch: true,
        evidence: {
          hasTrailerHitch: {
            key: 'hasTrailerHitch',
            evidenceLevel: 'HUMAN_CONFIRMED',
          },
        },
      },
    });

    expect(result.compatible).toBe(true);
    expect(result.ruleId).toBe('rule-thule-chariot-v1');
  });
});

