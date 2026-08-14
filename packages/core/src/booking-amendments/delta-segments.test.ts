import { describe, expect, it } from 'vitest';
import { mergeHalfOpenSegments, subtractHalfOpenSegments } from './delta-segments';

const d = (value: string) => new Date(`2026-03-10T${value}:00.000Z`);
const tuple = (segments: readonly { start: Date; end: Date }[]) =>
  segments.map((segment) => [segment.start.toISOString(), segment.end.toISOString()]);

describe('SUPPLEMENT delta segments', () => {
  it('soustrait des intervalles half-open adjacents sans créer de vide', () => {
    expect(
      tuple(
        subtractHalfOpenSegments({ start: d('09:00'), end: d('17:00') }, [
          { start: d('09:00'), end: d('12:00') },
        ]),
      ),
    ).toEqual([[d('12:00').toISOString(), d('17:00').toISOString()]]);
  });

  it('fusionne les couvertures chevauchantes et adjacentes', () => {
    const merged = mergeHalfOpenSegments([
      { start: d('12:00'), end: d('14:00') },
      { start: d('09:00'), end: d('12:00') },
      { start: d('13:00'), end: d('16:00') },
    ]);
    expect(tuple(merged)).toEqual([[d('09:00').toISOString(), d('16:00').toISOString()]]);
  });

  it('retourne plusieurs segments déterministes', () => {
    expect(
      tuple(
        subtractHalfOpenSegments({ start: d('09:00'), end: d('18:00') }, [
          { start: d('10:00'), end: d('11:00') },
          { start: d('14:00'), end: d('16:00') },
        ]),
      ),
    ).toEqual([
      [d('09:00').toISOString(), d('10:00').toISOString()],
      [d('11:00').toISOString(), d('14:00').toISOString()],
      [d('16:00').toISOString(), d('18:00').toISOString()],
    ]);
  });

  it('ne produit aucun segment quand la couverture est complète', () => {
    expect(
      subtractHalfOpenSegments({ start: d('09:00'), end: d('17:00') }, [
        { start: d('08:00'), end: d('18:00') },
      ]),
    ).toEqual([]);
  });
});
