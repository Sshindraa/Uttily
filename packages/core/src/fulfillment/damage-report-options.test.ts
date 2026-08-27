import { describe, it, expect } from 'vitest';
import { computeDamageReportFingerprint } from './report-fingerprints';

describe('Chantier 8D — Damage report options & fingerprints', () => {
  const baseInput = {
    organizationId: '00000000-0000-0000-0000-000000000001',
    bookingId: '00000000-0000-0000-0000-000000000002',
    bookingItemId: '00000000-0000-0000-0000-000000000003',
    actorUserId: '00000000-0000-0000-0000-000000000004',
    description: 'Rayure profonde sur le cadre côté droit',
  };

  it('génère une empreinte stable sans blocksInventory', () => {
    const fp1 = computeDamageReportFingerprint(baseInput);
    const fp2 = computeDamageReportFingerprint({ ...baseInput, blocksInventory: false });
    expect(fp1).toBe(fp2);
    expect(typeof fp1).toBe('string');
    expect(fp1).toHaveLength(64);
  });

  it('génère une empreinte distincte quand blocksInventory est activé', () => {
    const fpWithout = computeDamageReportFingerprint(baseInput);
    const fpWith = computeDamageReportFingerprint({ ...baseInput, blocksInventory: true });
    expect(fpWith).not.toBe(fpWithout);
  });
});
