import { describe, it, expect } from 'vitest';
import {
  computePrivacyResponseDeadline,
  computePrivacyExtensionDeadline,
} from './privacy-deadline';

describe('computePrivacyResponseDeadline', () => {
  it('ajoute un mois calendaire à une date classique', () => {
    const received = new Date('2026-03-15T10:00:00.000Z');
    const deadline = computePrivacyResponseDeadline(received);
    expect(deadline.toISOString()).toBe('2026-04-15T10:00:00.000Z');
  });

  it('clampe 31 janvier au 28 février (année non bissextile)', () => {
    const received = new Date('2027-01-31T14:30:00.000Z');
    const deadline = computePrivacyResponseDeadline(received);
    expect(deadline.toISOString()).toBe('2027-02-28T14:30:00.000Z');
  });

  it('clampe 31 janvier au 29 février (année bissextile)', () => {
    const received = new Date('2028-01-31T08:00:00.000Z');
    const deadline = computePrivacyResponseDeadline(received);
    expect(deadline.toISOString()).toBe('2028-02-29T08:00:00.000Z');
  });

  it('clampe 29 février au 29 mars', () => {
    const received = new Date('2028-02-29T12:00:00.000Z');
    const deadline = computePrivacyResponseDeadline(received);
    expect(deadline.toISOString()).toBe('2028-03-29T12:00:00.000Z');
  });

  it('clampe 31 mars au 30 avril', () => {
    const received = new Date('2026-03-31T09:00:00.000Z');
    const deadline = computePrivacyResponseDeadline(received);
    expect(deadline.toISOString()).toBe('2026-04-30T09:00:00.000Z');
  });

  it('clampe 31 mai au 30 juin', () => {
    const received = new Date('2026-05-31T16:00:00.000Z');
    const deadline = computePrivacyResponseDeadline(received);
    expect(deadline.toISOString()).toBe('2026-06-30T16:00:00.000Z');
  });

  it('gère le passage décembre → janvier (changement année)', () => {
    const received = new Date('2026-12-15T20:00:00.000Z');
    const deadline = computePrivacyResponseDeadline(received);
    expect(deadline.toISOString()).toBe('2027-01-15T20:00:00.000Z');
  });

  it('clampe 31 décembre au 31 janvier', () => {
    const received = new Date('2026-12-31T23:59:59.999Z');
    const deadline = computePrivacyResponseDeadline(received);
    expect(deadline.toISOString()).toBe('2027-01-31T23:59:59.999Z');
  });

  it('gère le 28 février → 28 mars (pas de clamp nécessaire)', () => {
    const received = new Date('2026-02-28T10:00:00.000Z');
    const deadline = computePrivacyResponseDeadline(received);
    expect(deadline.toISOString()).toBe('2026-03-28T10:00:00.000Z');
  });

  it("ne mute pas la date d'entrée", () => {
    const received = new Date('2026-06-15T10:00:00.000Z');
    const original = received.toISOString();
    computePrivacyResponseDeadline(received);
    expect(received.toISOString()).toBe(original);
  });
});

describe('computePrivacyExtensionDeadline', () => {
  it('ajoute deux mois calendaires', () => {
    const due = new Date('2026-04-15T10:00:00.000Z');
    const ext = computePrivacyExtensionDeadline(due);
    expect(ext.toISOString()).toBe('2026-06-15T10:00:00.000Z');
  });

  it('clampe correctement en passant par des mois courts', () => {
    // 31 janvier + 1 mois = 28 février, puis +2 mois = 28 avril
    const due = new Date('2027-02-28T14:30:00.000Z');
    const ext = computePrivacyExtensionDeadline(due);
    expect(ext.toISOString()).toBe('2027-04-28T14:30:00.000Z');
  });

  it('clampe 31 mars + 2 mois au 31 mai', () => {
    const due = new Date('2026-03-31T09:00:00.000Z');
    const ext = computePrivacyExtensionDeadline(due);
    expect(ext.toISOString()).toBe('2026-05-31T09:00:00.000Z');
  });

  it("gère le changement d'année", () => {
    const due = new Date('2026-11-30T10:00:00.000Z');
    const ext = computePrivacyExtensionDeadline(due);
    expect(ext.toISOString()).toBe('2027-01-30T10:00:00.000Z');
  });

  it("ne mute pas la date d'entrée", () => {
    const due = new Date('2026-06-15T10:00:00.000Z');
    const original = due.toISOString();
    computePrivacyExtensionDeadline(due);
    expect(due.toISOString()).toBe(original);
  });
});
