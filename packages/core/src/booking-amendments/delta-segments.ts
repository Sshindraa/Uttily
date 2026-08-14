/** Pure half-open interval subtraction for SUPPLEMENT delta holds. */

export interface TimeSegment {
  start: Date;
  end: Date;
}

function compareSegments(a: TimeSegment, b: TimeSegment): number {
  return a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime();
}

export function mergeHalfOpenSegments(segments: readonly TimeSegment[]): TimeSegment[] {
  const ordered = segments
    .filter((segment) => segment.end.getTime() > segment.start.getTime())
    .map((segment) => ({ start: new Date(segment.start), end: new Date(segment.end) }))
    .sort(compareSegments);
  const merged: TimeSegment[] = [];

  for (const segment of ordered) {
    const previous = merged.at(-1);
    if (!previous || segment.start.getTime() > previous.end.getTime()) {
      merged.push(segment);
      continue;
    }
    if (segment.end.getTime() > previous.end.getTime()) previous.end = segment.end;
  }
  return merged;
}

/** Returns `requested - covered`, sorted and without empty segments. */
export function subtractHalfOpenSegments(
  requested: TimeSegment,
  covered: readonly TimeSegment[],
): TimeSegment[] {
  if (requested.end.getTime() <= requested.start.getTime()) return [];
  const merged = mergeHalfOpenSegments(covered);
  const result: TimeSegment[] = [];
  let cursor = requested.start.getTime();
  const end = requested.end.getTime();

  for (const segment of merged) {
    const start = Math.max(segment.start.getTime(), requested.start.getTime());
    const coveredEnd = Math.min(segment.end.getTime(), end);
    if (coveredEnd <= cursor) continue;
    if (start > cursor) {
      result.push({ start: new Date(cursor), end: new Date(Math.min(start, end)) });
    }
    cursor = Math.max(cursor, coveredEnd);
    if (cursor >= end) break;
  }
  if (cursor < end) result.push({ start: new Date(cursor), end: new Date(end) });
  return result.filter((segment) => segment.end.getTime() > segment.start.getTime());
}
