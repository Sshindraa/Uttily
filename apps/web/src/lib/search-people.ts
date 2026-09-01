/** Presentation context only: never convert this value into inventory quantity. */
export const MAX_SEARCH_PEOPLE = 99;

export function parseSearchPeople(params: URLSearchParams): number | null | undefined {
  const values = params.getAll('peopleCount');
  if (values.length === 0) return undefined;
  if (values.length !== 1 || !/^[1-9]\d?$/.test(values[0] ?? '')) return null;
  const count = Number(values[0]);
  return count <= MAX_SEARCH_PEOPLE ? count : null;
}
