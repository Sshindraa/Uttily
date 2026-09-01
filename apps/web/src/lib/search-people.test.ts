import { describe, expect, it } from 'vitest';
import { parseSearchPeople } from './search-people';
import { parsePublicSearchParams } from './public-search';

describe('people as non-contractual search context', () => {
  it('is optional and supports positive bounded integers', () => {
    expect(parseSearchPeople(new URLSearchParams())).toBeUndefined();
    expect(parseSearchPeople(new URLSearchParams('peopleCount=4'))).toBe(4);
    expect(parseSearchPeople(new URLSearchParams('peopleCount=99'))).toBe(99);
  });
  it.each(['', '0', '-1', '1.5', '100', '04', '1e1', 'Infinity'])(
    'rejects malformed count %s',
    (value) => {
      expect(parseSearchPeople(new URLSearchParams({ peopleCount: value }))).toBeNull();
    },
  );
  it('rejects duplicate counts in the server parser rather than silently choosing one', () => {
    const params = new URLSearchParams('peopleCount=2&peopleCount=4');
    expect(parseSearchPeople(params)).toBeNull();
    const parsed = parsePublicSearchParams(params, 'fr');
    expect(parsed.kind).toBe('INVALID');
    if (parsed.kind === 'INVALID') expect(parsed.fieldErrors.peopleCount).toBeTruthy();
  });
});
