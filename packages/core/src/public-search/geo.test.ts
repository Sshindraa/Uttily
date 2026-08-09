import { describe, expect, it } from 'vitest';
import {
  isPointInBbox,
  haversineDistanceMeters,
  isValidPublicSearchViewport,
  publicSearchViewportCenter,
  roundDistanceForDisplay,
} from './geo';

describe('viewport public', () => {
  it('valide une bbox normale et une bbox traversant l’antiméridien', () => {
    expect(
      isValidPublicSearchViewport({
        kind: 'VIEWPORT',
        south: -10,
        west: 170,
        north: 10,
        east: -170,
      }),
    ).toBe(true);
    expect(
      isValidPublicSearchViewport({
        kind: 'VIEWPORT',
        south: 10,
        west: 1,
        north: 10,
        east: 2,
      }),
    ).toBe(false);
  });

  it.each([
    [
      'normal',
      { kind: 'VIEWPORT' as const, south: 40, west: 2, north: 50, east: 8 },
      { latitude: 45, longitude: 5 },
    ],
    [
      'antiméridien',
      { kind: 'VIEWPORT' as const, south: -10, west: 170, north: 10, east: -170 },
      { latitude: 0, longitude: 180 },
    ],
  ])('calcule le centre %s de manière déterministe', (_label, viewport, expected) => {
    expect(publicSearchViewportCenter(viewport)).toEqual(expected);
  });
});

describe('isPointInBbox', () => {
  it.each([
    ['point au centre', 45.89, 6.12, 45.88, 6.1, 45.9, 6.14, true],
    ['point au coin sud-ouest', 45.88, 6.1, 45.88, 6.1, 45.9, 6.14, true],
    ['point au coin nord-est', 45.9, 6.14, 45.88, 6.1, 45.9, 6.14, true],
    ['point au nord', 45.91, 6.12, 45.88, 6.1, 45.9, 6.14, false],
    ['point au sud', 45.87, 6.12, 45.88, 6.1, 45.9, 6.14, false],
    ['point à louest', 45.89, 6.09, 45.88, 6.1, 45.9, 6.14, false],
    ['point à lest', 45.89, 6.15, 45.88, 6.1, 45.9, 6.14, false],
    ['antiméridien à lintérieur (est)', 0, -170, -10, 170, 10, -170, true],
    ['antiméridien à lintérieur (ouest)', 0, 170, -10, 170, 10, -170, true],
    ['antiméridien à lintérieur (centre)', 0, 180, -10, 170, 10, -170, true],
    ['antiméridien à lest en dehors', 0, -160, -10, 170, 10, -170, false],
    ['antiméridien à louest en dehors', 0, 160, -10, 170, 10, -170, false],
  ])(
    '%s : (%s, %s) dans [%s..%s, %s..%s] → %s',
    (label, lat, lon, south, west, north, east, expected) => {
      void label;
      expect(
        isPointInBbox(
          lat as number,
          lon as number,
          south as number,
          west as number,
          north as number,
          east as number,
        ),
      ).toBe(expected);
    },
  );
});

describe('haversineDistanceMeters', () => {
  it('calcule une distance nulle pour le même point', () => {
    expect(haversineDistanceMeters(45.89, 6.12, 45.89, 6.12)).toBe(0);
  });

  it('est symétrique', () => {
    const d1 = haversineDistanceMeters(48.8566, 2.3522, 45.764, 4.8357);
    const d2 = haversineDistanceMeters(45.764, 4.8357, 48.8566, 2.3522);
    expect(d1).toBeCloseTo(d2, 2);
  });

  it.each([
    ['Paris → Lyon', 48.8566, 2.3522, 45.764, 4.8357, 392000],
    ['Annecy centre → lac', 45.8992, 6.129, 45.8917, 6.1622, 2700],
    ['Nord → Sud pôle', 0, 0, 0, 180, 20015000],
  ])('approximation raisonnable pour %s', (label, lat1, lon1, lat2, lon2, expected) => {
    void label;
    const d = haversineDistanceMeters(lat1, lon1, lat2, lon2);
    const tolerance = Math.max(expected * 0.01, 100);
    expect(Math.abs(d - expected)).toBeLessThanOrEqual(tolerance);
  });
});

describe('roundDistanceForDisplay', () => {
  it.each([
    [0, 0],
    [0.4, 0],
    [0.5, 1],
    [1234.56, 1235],
    [1234.4, 1234],
    [-123.7, -124],
  ])(`arrondit %s en %s`, (input, expected) => {
    expect(roundDistanceForDisplay(input)).toBe(expected);
  });
});
