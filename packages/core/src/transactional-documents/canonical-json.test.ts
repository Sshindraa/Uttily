import { describe, it, expect } from 'vitest';
import { canonicalJsonString, canonicalJsonBytes, CanonicalJsonError } from './canonical-json';

describe('canonicalJsonString', () => {
  it('canonise des objets imbriques avec cles triees recursivement', () => {
    const input = {
      c: { z: 1, a: 2 },
      a: 3,
      b: [1, 2],
    };
    // Ordre attendu : a, b, c ; dans c : a, z
    expect(canonicalJsonString(input)).toBe('{"a":3,"b":[1,2],"c":{"a":2,"z":1}}');
  });

  it('trie les cles par ordre lexicographique UTF-16', () => {
    const input = { b: 1, a: 2, C: 3, B: 4, c: 5, A: 6 };
    // Majuscules avant minuscules en UTF-16 (A=65, B=66, C=67, a=97, b=98, c=99)
    expect(canonicalJsonString(input)).toBe('{"A":6,"B":4,"C":3,"a":2,"b":1,"c":5}');
  });

  it('preserve l ordre des tableaux (pas de re-tri)', () => {
    const input = { arr: [3, 1, 2] };
    expect(canonicalJsonString(input)).toBe('{"arr":[3,1,2]}');
  });

  it('canonise null et boolean', () => {
    expect(canonicalJsonString(null)).toBe('null');
    expect(canonicalJsonString(true)).toBe('true');
    expect(canonicalJsonString(false)).toBe('false');
  });

  it('canonise des nombres via String(n)', () => {
    expect(canonicalJsonString(42)).toBe('42');
    expect(canonicalJsonString(0)).toBe('0');
    expect(canonicalJsonString(-1)).toBe('-1');
    expect(canonicalJsonString(3.14)).toBe('3.14');
  });

  it('canonise des strings avec echappement JSON standard', () => {
    expect(canonicalJsonString('hello')).toBe('"hello"');
    expect(canonicalJsonString('a"b')).toBe('"a\\"b"');
    expect(canonicalJsonString('a\\b')).toBe('"a\\\\b"');
  });

  it('canonise des caracteres Unicode et hostiles (emoji, multi-bytes)', () => {
    expect(canonicalJsonString('\u00e9')).toBe('"\u00e9"');
    expect(canonicalJsonString('\u{1F600}')).toBe('"\u{1F600}"');
    expect(canonicalJsonString('\u0000')).toBe('"\\u0000"');
  });

  it('rejette undefined', () => {
    expect(() => canonicalJsonString(undefined)).toThrow(CanonicalJsonError);
  });

  it('rejette bigint', () => {
    expect(() => canonicalJsonString(42n)).toThrow(CanonicalJsonError);
  });

  it('rejette NaN', () => {
    expect(() => canonicalJsonString(NaN)).toThrow(CanonicalJsonError);
  });

  it('rejette Infinity', () => {
    expect(() => canonicalJsonString(Infinity)).toThrow(CanonicalJsonError);
  });

  it('rejette -Infinity', () => {
    expect(() => canonicalJsonString(-Infinity)).toThrow(CanonicalJsonError);
  });

  it('rejette Date', () => {
    expect(() => canonicalJsonString(new Date('2026-01-01T00:00:00Z'))).toThrow(CanonicalJsonError);
  });

  it('rejette fonction', () => {
    expect(() => canonicalJsonString(() => 42)).toThrow(CanonicalJsonError);
  });

  it('rejette symbol', () => {
    expect(() => canonicalJsonString(Symbol('test'))).toThrow(CanonicalJsonError);
  });

  it('rejette les references circulaires (objet)', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj['self'] = obj;
    expect(() => canonicalJsonString(obj)).toThrow(CanonicalJsonError);
  });

  it('rejette les references circulaires (tableau)', () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(() => canonicalJsonString(arr)).toThrow(CanonicalJsonError);
  });

  it('accepte les references non-circulaires (meme objet reference une fois)', () => {
    const shared = { x: 1 };
    const input = { a: shared, b: shared };
    // Pas de cycle : shared est reference deux fois mais ne se reference pas lui-meme
    expect(canonicalJsonString(input)).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it('produit une sortie deterministe (meme input -> meme output)', () => {
    const input = { b: [2, 1], a: { y: 'test', x: true } };
    const s1 = canonicalJsonString(input);
    const s2 = canonicalJsonString(input);
    expect(s1).toBe(s2);
  });

  it('objet vide -> {}', () => {
    expect(canonicalJsonString({})).toBe('{}');
  });

  it('tableau vide -> []', () => {
    expect(canonicalJsonString([])).toBe('[]');
  });

  it('rejette Map', () => {
    expect(() => canonicalJsonString(new Map([['a', 1]]))).toThrow(CanonicalJsonError);
    // Vérifier qu'on ne produit jamais "{}"
    try {
      canonicalJsonString(new Map([['a', 1]]));
      expect.fail('devrait lever');
    } catch (e) {
      expect(e).toBeInstanceOf(CanonicalJsonError);
    }
  });

  it('rejette Set', () => {
    expect(() => canonicalJsonString(new Set([1, 2]))).toThrow(CanonicalJsonError);
  });

  it('rejette une instance de classe', () => {
    class Foo {
      constructor(public x: number) {}
    }
    expect(() => canonicalJsonString(new Foo(42))).toThrow(CanonicalJsonError);
  });

  it('rejette un objet avec prototype personnalisé', () => {
    const proto = { custom: true };
    const obj = Object.create(proto);
    obj['a'] = 1;
    expect(() => canonicalJsonString(obj)).toThrow(CanonicalJsonError);
  });

  it('accepte un objet créé avec Object.create(null)', () => {
    const obj = Object.create(null);
    obj['a'] = 1;
    obj['b'] = 2;
    // Les clés doivent être triées
    expect(canonicalJsonString(obj)).toBe('{"a":1,"b":2}');
  });

  it('Map ne produit jamais "{}" silencieusement', () => {
    try {
      const result = canonicalJsonString(new Map([['a', 1]]));
      expect(result).not.toBe('{}');
      expect.fail('Map aurait dû être refusée');
    } catch (e) {
      expect(e).toBeInstanceOf(CanonicalJsonError);
    }
  });
});

describe('canonicalJsonBytes', () => {
  it('produit des bytes UTF-8 deterministes', () => {
    const input = { a: 'hello' };
    const bytes = canonicalJsonBytes(input);
    expect(bytes).toBeInstanceOf(Uint8Array);
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded).toBe('{"a":"hello"}');
  });

  it('encode correctement les caracteres multi-bytes UTF-8', () => {
    const input = { emoji: '\u{1F600}' };
    const bytes = canonicalJsonBytes(input);
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded).toBe('{"emoji":"\u{1F600}"}');
  });

  it('meme input -> meme bytes', () => {
    const input = { b: 2, a: 1 };
    const b1 = canonicalJsonBytes(input);
    const b2 = canonicalJsonBytes(input);
    expect(b1.length).toBe(b2.length);
    expect(Array.from(b1)).toEqual(Array.from(b2));
  });

  it('rejette Map (via canonicalJsonString)', () => {
    expect(() => canonicalJsonBytes(new Map([['a', 1]]))).toThrow(CanonicalJsonError);
  });
});
